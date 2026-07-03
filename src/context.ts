// Builds one repo/editor snapshot used by suggestions, prompts, and status UI.
// Deterministic and local; never calls model providers from here.
import * as vscode from "vscode";
import { ChangedFile, DiagnosticCounts, MHConfig, RecentEdit, Snapshot } from "./core/types";
import * as paths from "./core/paths";
import * as git from "./core/git";
import * as search from "./core/search";
import * as repoindex from "./core/repoindex";
import * as state from "./state";

function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

// Open (non-untitled) documents inside repo root, filtered through project ignores.
function openBuffers(root: string, config: MHConfig): string[] {
  if (!config.observation.buffers) return [];
  const items: string[] = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isUntitled || doc.uri.scheme !== "file") continue;
    const name = doc.uri.fsPath;
    const norm = paths.normalize(name);
    if (norm === root || norm.startsWith(paths.normalize(root) + "/")) {
      const rel = paths.relative(root, name);
      if (!paths.isIgnored(rel, config.ignore)) items.push(rel);
    }
  }
  return paths.dedupe(items);
}

// Collapse VS Code diagnostics into counts so prompts/UI stay compact.
function diagnostics(root: string, config: MHConfig): DiagnosticCounts {
  const counts: DiagnosticCounts = { errors: 0, warnings: 0, info: 0, hints: 0, files: {} };
  if (!config.observation.diagnostics) return counts;
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") continue;
    const file = paths.relative(root, uri.fsPath);
    for (const d of diags) {
      const bucket =
        d.severity === vscode.DiagnosticSeverity.Error ? "errors"
        : d.severity === vscode.DiagnosticSeverity.Warning ? "warnings"
        : d.severity === vscode.DiagnosticSeverity.Information ? "info"
        : "hints";
      counts[bucket] += 1;
      counts.files[file] = counts.files[file] ?? { errors: 0, warnings: 0, info: 0, hints: 0 };
      counts.files[file][bucket] += 1;
    }
  }
  return counts;
}

function recentEdits(root: string, config: MHConfig): RecentEdit[] {
  if (!config.observation.edits) return [];
  const out: RecentEdit[] = [];
  for (const edit of state.data.recent_edits) {
    const rel = paths.relative(root, edit.file);
    if (!paths.isIgnored(rel, config.ignore)) out.push({ file: rel, line: edit.line, time: edit.time });
  }
  return out;
}

interface Goals {
  goal: string;
  goal_source: string;
  short_term_goal: string;
  short_term_goal_source: string;
  long_term_goal: string;
  long_term_goal_source: string;
}

function inferGoal(edits: RecentEdit[], changed: ChangedFile[], diag: DiagnosticCounts): Goals {
  let longGoal = state.data.long_term_goal ?? state.data.goal;
  let longSource = state.data.long_term_goal_source ?? state.data.goal_source ?? "inferred";
  if (longSource === "user" && longGoal) {
    // Keep user intent as steering, not a hard task. Short-term work follows local evidence.
  } else if (state.data.goal_source === "user" && state.data.goal) {
    longGoal = state.data.goal;
    longSource = "user";
  } else {
    longGoal = "Improve the current project safely";
    longSource = "inferred";
  }

  let shortGoal: string;
  let shortSource: string;
  if (state.data.short_term_goal_source === "user" && state.data.short_term_goal) {
    shortGoal = state.data.short_term_goal;
    shortSource = "user";
  } else {
    const edit = edits[0];
    if (edit && edit.line !== "") {
      let text = edit.line.replace(/^\s*[-/*#]+\s*/, "").replace(/\s+/g, " ");
      if (text.length > 90) text = text.slice(0, 87) + "...";
      shortGoal = "Continue implementing: " + text;
    } else if (changed.length > 0) {
      shortGoal = "Review and complete changes in " + changed.map((c) => c.file).join(", ");
    } else if (diag.errors > 0) {
      shortGoal = "Fix current diagnostics";
    } else {
      shortGoal = "Understand current repo state and suggest next step";
    }
    shortSource = "inferred";
  }
  const goal = `${shortGoal} (steered by: ${longGoal})`;
  return {
    goal,
    goal_source: shortSource,
    short_term_goal: shortGoal,
    short_term_goal_source: shortSource,
    long_term_goal: longGoal!,
    long_term_goal_source: longSource,
  };
}

// Infer goals from local evidence and mirror them into state.
function applyGoals(edits: RecentEdit[], changed: ChangedFile[], diag: DiagnosticCounts): Goals {
  const goals = inferGoal(edits, changed, diag);
  state.data.goal = goals.goal;
  state.data.goal_source = goals.goal_source;
  state.data.short_term_goal = goals.short_term_goal;
  state.data.short_term_goal_source = goals.short_term_goal_source;
  state.data.long_term_goal = goals.long_term_goal;
  state.data.long_term_goal_source = goals.long_term_goal_source;
  return goals;
}

// Active-editor symbols via the built-in symbol provider (tree-sitter equivalent).
async function symbols(): Promise<{ name: string; lnum: number; kind: string }[]> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return [];
  try {
    const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      editor.document.uri,
    );
    const out: { name: string; lnum: number; kind: string }[] = [];
    const walk = (items: vscode.DocumentSymbol[]) => {
      for (const s of items) {
        out.push({ name: s.name, lnum: s.range.start.line + 1, kind: vscode.SymbolKind[s.kind] });
        if (s.children) walk(s.children);
        if (out.length >= 200) return;
      }
    };
    walk(syms ?? []);
    return out;
  } catch {
    return [];
  }
}

// Reentrancy: concurrent snapshot requests coalesce onto the in-flight run.
let inflight: Promise<Snapshot> | null = null;
let inflightQuick = false;

export function snapshot(config: MHConfig, opts?: { quick?: boolean }): Promise<Snapshot> {
  const quick = opts?.quick === true;
  // A full snapshot is a superset of a quick one; only reuse an in-flight run
  // when it satisfies the request.
  if (inflight && (!inflightQuick || quick)) return inflight;
  inflightQuick = quick;
  inflight = build(config, quick).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function build(config: MHConfig, quick: boolean): Promise<Snapshot> {
  const root = state.data.root ?? (await git.root(workspaceCwd(), config));
  state.data.root = root;

  const observeGit = config.observation.git;
  const indexLimit = config.context.indexMaxFiles || 500;
  const filesLimit = Math.max(config.context.maxFiles || 80, indexLimit);

  const [branch, changed, allFiles] = await Promise.all([
    quick ? Promise.resolve("") : git.branch(root, config),
    observeGit ? git.changedFiles(root, config) : Promise.resolve([]),
    quick ? Promise.resolve([]) : git.lsFiles(root, filesLimit, config),
  ]);

  const changedNames = changed.map((c) => c.file);
  const edits = recentEdits(root, config);
  const diag = diagnostics(root, config);
  const goals = applyGoals(edits, changed, diag);

  const [diffText, related, syms] = await Promise.all([
    !quick && observeGit ? git.diff(root, changedNames, config.context.maxDiffBytes, config) : Promise.resolve(""),
    !quick && config.context.includeRelatedFiles
      ? search.relatedToGoal(root, `${goals.short_term_goal} ${goals.long_term_goal}`, config.context.maxSearchResults, config)
      : Promise.resolve([]),
    !quick && config.context.includeSymbols ? symbols() : Promise.resolve([]),
  ]);

  const snap: Snapshot = {
    root,
    branch,
    ...goals,
    open_buffers: openBuffers(root, config),
    recent_edits: edits,
    diagnostics: diag,
    git_status: observeGit ? changed.map((c) => `${c.status} ${c.file}`).join("\n") : "",
    changed_files: changedNames,
    changed,
    diff: diffText,
    repo_files: quick ? [] : allFiles.slice(0, config.context.maxFiles),
    repo_index: !quick && config.context.includeIndex ? repoindex.build(root, allFiles.slice(0, indexLimit), config) : {},
    related,
    symbols: syms,
    feedback: state.data.feedback,
  };
  state.data.last_context = snap;
  return snap;
}

export function summaryLines(snap: Snapshot): string[] {
  return [
    "root: " + (snap.root || "?"),
    "branch: " + (snap.branch !== "" ? snap.branch : "?"),
    `next step (short-term): ${snap.short_term_goal || "none"} (${snap.short_term_goal_source || "inferred"})`,
    `direction (long-term): ${snap.long_term_goal || "none"} (${snap.long_term_goal_source || "inferred"})`,
    `buffers=${snap.open_buffers.length} changed=${snap.changed_files.length} diagnostics=${snap.diagnostics.errors}E/${snap.diagnostics.warnings}W`,
  ];
}
