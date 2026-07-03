// Prompt builders for model-backed suggestions and proposed diffs.
import { ChatMessage, Snapshot, Suggestion } from "./types";

function firstN<T>(list: T[] | undefined, n: number): T[] {
  return (list ?? []).slice(0, n);
}

function askContext(snap: Partial<Snapshot>) {
  return {
    root: snap.root,
    branch: snap.branch,
    short_term_goal: snap.short_term_goal ?? snap.goal,
    short_term_goal_source: snap.short_term_goal_source ?? snap.goal_source,
    long_term_goal: snap.long_term_goal,
    long_term_goal_source: snap.long_term_goal_source,
    open_buffers: firstN(snap.open_buffers, 12),
    changed_files: firstN(snap.changed_files, 24),
    diagnostics: snap.diagnostics,
    git_status: snap.git_status,
    diff: snap.diff,
    repo_files: firstN(snap.repo_files, 80),
    repo_index: snap.repo_index,
    related: firstN(snap.related, 24),
    symbols: firstN(snap.symbols, 40),
  };
}

function stateGoal(snap: Partial<Snapshot>, kind: "long" | "short"): string | undefined {
  if (kind === "long") return snap.long_term_goal ?? snap.goal;
  return snap.short_term_goal ?? snap.goal;
}

export function suggestions(snap: Snapshot, mode: string, localSuggestions: Suggestion[]): ChatMessage[] {
  const payload = JSON.stringify({ mode: mode || "suggest", context: snap, local_suggestions: localSuggestions ?? [] });
  return [
    {
      role: "system",
      content:
        "You are Master Hand, a VS Code coding assistant. First review local_suggestions, then inspect provided repo context and code excerpts. Steer every suggestion by context.short_term_goal as the immediate next step and context.long_term_goal as the broader direction; only deviate for safety/correctness. Return only JSON array of suggestions with title, reason, files, confidence, next_action, action_type. Act as an assistant: never claim to edit files or run commands directly; use proposed_edit or command only as suggestions requiring approval.",
    },
    { role: "user", content: payload },
  ];
}

export function ask(snap: Partial<Snapshot>, question: string, selection?: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are Master Hand, a read-only repo assistant inside VS Code. Answer concisely using the provided bounded repository context. When a code selection is included, focus the answer on it. Cite files by repo-relative path when relevant. Do not propose diffs or commands unless the user explicitly asks for them. Never claim you edited files or ran commands.",
    },
    { role: "user", content: JSON.stringify({ question, selection, context: askContext(snap) }) },
  ];
}

export function review(snap: Partial<Snapshot>, diffText: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a read-only reviewer. Find bugs, risks, and missing tests in this diff. Return one finding per line in the form `file:line: severity: problem. fix.` No praise. Do not propose applying changes.",
    },
    {
      role: "user",
      content: JSON.stringify({
        goal: { long_term: stateGoal(snap, "long"), short_term: stateGoal(snap, "short") },
        diff: diffText,
      }),
    },
  ];
}

export function commitMessage(diffText: string, staged: boolean): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Write ONE conventional commit message for this diff. Subject imperative <=72 chars, optional wrapped body explaining why. Return only the message text, no fences, no commentary.",
    },
    { role: "user", content: JSON.stringify({ staged: staged === true, diff: diffText }) },
  ];
}

export function explain(diag: unknown, snippet: string | undefined, meta: unknown): ChatMessage[] {
  const system = diag
    ? "Explain this diagnostic concisely: what it means, likely cause, how to fix. Read-only; do not claim to have edited anything."
    : "Explain this code snippet concisely: what it does, anything surprising, and likely pitfalls. Read-only; do not claim to have edited anything.";
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ diagnostic: diag, snippet, meta }) },
  ];
}

export function goal(snap: Snapshot): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are Master Hand, a VS Code coding assistant. Infer steering intent, not a hard goal. Maintain long_term_goal as user/project direction and short_term_goal as immediate repo-aware next objective informed by long_term_goal. If either goal source is user, preserve it exactly and infer only the missing/non-user side. Return only JSON object with long_term_goal, short_term_goal, confidence. Do not suggest edits or commands.",
    },
    { role: "user", content: JSON.stringify({ context: snap }) },
  ];
}

export function diff(snap: Snapshot, request: string): ChatMessage[] {
  return [
    { role: "system", content: "Return only a unified diff. Do not explain. Modify only repo-relative paths." },
    { role: "user", content: JSON.stringify({ context: snap, request }) },
  ];
}
