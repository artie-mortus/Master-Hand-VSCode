// Master Hand for VS Code: command wiring and approval boundary.
// Suggestions are advisory; diffs, commands, and agent handoffs all pass
// through explicit approval. Local heuristics always run before model calls.
import * as path from "node:path";
import * as vscode from "vscode";
import * as config from "./config";
import * as state from "./state";
import * as contextMod from "./context";
import * as suggestionsMod from "./suggestions";
import * as sidebarMod from "./sidebar";
import * as agentMod from "./agent";
import * as prompts from "./core/prompts";
import * as providers from "./core/providers";
import * as authMod from "./core/auth";
import * as git from "./core/git";
import * as search from "./core/search";
import * as runner from "./core/runner";
import * as testcmd from "./core/testcmd";
import { unsafe } from "./core/diffsafety";
import { ChatMessage, PendingAction, Suggestion } from "./core/types";
import { SidebarNode } from "./sidebar";

let sidebar: sidebarMod.SidebarProvider;
let treeView: vscode.TreeView<SidebarNode>;
let statusBar: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

// One place refreshes every surface that mirrors state: tree, view badge,
// and the status bar item.
function updateUi(): void {
  sidebar.refresh();
  const pending = state.pendingActions().length;
  const suggestions = state.data.suggestions.length;
  if (treeView) {
    treeView.badge = pending > 0
      ? { value: pending, tooltip: `${pending} action(s) pending approval` }
      : suggestions > 0
        ? { value: suggestions, tooltip: `${suggestions} suggestion(s)` }
        : undefined;
  }
  if (statusBar) {
    const parts = [`$(sparkle) Master Hand`, `${suggestions} suggestion${suggestions === 1 ? "" : "s"}`];
    if (pending > 0) parts.push(`$(shield) ${pending} pending`);
    statusBar.text = parts.join(" • ");
    statusBar.tooltip = `Master Hand: ${suggestions} suggestion(s)` + (pending > 0 ? `, ${pending} pending approval` : "");
    if (suggestions > 0 || pending > 0 || state.data.loading) statusBar.show();
    else statusBar.hide();
  }
}

function persist(): void {
  void state.persist(extensionContext.workspaceState, config.get().storage.enabled);
}

function notifyError(message: string): void {
  void vscode.window.showErrorMessage("Master Hand: " + message);
}

function notify(message: string): void {
  void vscode.window.showInformationMessage("Master Hand: " + message);
}

// Markdown output renders in the built-in markdown preview; anything else
// (json, diff) opens as a read-through editor tab beside the current one.
async function showDoc(content: string, language = "markdown"): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  if (language === "markdown") {
    try {
      await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
      return;
    } catch {
      // Markdown extension unavailable; fall through to the plain editor.
    }
  }
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

function selectionText(): { text: string; meta: { file: string; start: number; end: number } } | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return null;
  return {
    text: editor.document.getText(editor.selection),
    meta: {
      file: editor.document.uri.fsPath,
      start: editor.selection.start.line + 1,
      end: editor.selection.end.line + 1,
    },
  };
}

async function fileText(uri: vscode.Uri, cfg: ReturnType<typeof config.get>): Promise<{ text: string; label: string } | null> {
  if (uri.scheme !== "file") return null;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0) return null;
    const bytes = await vscode.workspace.fs.readFile(uri);
    const max = Math.max(1, cfg.context.maxModelFileBytes || cfg.context.maxFileBytes || 12000);
    const body = Buffer.from(bytes.slice(0, max)).toString("utf8");
    const label = vscode.workspace.asRelativePath(uri, false);
    const suffix = bytes.length > max ? `\n\n[truncated to ${max} bytes]` : "";
    return { label, text: `File: ${label}\n\n${body}${suffix}` };
  } catch {
    return null;
  }
}

// ---------- suggestions ----------

async function refreshSuggestions(mode: string): Promise<void> {
  const cfg = config.get();
  state.data.loading = true;
  state.data.loading_message = cfg.model.provider === "none" ? "building local suggestions…" : "asking model for suggestions…";
  updateUi();
  try {
    await suggestionsMod.generate(cfg, { mode }, (_items, err) => {
      updateUi();
      if (err) notifyError(err);
    });
  } finally {
    state.data.loading = false;
    state.data.loading_message = null;
    updateUi();
    persist();
  }
}

function suggestionFromNode(node: SidebarNode | undefined): Suggestion | null {
  if (node && node.kind === "suggestion") return node.suggestion;
  return null;
}

async function pickSuggestion(placeholder: string): Promise<Suggestion | null> {
  const items = state.data.suggestions.map((s) => ({
    label: s.title,
    description: `${Math.round(s.confidence * 100)}% · ${s.action_type}`,
    detail: s.reason,
    suggestion: s,
  }));
  if (items.length === 0) {
    notify("no suggestions yet; run Master Hand: Refresh Suggestions");
    return null;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true });
  return picked?.suggestion ?? null;
}

async function resolveSuggestion(node: SidebarNode | undefined, placeholder: string): Promise<Suggestion | null> {
  return suggestionFromNode(node) ?? (await pickSuggestion(placeholder));
}

function acceptSuggestion(suggestion: Suggestion): void {
  state.feedback(suggestion.id, "accepted");
  const cfg = config.get();
  if (!cfg.agent.enabled) {
    notify("marked handled (agent handoff disabled; feedback recorded)");
    persist();
    return;
  }
  const { ok, err } = agentMod.dispatch(suggestion, cfg);
  if (!ok) notifyError(err ?? "agent dispatch failed");
  else notify("sent to agent: " + suggestion.title);
  persist();
}

// ---------- model-backed advisory commands ----------

async function completeOrNotify(messages: ChatMessage[]): Promise<string | null> {
  const cfg = config.get();
  if (cfg.model.provider === "none") {
    const pick = await vscode.window.showErrorMessage(
      "Master Hand: no model selected for this command. Local suggestions still work.",
      "Select Model",
      "Open Settings",
    );
    if (pick === "Select Model") await modelCommand();
    else if (pick === "Open Settings") await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:artie-mortus.master-hand-vscode model");
    return null;
  }
  const { content, err } = await providers.complete(cfg.model, messages);
  if (!content) {
    const pick = await vscode.window.showErrorMessage(
      "Master Hand: " + (err ?? "model request failed"),
      "Test Model",
      "Select Model",
      "Open Settings",
    );
    if (pick === "Test Model") await modelStatusCommand();
    else if (pick === "Select Model") await modelCommand();
    else if (pick === "Open Settings") await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:artie-mortus.master-hand-vscode model");
    return null;
  }
  return content;
}

async function askCommand(resource?: vscode.Uri): Promise<void> {
  const cfg = config.get();
  const selection = selectionText();
  const activeResource = resource ?? vscode.window.activeTextEditor?.document.uri;
  const resourceText = selection ? null : activeResource ? await fileText(activeResource, cfg) : null;
  const question = await vscode.window.showInputBox({
    prompt: selection ? "Ask about the selected code" : resourceText ? `Ask about ${resourceText.label}` : "Ask a workspace-aware question",
    placeHolder: resourceText ? "What should I know before editing this file?" : "How does auth work?",
  });
  if (!question) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Master Hand: asking…" }, async () => {
    const snap = await contextMod.snapshot(cfg);
    const content = await completeOrNotify(prompts.ask(snap, question, selection?.text ?? resourceText?.text));
    if (content) await showDoc(`# Master Hand: ${question}\n\n${content}\n`);
  });
}

async function explainCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selection = selectionText();
  let diag: unknown = null;
  let snippet: string | undefined;
  let meta: unknown = null;
  if (selection) {
    snippet = selection.text;
    meta = selection.meta;
  } else if (editor) {
    const diags = vscode.languages.getDiagnostics(editor.document.uri);
    const line = editor.selection.active.line;
    const found = diags.find((d) => d.range.start.line <= line && d.range.end.line >= line) ?? diags[0];
    if (!found) {
      notify("no diagnostic or selection to explain");
      return;
    }
    diag = { message: found.message, severity: vscode.DiagnosticSeverity[found.severity], source: found.source };
    snippet = editor.document.getText(found.range.with(found.range.start.with(undefined, 0)));
    meta = { file: editor.document.uri.fsPath, line: found.range.start.line + 1 };
  } else {
    notify("no active editor");
    return;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Master Hand: explaining…" }, async () => {
    const content = await completeOrNotify(prompts.explain(diag, snippet, meta));
    if (content) await showDoc(`# Master Hand: explain\n\n${content}\n`);
  });
}

async function reviewCommand(): Promise<void> {
  const cfg = config.get();
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Master Hand: reviewing…" }, async () => {
    const snap = await contextMod.snapshot(cfg);
    const diffText = snap.diff !== "" ? snap.diff : await git.stagedDiff(snap.root, cfg.context.maxDiffBytes, cfg);
    if (diffText === "") {
      notify("no uncommitted changes to review");
      return;
    }
    const content = await completeOrNotify(prompts.review(snap, diffText));
    if (content) await showDoc(`# Master Hand: review of uncommitted changes\n\n${content}\n`);
  });
}

async function commitMessageCommand(): Promise<void> {
  const cfg = config.get();
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Master Hand: drafting commit message…" }, async () => {
    const snap = await contextMod.snapshot(cfg);
    const staged = await git.stagedDiff(snap.root, cfg.context.maxDiffBytes, cfg);
    const diffText = staged !== "" ? staged : snap.diff;
    if (diffText === "") {
      notify("no staged or working-tree diff");
      return;
    }
    const content = await completeOrNotify(prompts.commitMessage(diffText, staged !== ""));
    if (!content) return;
    const message = content.trim();
    // Native path: drop the draft straight into the matching Source Control input box.
    const gitExt = vscode.extensions.getExtension<{ getAPI(version: 1): { repositories: { rootUri?: vscode.Uri; inputBox: { value: string } }[] } }>("vscode.git")?.exports;
    const repos = gitExt?.getAPI(1)?.repositories ?? [];
    const repo = repos.find((r) => r.rootUri?.fsPath === snap.root) ?? repos[0];
    if (repo) {
      repo.inputBox.value = message;
      await vscode.commands.executeCommand("workbench.view.scm");
      notify("commit message drafted in Source Control input");
    } else {
      await vscode.env.clipboard.writeText(message);
      notify("commit message copied to clipboard");
      await showDoc("# Master Hand: commit message (copied)\n\n```\n" + message + "\n```\n");
    }
  });
}

// ---------- local tooling ----------

async function jumpToHit(hits: { file: string; lnum: number; text: string }[], root: string, placeholder: string): Promise<void> {
  if (hits.length === 0) {
    notify("no matches");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    hits.map((h) => ({ label: h.file, description: `line ${h.lnum}`, detail: h.text, hit: h })),
    { placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true },
  );
  if (!picked) return;
  const doc = await vscode.workspace.openTextDocument(path.join(root, picked.hit.file));
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(Math.max(0, picked.hit.lnum - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function todoCommand(): Promise<void> {
  const cfg = config.get();
  const root = state.data.root ?? (await contextMod.snapshot(cfg, { quick: true })).root;
  const hits = await search.rgMatches(root, "\\b(TODO|FIXME|HACK|XXX)[:\\s]", 200, cfg);
  await jumpToHit(hits, root, "TODO / FIXME / HACK / XXX");
}

async function searchCommand(): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: "Search workspace files",
    placeHolder: "Text or regular expression",
  });
  if (!query) return;
  const cfg = config.get();
  const root = state.data.root ?? (await contextMod.snapshot(cfg, { quick: true })).root;
  const hits = await search.rg(root, query, cfg.context.maxSearchResults, cfg);
  await jumpToHit(hits, root, "Master Hand search: " + query);
}

// ---------- goals / reset ----------

async function goalCommand(): Promise<void> {
  const goal = await vscode.window.showInputBox({
    prompt: "Project goal (broad intent, steers suggestions)",
    placeHolder: "Ship the settings UI rewrite",
    value: state.data.long_term_goal ?? "",
  });
  if (goal === undefined) return;
  state.data.long_term_goal = goal !== "" ? goal : null;
  state.data.long_term_goal_source = goal !== "" ? "user" : "inferred";
  // Changing steering invalidates the current suggestion set.
  state.setSuggestions([]);
  persist();
  updateUi();
  void refreshSuggestions("suggest");
}

async function nextCommand(): Promise<void> {
  const goal = await vscode.window.showInputBox({
    prompt: "Current focus (leave empty to let Master Hand infer it)",
    placeHolder: "Fix failing auth test",
    value: state.data.short_term_goal_source === "user" ? state.data.short_term_goal ?? "" : "",
  });
  if (goal === undefined) return;
  state.data.short_term_goal = goal !== "" ? goal : null;
  state.data.short_term_goal_source = goal !== "" ? "user" : "inferred";
  state.setSuggestions([]);
  persist();
  updateUi();
  void refreshSuggestions("suggest");
}

async function resetCommand(): Promise<void> {
  const what = await vscode.window.showQuickPick(["project goal and focus", "suggestions", "all state"], { placeHolder: "Reset what?" });
  if (!what) return;
  if (what === "project goal and focus" || what === "all state") {
    state.data.goal = null;
    state.data.goal_source = "inferred";
    state.data.long_term_goal = null;
    state.data.long_term_goal_source = "inferred";
    state.data.short_term_goal = null;
    state.data.short_term_goal_source = "inferred";
  }
  if (what === "suggestions" || what === "all state") {
    state.setSuggestions([]);
    state.data.dismissed = {};
    state.data.feedback = {};
  }
  if (what === "all state") {
    state.data.pending_actions = {};
    config.resetModelOverride();
  }
  persist();
  updateUi();
  notify("reset: " + what);
}

// ---------- model / auth ----------

const providerPickItems = [
  { label: "auto", description: "local Ollama when available; heuristics otherwise" },
  { label: "none", description: "disable model calls (heuristics only)" },
  { label: "ollama", description: "local Ollama" },
  { label: "ollama-cloud", description: "Ollama Cloud (OLLAMA_API_KEY)" },
  { label: "openai", description: "OpenAI API (OPENAI_API_KEY)" },
  { label: "openai_compatible", description: "any OpenAI-compatible endpoint" },
  { label: "openrouter", description: "OpenRouter (OPENROUTER_API_KEY)" },
  { label: "anthropic", description: "Anthropic API (ANTHROPIC_API_KEY)" },
  { label: "pi", description: "logged-in pi CLI (read-only model calls)" },
  { label: "codex", description: "logged-in Codex CLI" },
  { label: "claude", description: "logged-in Claude CLI" },
  { label: "gemini", description: "logged-in Gemini CLI" },
];

function formatModelItem(item: providers.ModelListItem): vscode.QuickPickItem & { id: string } {
  const parts: string[] = [];
  if (item.context) parts.push(`${Math.round(item.context / 1000)}k ctx`);
  if (item.reasoning) parts.push("thinking");
  if (item.cost_input !== undefined && item.cost_output !== undefined) {
    parts.push(`$${item.cost_input}/$${item.cost_output} per Mtok`);
  }
  return { label: item.id, description: parts.join(" · "), id: item.id };
}

const MANUAL_ENTRY = "(type model name manually)";

async function modelCommand(): Promise<void> {
  const picked = await vscode.window.showQuickPick(providerPickItems, {
    placeHolder: "Model provider (session-only; put defaults in settings.json)",
  });
  if (!picked) return;
  const provider = picked.label;

  if (provider === "none" || provider === "auto" || provider === "pi" || provider === "codex" || provider === "claude" || provider === "gemini") {
    config.setModelOverride({ provider, name: undefined, endpoint: undefined });
    notify("model provider: " + provider);
    return;
  }

  let ids: (vscode.QuickPickItem & { id: string })[] = [];
  if (provider === "ollama") {
    const names = await providers.listOllamaModels();
    ids = (names ?? []).map((id) => ({ label: id, id }));
  } else {
    const probe = providers.applyProviderDefaults({ ...config.get().model, provider, name: undefined });
    const { items, err } = await providers.listModels(probe);
    if (!items && err) notify("model list unavailable (" + err + "); type a name");
    ids = (items ?? []).map(formatModelItem);
  }
  ids.push({ label: MANUAL_ENTRY, id: MANUAL_ENTRY });

  const chosen = await vscode.window.showQuickPick(ids, { placeHolder: `${provider} model` });
  if (!chosen) return;
  let name = chosen.id;
  if (name === MANUAL_ENTRY) {
    const typed = await vscode.window.showInputBox({ prompt: `${provider} model name` });
    if (!typed) return;
    name = typed;
  }
  config.setModelOverride({ provider, name, endpoint: undefined });
  notify(`model: ${provider}/${name}`);
}

async function modelStatusCommand(): Promise<void> {
  const cfg = config.get();
  if (cfg.model.provider === "none") {
    notify("model provider is none");
    return;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Master Hand: testing model…" }, async () => {
    const { content, err } = await providers.complete(cfg.model, [
      { role: "user", content: "Reply with exactly: ok" },
    ]);
    if (content) notify(`model ok (${cfg.model.provider}/${cfg.model.name ?? "auto"}): ${content.trim().slice(0, 80)}`);
    else notifyError("model connection failed: " + String(err));
  });
}

async function authCommand(): Promise<void> {
  const cfg = config.get();
  const model = providers.applyProviderDefaults(cfg.model);
  const options: vscode.QuickPickItem[] = [{ label: "status", description: authMod.status(model) }];
  if (authMod.isAccountProvider(model.provider)) {
    options.push({ label: "login", description: "run the provider CLI login (may open a browser)" });
  } else {
    options.push({ label: "env", description: "point at a different environment variable" });
    options.push({ label: "key", description: "enter an API key for this session only" });
    options.push({ label: "clear", description: "forget the session-only key" });
  }
  const picked = await vscode.window.showQuickPick(options, { placeHolder: "Auth for " + String(model.provider) });
  if (!picked) return;
  if (picked.label === "status") {
    notify(authMod.status(model));
  } else if (picked.label === "login") {
    const { argv, err } = authMod.loginCommand(model);
    if (!argv) {
      notifyError(err ?? "no login command");
      return;
    }
    // Login runs in a visible terminal so the CLI can prompt / open a browser.
    const terminal = vscode.window.createTerminal({ name: "Master Hand Login", shellPath: argv[0], shellArgs: argv.slice(1) });
    terminal.show(true);
  } else if (picked.label === "env") {
    const env = await vscode.window.showInputBox({ prompt: "Environment variable name", value: authMod.defaultEnv(model) ?? "" });
    if (env) {
      config.setModelOverride({ apiKeyEnv: env });
      notify("api key env: " + env);
    }
  } else if (picked.label === "key") {
    const key = await vscode.window.showInputBox({ prompt: "API key (kept in memory for this session only)", password: true });
    if (key) {
      config.setModelOverride({ apiKey: key });
      notify("session key set: " + authMod.mask(key));
    }
  } else if (picked.label === "clear") {
    config.setModelOverride({ apiKey: undefined });
    notify("session key cleared");
  }
}

// ---------- approval-gated actions ----------

async function resolveAction(node: SidebarNode | undefined): Promise<PendingAction | null> {
  if (node && node.kind === "pending") return node.action;
  const pending = state.pendingActions();
  if (pending.length === 0) {
    notify("no pending approvals");
    return null;
  }
  const picked = await vscode.window.showQuickPick(
    pending.map((a) => ({ label: a.title, description: `${a.kind} · ${a.id}`, detail: a.argv?.join(" ") ?? a.diff?.slice(0, 200), action: a })),
    { placeHolder: "Pending approval", matchOnDescription: true, matchOnDetail: true },
  );
  return picked?.action ?? null;
}

async function viewPendingAction(node?: SidebarNode): Promise<void> {
  const action = await resolveAction(node);
  if (!action) return;
  if (action.kind === "diff" && action.diff) {
    await showDoc(action.diff, "diff");
    return;
  }
  await showDoc(
    `# Pending approval: ${action.title}\n\n` +
    `- kind: ${action.kind}\n` +
    `- id: ${action.id}\n` +
    `- status: ${action.status}\n` +
    `- workspace: ${action.root}\n` +
    (action.argv ? `\n\`\`\`sh\n${action.argv.join(" ")}\n\`\`\`\n` : ""),
  );
}

// Queue an action, then offer the native shortcut: notification buttons that
// approve/preview/reject without a trip back to the sidebar.
async function offerApproval(action: PendingAction): Promise<void> {
  updateUi();
  const buttons = action.kind === "diff" ? ["Approve", "Preview", "Reject"] : ["Approve", "Reject"];
  const pick = await vscode.window.showInformationMessage(
    `Master Hand: queued for approval — ${action.title}`,
    ...buttons,
  );
  if (pick === "Approve") await runApprovedAction(action);
  else if (pick === "Preview" && action.diff) {
    await showDoc(action.diff, "diff");
    await offerApproval(action);
  } else if (pick === "Reject") {
    action.status = "rejected";
    notify("rejected: " + action.title);
    updateUi();
  }
  // Dismissed notification: action simply stays in the pending section.
}

async function approveAction(node?: SidebarNode): Promise<void> {
  const action = await resolveAction(node);
  if (!action) return;
  await runApprovedAction(action);
}

async function runApprovedAction(action: PendingAction): Promise<void> {
  if (action.status !== "pending") return;
  const cfg = config.get();
  if (action.kind === "command") {
    action.status = "approved";
    updateUi();
    const { result, err } = await runner.run(action.root, action.argv, cfg);
    if (!result) {
      action.status = "failed";
      notifyError(`command failed: ${err}`);
    } else {
      action.status = "done";
      await showDoc(
        `# Master Hand: ${action.argv?.join(" ")}\n\nexit ${result.code}\n\n\`\`\`\n${result.stdout}\n${result.stderr}\n\`\`\`\n`,
      );
    }
  } else if (action.kind === "diff" && action.diff) {
    // Re-check before apply so approved stale patches cannot sneak through.
    const bad = unsafe(action.diff, cfg);
    if (bad) {
      action.status = "failed";
      notifyError("diff rejected: " + bad);
      updateUi();
      return;
    }
    const check = await git.apply(action.root, action.diff, true, cfg);
    if (!check.ok) {
      action.status = "failed";
      notifyError("git apply --check failed: " + check.err);
      updateUi();
      return;
    }
    const res = await git.apply(action.root, action.diff, false, cfg);
    action.status = res.ok ? "done" : "failed";
    if (res.ok) notify("diff applied");
    else notifyError("git apply failed: " + res.err);
  }
  updateUi();
}

async function rejectAction(node?: SidebarNode): Promise<void> {
  const action = await resolveAction(node);
  if (!action) return;
  action.status = "rejected";
  notify("rejected: " + action.title);
  updateUi();
}

async function runCommand(): Promise<void> {
  const raw = await vscode.window.showInputBox({
    prompt: "Command to run after approval",
    placeHolder: "npm test -- --grep \"auth flow\"",
  });
  if (!raw) return;
  const parsed = runner.parseCommandLine(raw);
  if (!parsed.argv) {
    notifyError(parsed.err ?? "invalid command line");
    return;
  }
  const cfg = config.get();
  const { argv: ok, err } = runner.validate(parsed.argv, cfg);
  if (!ok) {
    notifyError(err ?? "invalid command");
    return;
  }
  const root = state.data.root ?? (await contextMod.snapshot(cfg, { quick: true })).root;
  const action = state.createAction({ kind: "command", title: ok.join(" "), argv: ok, root });
  await offerApproval(action);
}

async function testCommand(): Promise<void> {
  const cfg = config.get();
  const root = state.data.root ?? (await contextMod.snapshot(cfg, { quick: true })).root;
  const { argv, err } = testcmd.infer(root);
  if (!argv) {
    notify(err ?? "no test setup detected");
    return;
  }
  const { argv: ok, err: verr } = runner.validate(argv, cfg);
  if (!ok) {
    notifyError(verr ?? "inferred test command failed validation");
    return;
  }
  const action = state.createAction({ kind: "command", title: "test: " + ok.join(" "), argv: ok, root });
  await offerApproval(action);
}

async function proposeDiffCommand(): Promise<void> {
  const request = await vscode.window.showInputBox({ prompt: "What should the proposed diff do?" });
  if (!request) return;
  const cfg = config.get();
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Master Hand: preparing diff…" }, async () => {
    const snap = await contextMod.snapshot(cfg);
    const { content, err } = await providers.complete(cfg.model, prompts.diff(snap, request));
    if (!content) {
      notifyError(err ?? "model request failed");
      return;
    }
    const bad = unsafe(content, cfg);
    if (bad) {
      notifyError("proposed diff rejected: " + bad);
      return;
    }
    const check = await git.apply(snap.root, content, true, cfg);
    if (!check.ok) {
      notifyError("git apply --check failed: " + check.err);
      return;
    }
    const action = state.createAction({ kind: "diff", title: "diff: " + request, diff: content, root: snap.root });
    await showDoc(content, "diff");
    await offerApproval(action);
  });
}

// ---------- suggestion item commands ----------

function workspaceRoot(): string {
  return state.data.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}

function suggestionFilePath(root: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(root, file);
}

function suggestionFilesMarkdown(files: string[], root: string): string {
  if (files.length === 0) return "none";
  return files.map((file) => {
    const full = suggestionFilePath(root, file);
    return `- [${file}](${vscode.Uri.file(full).toString()})`;
  }).join("\n");
}

async function viewSuggestion(node?: SidebarNode): Promise<void> {
  const s = await resolveSuggestion(node, "View which suggestion?");
  if (!s) return;
  const root = workspaceRoot();
  await showDoc(
    `# ${s.title}\n\n${s.reason}\n\n## Related files\n\n${suggestionFilesMarkdown(s.files, root)}\n\n` +
    `- next action: ${s.next_action || "none"}\n- confidence: ${s.confidence.toFixed(2)}\n- action type: ${s.action_type}\n`,
  );
}

async function copySuggestion(node?: SidebarNode): Promise<void> {
  const s = await resolveSuggestion(node, "Copy which suggestion prompt?");
  if (!s) return;
  const root = workspaceRoot();
  const { buildPrompt } = await import("./core/agentPrompt");
  await vscode.env.clipboard.writeText(buildPrompt(s, root, state.data.last_context));
  notify("agent prompt copied");
}

async function openSuggestionFile(node?: SidebarNode): Promise<void> {
  const s = await resolveSuggestion(node, "Open file from which suggestion?");
  if (!s) return;
  if (s.files.length === 0) {
    notify("suggestion has no related files");
    return;
  }
  const root = workspaceRoot();
  const picked = s.files.length === 1
    ? { file: s.files[0] }
    : await vscode.window.showQuickPick(
      s.files.map((file) => ({ label: file, description: path.dirname(file), file })),
      { placeHolder: "Open related file", matchOnDescription: true },
    );
  if (!picked) return;
  try {
    const doc = await vscode.workspace.openTextDocument(suggestionFilePath(root, picked.file));
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (e) {
    notifyError("could not open related file: " + String(e));
  }
}

function dismissSuggestion(node?: SidebarNode): void {
  const s = suggestionFromNode(node) ?? state.data.suggestions[0];
  if (!s) return;
  state.feedback(s.id, "dismissed");
  state.data.last_dismissed = s;
  state.data.suggestions = state.data.suggestions.filter((x) => x.id !== s.id);
  persist();
  updateUi();
}

function postponeSuggestion(node?: SidebarNode): void {
  const s = suggestionFromNode(node) ?? state.data.suggestions[0];
  if (!s) return;
  state.feedback(s.id, "postponed");
  state.data.suggestions = state.data.suggestions.filter((x) => x.id !== s.id);
  persist();
  updateUi();
}

function undoDismiss(): void {
  const s = state.data.last_dismissed;
  if (!s) {
    notify("nothing to undo");
    return;
  }
  delete state.data.dismissed[s.id];
  delete state.data.feedback[s.id];
  state.data.suggestions.unshift(s);
  state.data.last_dismissed = null;
  persist();
  updateUi();
}

// ---------- activation ----------

export function activate(ctx: vscode.ExtensionContext): void {
  extensionContext = ctx;
  state.restore(ctx.workspaceState, config.get().storage.enabled);
  providers.setModelsDevCacheFile(path.join(ctx.globalStorageUri.fsPath, "models-dev.json"));

  sidebar = new sidebarMod.SidebarProvider();
  treeView = vscode.window.createTreeView("masterHandSidebar", { treeDataProvider: sidebar });
  ctx.subscriptions.push(treeView);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "masterHandSidebar.focus";
  ctx.subscriptions.push(statusBar);
  updateUi();

  // Record recent edits; in advisory mode also debounce a suggestion refresh.
  // Passive default: nothing heavier than bookkeeping runs from typing.
  let debounce: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file" || e.contentChanges.length === 0) return;
      const change = e.contentChanges[0];
      const lineText = e.document.lineAt(Math.min(change.range.start.line, e.document.lineCount - 1)).text;
      state.addEdit(e.document.uri.fsPath, lineText);
      const cfg = config.get();
      if (cfg.proactivity === "advisory") {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void refreshSuggestions("suggest"), cfg.suggestionFrequencyMs);
      }
    }),
  );
  ctx.subscriptions.push({ dispose: () => debounce && clearTimeout(debounce) });

  const register = (name: string, fn: (...args: never[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(name, fn as (...args: unknown[]) => unknown));

  register("masterHand.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "@ext:artie-mortus.master-hand-vscode"),
  );
  register("masterHand.suggest", () => refreshSuggestions("suggest"));
  register("masterHand.plan", () => refreshSuggestions("plan"));
  register("masterHand.ask", askCommand);
  register("masterHand.explain", explainCommand);
  register("masterHand.review", reviewCommand);
  register("masterHand.commitMessage", commitMessageCommand);
  register("masterHand.todo", todoCommand);
  register("masterHand.search", searchCommand);
  register("masterHand.test", testCommand);
  register("masterHand.goal", goalCommand);
  register("masterHand.next", nextCommand);
  register("masterHand.reset", resetCommand);
  register("masterHand.model", modelCommand);
  register("masterHand.modelStatus", modelStatusCommand);
  register("masterHand.auth", authCommand);
  register("masterHand.run", runCommand);
  register("masterHand.proposeDiff", proposeDiffCommand);
  register("masterHand.pending", async () => {
    const pending = state.pendingActions();
    if (pending.length === 0) notify("no pending approvals");
    else await showDoc("# Pending approvals\n\n" + pending.map((a) => `- ${a.title} (${a.kind}, ${a.id})`).join("\n") + "\n");
  });
  register("masterHand.viewPendingAction", viewPendingAction);
  register("masterHand.approveAction", approveAction);
  register("masterHand.rejectAction", rejectAction);
  register("masterHand.status", async () => {
    const snap = state.data.last_context ?? (await contextMod.snapshot(config.get(), { quick: true }));
    notify(contextMod.summaryLines(snap).join(" | "));
  });
  register("masterHand.showContext", async () => {
    const snap = state.data.last_context ?? (await contextMod.snapshot(config.get()));
    await showDoc(JSON.stringify(snap, null, 2), "json");
  });
  register("masterHand.showIndex", async () => {
    const snap = state.data.last_context ?? (await contextMod.snapshot(config.get()));
    await showDoc(JSON.stringify(snap.repo_index, null, 2), "json");
  });
  register("masterHand.send", async () => {
    const s = await pickSuggestion("Send which suggestion to the agent?");
    if (s) acceptSuggestion(s);
  });
  register("masterHand.acceptSuggestion", async (node?: SidebarNode) => {
    const s = await resolveSuggestion(node, "Accept which suggestion?");
    if (s) acceptSuggestion(s);
  });
  register("masterHand.dismissSuggestion", (node?: SidebarNode) => dismissSuggestion(node));
  register("masterHand.postponeSuggestion", (node?: SidebarNode) => postponeSuggestion(node));
  register("masterHand.viewSuggestion", viewSuggestion);
  register("masterHand.copySuggestion", copySuggestion);
  register("masterHand.openSuggestionFile", openSuggestionFile);
  register("masterHand.undoDismiss", undoDismiss);
}

export function deactivate(): void {
  // Terminals created for agent handoff are owned by VS Code; nothing to stop.
}
