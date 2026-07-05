// Suggestion generation: local heuristics first, optional model suggestions second.
import * as fs from "node:fs";
import * as path from "node:path";
import { MHConfig, Snapshot, Suggestion } from "./core/types";
import { heuristic } from "./core/heuristics";
import * as schema from "./core/schema";
import * as prompts from "./core/prompts";
import * as providers from "./core/providers";
import * as paths from "./core/paths";
import * as context from "./context";
import * as state from "./state";

function errorItem(id: string, title: string, reason: string): Suggestion {
  return schema.suggestion({
    id,
    title,
    reason,
    files: [],
    confidence: 0.3,
    next_action: "Check model config or continue with heuristic suggestions.",
    action_type: "advice",
  }) as Suggestion;
}

// Bounded code excerpts for model prompts: changed files, open editors,
// related hits, then index entrypoints.
function codeContext(snap: Snapshot, config: MHConfig): { file: string; text: string }[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (file: string | undefined) => {
    if (!file || seen.has(file) || paths.isIgnored(file, config.ignore)) return;
    seen.add(file);
    candidates.push(file);
  };
  for (const f of snap.changed_files ?? []) add(f);
  for (const f of snap.open_buffers ?? []) add(f);
  for (const hit of snap.related ?? []) add(hit.file);
  for (const f of (snap.repo_index as { entrypoints?: string[] })?.entrypoints ?? []) add(f);

  const out: { file: string; text: string }[] = [];
  for (const file of candidates) {
    if (out.length >= (config.context.maxModelCodeFiles || 8)) break;
    const full = path.join(snap.root, file);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > (config.context.maxModelFileBytes || 12000)) continue;
      const text = fs.readFileSync(full, "utf8").split("\n").slice(0, 500).join("\n");
      out.push({ file, text });
    } catch {
      // Unreadable candidates are skipped, same as the sync path failing readfile.
    }
  }
  return out;
}

function tryParseJson(content: string): unknown | null {
  const attempts = [content.trim()];
  // CLI providers often wrap JSON in markdown fences; tolerate that.
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());
  const array = content.match(/\[[\s\S]*\]/);
  if (array) attempts.push(array[0]);
  const object = content.match(/\{[\s\S]*\}/);
  if (object) attempts.push(object[0]);
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next extraction
    }
  }
  return null;
}

function applyModelGoal(snap: Snapshot, content: string | null): Snapshot {
  if (!content) return snap;
  const decoded = tryParseJson(content) as Record<string, unknown> | null;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return snap;
  const confidence = Math.max(0, Math.min(1, Number(decoded.confidence) || 0.5));
  if (confidence < 0.45) return snap;
  if (typeof decoded.long_term_goal === "string" && decoded.long_term_goal.trim() !== "" && snap.long_term_goal_source !== "user") {
    snap.long_term_goal = decoded.long_term_goal.trim();
    snap.long_term_goal_source = "model";
  }
  const shortRaw = typeof decoded.short_term_goal === "string" ? decoded.short_term_goal : typeof decoded.goal === "string" ? decoded.goal : null;
  if (shortRaw && shortRaw.trim() !== "" && snap.short_term_goal_source !== "user") {
    snap.short_term_goal = shortRaw.trim();
    snap.short_term_goal_source = "model";
  }
  snap.goal = `${snap.short_term_goal ?? ""} (steered by: ${snap.long_term_goal ?? ""})`;
  snap.goal_source = snap.short_term_goal_source;
  state.data.goal = snap.goal;
  state.data.goal_source = snap.goal_source;
  state.data.short_term_goal = snap.short_term_goal;
  state.data.short_term_goal_source = snap.short_term_goal_source;
  state.data.long_term_goal = snap.long_term_goal;
  state.data.long_term_goal_source = snap.long_term_goal_source;
  return snap;
}

function shouldInferModelGoal(snap: Snapshot, config: MHConfig, opts: GenerateOpts): boolean {
  if (opts.skipModel) return false;
  if (config.model.provider === "none") return false;
  return !(snap.long_term_goal_source === "user" && snap.short_term_goal_source === "user");
}

async function inferModelGoal(snap: Snapshot, config: MHConfig, opts: GenerateOpts): Promise<{ snap: Snapshot; err?: string; hadContent: boolean }> {
  if (!shouldInferModelGoal(snap, config, opts)) return { snap, hadContent: false };
  // Goal inference steers off repo shape (files, diff, diagnostics); code
  // excerpts go only to the suggestions call, halving tokens per refresh.
  const { content, err } = await providers.complete(config.model, prompts.goal(snap));
  return { snap: applyModelGoal(snap, content), err, hadContent: content !== null };
}

function parseProviderSuggestions(content: string | null, err: string | undefined, config: MHConfig): { items: Suggestion[]; err?: string } {
  if (!content) {
    if (config.model.provider === "auto") return { items: [], err };
    return { items: [errorItem("provider-error", "Model provider failed", err ?? "unknown error")], err };
  }
  const decoded = tryParseJson(content);
  const malformed = { items: [errorItem("provider-parse-error", "Model suggestions malformed", "Provider did not return JSON array.")], err: "Provider did not return JSON array" };
  if (decoded === null) return malformed;
  if (Array.isArray(decoded)) return { items: schema.list(decoded) };
  const nested = (decoded as { suggestions?: unknown }).suggestions;
  if (Array.isArray(nested)) return { items: schema.list(nested) };
  return malformed;
}

function setFiltered(items: Suggestion[]): Suggestion[] {
  const filtered = items.filter((s) => !state.data.dismissed[s.id]);
  state.setSuggestions(filtered);
  return filtered;
}

export interface GenerateOpts {
  mode?: string;
  skipModel?: boolean;
}

// Staged generation: quick heuristics surface fast, the full pass scans the
// repo, then optional model goal + model suggestions refine the list.
// onUpdate fires after every stage so the sidebar can re-render progressively.
export async function generate(
  config: MHConfig,
  opts: GenerateOpts,
  onUpdate: (items: Suggestion[], err?: string) => void,
): Promise<Suggestion[]> {
  const quickSnap = await context.snapshot(config, { quick: true });
  onUpdate(setFiltered(heuristic(quickSnap, config)));

  const snap = await context.snapshot(config, { quick: false });
  const localSuggestions = heuristic(snap, config);
  onUpdate(setFiltered(localSuggestions));

  if (config.model.provider === "none" || opts.skipModel) return state.data.suggestions;

  const { snap: refined, err: goalErr, hadContent } = await inferModelGoal(snap, config, opts);
  const refinedLocal = heuristic(refined, config);
  onUpdate(setFiltered(refinedLocal));
  if (config.model.provider === "auto" && goalErr && !hadContent) {
    // Opportunistic auto provider: no model reachable, heuristics are the result.
    onUpdate(state.data.suggestions, goalErr);
    return state.data.suggestions;
  }

  const request: Snapshot = { ...refined, code: codeContext(refined, config) };
  const { content, err } = await providers.complete(config.model, prompts.suggestions(request, opts.mode ?? "suggest", refinedLocal));
  const parsed = parseProviderSuggestions(content, err, config);
  const out = setFiltered([...refinedLocal, ...parsed.items]);
  onUpdate(out, parsed.err);
  return out;
}
