// Normalizes untrusted suggestion objects into one safe internal shape.
import { ActionType, Suggestion } from "./types";

const allowed = new Set<string>(["advice", "proposed_edit", "command"]);

export function suggestion(item: unknown): Suggestion | null {
  if (typeof item !== "object" || item === null) return null;
  const raw = item as Record<string, unknown>;
  const title = String(raw.title ?? "");
  if (title === "") return null;
  const actionType: ActionType = allowed.has(String(raw.action_type)) ? (String(raw.action_type) as ActionType) : "advice";
  const confidence = Number(raw.confidence);
  return {
    id: String(raw.id ?? title.replace(/\s+/g, "-").toLowerCase()),
    title,
    reason: String(raw.reason ?? ""),
    files: Array.isArray(raw.files) ? raw.files.map((f) => String(f)) : [],
    confidence: Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0.5)),
    next_action: String(raw.next_action ?? ""),
    action_type: actionType,
    requires_approval: actionType !== "advice" || raw.requires_approval === true,
    command: raw.command,
    diff_request: raw.diff_request,
  };
}

export function list(items: unknown): Suggestion[] {
  const out: Suggestion[] = [];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const ok = suggestion(item);
    if (ok) out.push(ok);
  }
  return out;
}
