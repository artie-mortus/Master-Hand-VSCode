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
let extensionContext: vscode.ExtensionContext;

function persist(): void {
  void state.persist(extensionContext.workspaceState, config.get().storage.enabled);
}

function notifyError(message: string): void {
  void vscode.window.showErrorMessage("Master Hand: " + message);
}

function notify(message: string): void {
  void vscode.window.showInformationMessage("Master Hand: " + message);
}

async function showDoc(content: string, language = "markdown"): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language });
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

// ---------- suggestions ----------

async function refreshSuggestions(mode: string): Promise<void> {
  const cfg = config.get();
  state.data.loading = true;
  state.data.loading_message = cfg.model.provider === "none" ? "building local suggestions…" : "asking model for suggestions…";
  sidebar.refresh();
  try {
    await suggestionsMod.generate(cfg, { mode }, (_items, err) => {
      sidebar.refresh();
      if (err) notifyError(err);
    });
  } finally {
    state.data.loading = false;
    state.data.loading_message = null;
    sidebar.refresh();
    persist();
  }
}

function suggestionFromNode(node: SidebarNode | undefined): Suggestion | null {
  if (node && node.kind === "suggestion") return node.suggestion;
  return null;
}

async function pickSuggestion(placeholder: string): Promise<Suggestion | null> {
  const items = state.data.suggestions.map((s, i) => ({ label: `${i + 1}. ${s.title}`, description: s.reason, suggestion: s }));
  if (items.length === 0) {
    notify("no suggestions; run Refresh Suggestions first");
    return null;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
  return picked?.suggestion ?? null;
}

async function resolveSuggestion(node: SidebarNode | undefined, placeholder: string): Promise<Suggestion | null> {
  return suggestionFromNode(node) ?? (await pickSuggestion(placeholder));
}

function acceptSuggestion(suggestion: Suggestion): void {
  state.feedback(suggestion.id, "accepted");
  const cfg = config.get();
  if (!cfg.agent.enabled) {
    notify("accepted (agent handoff disabled; feedback recorded)");
    persist();
    return;
  }
  const { ok, err } = agentMod.dispatch(suggestion, cfg);
  if (!ok) notifyError(err ?? "agent dispatch failed");
  else notify("sent to external agent: " + suggestion.title);
  persist();
}

// ---------- model-backed advisory commands ----------

async function completeOrNotify(messages: ChatMessage[]): Promise<string | null> {
  const cfg = config.get();
  if (cfg.model.provider === "none") {
    notifyError("model provider is none; set masterHand.model.provider");
    return null;
  }
  const { content, err } = await providers.complete(cfg.model, messages);
  if (!content) {
    notifyError(err ?? "model request failed");
    return null;
  }
  return content;
}

async function askCommand(): Promise<void> {
  const selection = selectionText();
  const question = await vscode.window.showInputBox({
    prompt: selection ? "Ask about the selected code" : "Ask a repo-aware question",
    placeHolder: "How does auth work?",
  });
  if (!question) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Master Hand: asking…" }, async () => {
    const snap = await contextMod.snapshot(config.get());
    const content = await completeOrNotify(prompts.ask(snap, question, selection?.text));
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
    if (content) {
      await vscode.env.clipboard.writeText(content.trim());
      notify("commit message copied to clipboard");
      await showDoc("# Master Hand: commit message (copied)\n\n```\n" + content.trim() + "\n```\n");
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
    hits.map((h) => ({ label: `${h.file}:${h.lnum}`, description: h.text, hit: h })),
    { placeHolder: placeholder, matchOnDescription: true },
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
  const query = await vscode.window.showInputBox({ prompt: "ripgrep query" });
  if (!query) return;
  const cfg = config.get();
  const root = state.data.root ?? (await contextMod.snapshot(cfg, { quick: true })).root;
  const hits = await search.rg(root, query, cfg.context.maxSearchResults, cfg);
  await jumpToHit(hits, root, "search: " + query);
}

// ---------- goals / reset ----------

async function goalCommand(): Promise<void> {
  const goal = await vscode.window.showInputBox({
    prompt: "Long-term direction (broad intent, steers suggestions)",
    value: state.data.long_term_goal ?? "",
  });
  if (goal === undefined) return;
  state.data.long_term_goal = goal !== "" ? goal : null;
  state.data.long_term_goal_source = goal !== "" ? "user" : "inferred";
  // Changing steering invalidates the current suggestion set.
  state.setSuggestions([]);
  persist();
  sidebar.refresh();
  void refreshSuggestions("suggest");
}

async function nextCommand(): Promise<void> {
  const goal = await vscode.window.showInputBox({
    prompt: "Short-term next step (empty returns it to inference)",
    value: state.data.short_term_goal_source === "user" ? state.data.short_term_goal ?? "" : "",
  });
  if (goal === undefined) return;
  state.data.short_term_goal = goal !== "" ? goal : null;
  state.data.short_term_goal_source = goal !== "" ? "user" : "inferred";
  state.setSuggestions([]);
  persist();
  sidebar.refresh();
  void refreshSuggestions("suggest");
}

async function resetCommand(): Promise<void> {
  const what = await vscode.window.showQuickPick(["goals", "suggestions", "all"], { placeHolder: "Reset what?" });
  if (!what) return;
  if (what === "goals" || what === "all") {
    state.data.goal = null;
    state.data.goal_source = "inferred";
    state.data.long_term_goal = null;
    state.data.long_term_goal_source = "inferred";
    state.data.short_term_goal = null;
    state.data.short_term_goal_source = "inferred";
  }
  if (what === "suggestions" || what === "all") {
    state.setSuggestions([]);
    state.data.dismissed = {};
    state.data.feedback = {};
  }
  if (what === "all") {
    state.data.pending_actions = {};
    config.resetModelOverride();
  }
  persist();
  sidebar.refresh();
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
    notify("no pending actions");
    return null;
  }
  const picked = await vscode.window.showQuickPick(
    pending.map((a) => ({ label: `${a.id}: ${a.title}`, description: a.argv?.join(" ") ?? a.kind, action: a })),
    { placeHolder: "Pending action" },
  );
  return picked?.action ?? null;
}

async function approveAction(node?: SidebarNode): Promise<void> {
  const action = await resolveAction(node);
  if (!action) return;
  const cfg = config.get();
  if (action.kind === "command") {
    action.status = "approved";
    sidebar.refresh();
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
      sidebar.refresh();
      return;
    }
    const check = await git.apply(action.root, action.diff, true, cfg);
    if (!check.ok) {
      action.status = "failed";
      notifyError("git apply --check failed: " + check.err);
      sidebar.refresh();
      return;
    }
    const res = await git.apply(action.root, action.diff, false, cfg);
    action.status = res.ok ? "done" : "failed";
    if (res.ok) notify("diff applied");
    else notifyError("git apply failed: " + res.err);
  }
  sidebar.refresh();
}

async function rejectAction(node?: SidebarNode): Promise<void> {
  const action = await resolveAction(node);
  if (!action) return;
  action.status = "rejected";
  notify("rejected: " + action.title);
  sidebar.refresh();
}

async function runCommand(): Promise<void> {
  const raw = await vscode.window.showInputBox({
    prompt: "Command to queue for approval (space-separated argv; no shell quoting/metacharacters)",
    placeHolder: "npm test",
  });
  if (!raw) return;
  const argv = raw.split(/\s+/).filter((a) => a !== "");
  const cfg = config.get();
  const { argv: ok, err } = runner.validate(argv, cfg);
  if (!ok) {
    notifyError(err ?? "invalid command");
    return;
  }
  const root = state.data.root ?? (await contextMod.snapshot(cfg, { quick: true })).root;
  state.createAction({ kind: "command", title: ok.join(" "), argv: ok, root });
  sidebar.refresh();
  notify("queued for approval: " + ok.join(" "));
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
  state.createAction({ kind: "command", title: "test: " + ok.join(" "), argv: ok, root });
  sidebar.refresh();
  notify("test command queued for approval: " + ok.join(" "));
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
    state.createAction({ kind: "diff", title: "diff: " + request, diff: content, root: snap.root });
    sidebar.refresh();
    await showDoc("# Master Hand: proposed diff (pending approval)\n\n```diff\n" + content + "\n```\n");
    notify("diff queued for approval");
  });
}

// ---------- suggestion item commands ----------

async function viewSuggestion(node?: SidebarNode): Promise<void> {
  const s = await resolveSuggestion(node, "View which suggestion?");
  if (!s) return;
  await showDoc(
    `# ${s.title}\n\n${s.reason}\n\n- files: ${s.files.join(", ") || "none"}\n- next action: ${s.next_action || "none"}\n- confidence: ${s.confidence.toFixed(2)}\n- action type: ${s.action_type}\n`,
  );
}

async function copySuggestion(node?: SidebarNode): Promise<void> {
  const s = await resolveSuggestion(node, "Copy which suggestion prompt?");
  if (!s) return;
  const root = state.data.root ?? "";
  const { buildPrompt } = await import("./core/agentPrompt");
  await vscode.env.clipboard.writeText(buildPrompt(s, root, state.data.last_context));
  notify("agent prompt copied");
}

async function openSuggestionFile(node?: SidebarNode): Promise<void> {
  const s = await resolveSuggestion(node, "Open file from which suggestion?");
  if (!s || s.files.length === 0) return;
  const root = state.data.root ?? "";
  const doc = await vscode.workspace.openTextDocument(path.join(root, s.files[0]));
  await vscode.window.showTextDocument(doc);
}

function dismissSuggestion(node?: SidebarNode): void {
  const s = suggestionFromNode(node) ?? state.data.suggestions[0];
  if (!s) return;
  state.feedback(s.id, "dismissed");
  state.data.last_dismissed = s;
  state.data.suggestions = state.data.suggestions.filter((x) => x.id !== s.id);
  persist();
  sidebar.refresh();
}

function postponeSuggestion(node?: SidebarNode): void {
  const s = suggestionFromNode(node) ?? state.data.suggestions[0];
  if (!s) return;
  state.feedback(s.id, "postponed");
  state.data.suggestions = state.data.suggestions.filter((x) => x.id !== s.id);
  persist();
  sidebar.refresh();
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
  sidebar.refresh();
}

// ---------- activation ----------

export function activate(ctx: vscode.ExtensionContext): void {
  extensionContext = ctx;
  state.restore(ctx.workspaceState, config.get().storage.enabled);
  providers.setModelsDevCacheFile(path.join(ctx.globalStorageUri.fsPath, "models-dev.json"));

  sidebar = new sidebarMod.SidebarProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider("masterHandSidebar", sidebar));

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
    if (pending.length === 0) notify("no pending actions");
    else await showDoc("# Pending actions\n\n" + pending.map((a) => `- ${a.id}: ${a.title}`).join("\n") + "\n");
  });
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
