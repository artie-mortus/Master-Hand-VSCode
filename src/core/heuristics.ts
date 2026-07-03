// Local suggestion heuristics. Pure functions of the snapshot: no processes,
// no file reads, no network. These must work even with model.provider = "none".
import { MHConfig, Snapshot, Suggestion } from "./types";
import * as schema from "./schema";

function item(
  id: string,
  title: string,
  reason: string,
  files: string[],
  confidence: number,
  nextAction: string,
): Suggestion {
  return schema.suggestion({
    id,
    title,
    reason,
    files,
    confidence,
    next_action: nextAction,
    action_type: "advice",
  }) as Suggestion;
}

const codeExt = new Set([
  "lua", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "c", "h", "cpp", "hpp",
  "cc", "java", "kt", "swift", "php", "sh", "bash", "vim",
]);

// Mirror the repoindex test-path matcher so "has tests" here matches repo_index.tests.
export function looksLikeTest(file: string): boolean {
  return /^tests?\//.test(file) || /\/tests?\//.test(file) || /[_.\-]test\./.test(file) || /[_.\-]spec\./.test(file);
}

function isCodeFile(file: string): boolean {
  const m = file.match(/\.([\w\-]+)$/);
  return codeExt.has((m?.[1] ?? "").toLowerCase());
}

// Porcelain v1 unmerged states: any side is U, plus AA (both added) and DD (both deleted).
function conflictedFiles(snap: Snapshot): string[] {
  const files: string[] = [];
  for (const c of snap.changed ?? []) {
    const st = c.status ?? "";
    if (st.includes("U") || st === "AA" || st === "DD") files.push(c.file);
  }
  return files;
}

function hasConflictMarkers(diff: string | undefined): boolean {
  return !!diff && (diff.includes("<<<<<<<") || diff.includes(">>>>>>>"));
}

function repoHasTests(snap: Snapshot): boolean {
  const idx = snap.repo_index as { tests?: string[] };
  if ((idx?.tests ?? []).length > 0) return true;
  return (snap.repo_files ?? []).some(looksLikeTest);
}

export function heuristic(snap: Snapshot, config: MHConfig): Suggestion[] {
  const out: Suggestion[] = [];

  const conflicts = conflictedFiles(snap);
  if (conflicts.length > 0 || hasConflictMarkers(snap.diff)) {
    const why = conflicts.length > 0
      ? `${conflicts.length} unmerged file(s) in git status`
      : "conflict markers present in the diff";
    out.push(item(
      "merge-conflict",
      "Resolve merge conflicts first",
      `Repository is mid-merge: ${why}; other work will build on a broken tree.`,
      conflicts.length > 0 ? conflicts : snap.changed_files,
      0.9,
      "Resolve the conflict markers, then git add the files and finish the merge before anything else.",
    ));
  }

  if (snap.short_term_goal && snap.short_term_goal !== "") {
    out.push(item(
      "goal-plan",
      "Use steered next step",
      `Next step (short-term) is ${snap.short_term_goal_source || "inferred"}; direction (long-term) is ${snap.long_term_goal || "unspecified"}.`,
      snap.changed_files,
      0.82,
      `Review related search hits for: ${[snap.short_term_goal, snap.long_term_goal ?? ""].join(" ")}`,
    ));
  }

  if ((snap.related ?? []).length > 0) {
    const files: string[] = [];
    const seen = new Set<string>();
    for (const hit of snap.related) {
      if (!seen.has(hit.file)) {
        seen.add(hit.file);
        files.push(hit.file);
      }
    }
    out.push(item(
      "related-files",
      "Review related files",
      "Goal terms appear in these files; they may need coordinated changes.",
      files,
      0.78,
      "Inspect related hits (Master Hand: Show Context Snapshot) before editing.",
    ));
  }

  if (snap.diagnostics.errors > 0) {
    out.push(item(
      "diagnostics-errors",
      "Resolve current diagnostics before broad changes",
      "Errors can hide regressions from recent edits.",
      snap.open_buffers,
      0.88,
      "Open the Problems panel and fix highest-severity errors first.",
    ));
  }

  if (snap.changed_files.length > 0) {
    out.push(item(
      "review-git-diff",
      "Review coordinated changes",
      "Git diff has modified files; tests/docs/config may need sync.",
      snap.changed_files,
      0.76,
      "Inspect git diff and list related files that may need changes.",
    ));
  }

  if (snap.recent_edits.length > 0 && snap.changed_files.length === 0) {
    out.push(item(
      "save-or-check-edits",
      "Recent editor changes not reflected in git diff",
      "Unsaved editors may make repository context stale.",
      [snap.recent_edits[0].file],
      0.7,
      "Save files or refresh suggestions after editing.",
    ));
  }

  const diffBytes = (snap.diff ?? "").length;
  const maxDiff = config.context.maxDiffBytes || 24000;
  if (diffBytes >= Math.floor(maxDiff * 0.9) || snap.changed_files.length >= 12) {
    out.push(item(
      "oversized-diff",
      "Commit in reviewable slices",
      `Uncommitted change is large: ${snap.changed_files.length} files, ~${diffBytes} diff bytes; big diffs are hard to review and revert.`,
      snap.changed_files,
      0.6,
      "Stage and commit related changes as smaller, self-contained commits.",
    ));
  }

  if (repoHasTests(snap)) {
    const changedSource: string[] = [];
    let changedHasTest = false;
    for (const f of snap.changed_files ?? []) {
      if (looksLikeTest(f)) changedHasTest = true;
      else if (isCodeFile(f)) changedSource.push(f);
    }
    if (changedSource.length > 0 && !changedHasTest) {
      out.push(item(
        "tests-not-updated",
        "Update tests with this change",
        "Source files changed but no test files, while the repo has a test suite.",
        changedSource,
        0.62,
        "Add or update tests covering the changed source before you commit.",
      ));
    }
  }

  if (snap.diagnostics?.files) {
    const changedSet = new Set(snap.changed_files ?? []);
    let worstFile: string | null = null;
    let worstWarnings = 0;
    // Deterministic tie-break (warnings desc, then path asc); object key order is not contractual.
    for (const [file, counts] of Object.entries(snap.diagnostics.files)) {
      const warnings = counts.warnings ?? 0;
      if (changedSet.has(file) && (warnings > worstWarnings || (warnings === worstWarnings && worstFile !== null && file < worstFile))) {
        worstFile = file;
        worstWarnings = warnings;
      }
    }
    if (worstFile && worstWarnings >= 3) {
      out.push(item(
        "diagnostics-hotspot",
        "Clear warnings in the changed file",
        `${worstFile} carries ${worstWarnings} warnings and is part of the current change.`,
        [worstFile],
        0.6,
        "Address the concentrated warnings in this file before broadening the change.",
      ));
    }
  }

  if (out.length === 0) {
    out.push(item(
      "no-obstacle",
      "No immediate obstacle detected",
      "No visible git changes or diagnostics.",
      snap.open_buffers,
      0.55,
      "Keep working for inferred goal updates or set a goal (Master Hand: Set Long-Term Goal).",
    ));
  }
  return out;
}
