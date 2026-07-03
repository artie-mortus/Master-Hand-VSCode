// In-memory extension state plus a small persistable subset (workspaceState).
import * as vscode from "vscode";
import { PendingAction, RecentEdit, Snapshot, Suggestion } from "./core/types";

export interface StateData {
  root: string | null;
  goal: string | null;
  goal_source: string;
  long_term_goal: string | null;
  long_term_goal_source: string;
  short_term_goal: string | null;
  short_term_goal_source: string;
  recent_edits: RecentEdit[];
  suggestions: Suggestion[];
  feedback: Record<string, string>;
  dismissed: Record<string, boolean>;
  last_dismissed: Suggestion | null;
  pending_actions: Record<string, PendingAction>;
  last_context: Snapshot | null;
  loading: boolean;
  loading_message: string | null;
}

export const data: StateData = {
  root: null,
  goal: null,
  goal_source: "inferred",
  long_term_goal: null,
  long_term_goal_source: "inferred",
  short_term_goal: null,
  short_term_goal_source: "inferred",
  recent_edits: [],
  suggestions: [],
  feedback: {},
  dismissed: {},
  last_dismissed: null,
  pending_actions: {},
  last_context: null,
  loading: false,
  loading_message: null,
};

const STORAGE_KEY = "masterHand.state";

export function addEdit(file: string, lineText: string): void {
  data.recent_edits.unshift({ file, line: lineText.trim(), time: Math.floor(Date.now() / 1000) });
  data.recent_edits.length = Math.min(data.recent_edits.length, 20);
}

export function setSuggestions(items: Suggestion[]): void {
  data.suggestions = items ?? [];
  // Undo-dismiss only makes sense within the suggestion set it came from.
  data.last_dismissed = null;
}

export function feedback(id: string, action: string): void {
  data.feedback[id] = action;
  if (action === "dismissed") data.dismissed[id] = true;
}

interface Persisted {
  goal?: string | null;
  goal_source?: string;
  long_term_goal?: string | null;
  long_term_goal_source?: string;
  short_term_goal?: string | null;
  short_term_goal_source?: string;
  feedback?: Record<string, string>;
  dismissed?: Record<string, boolean>;
}

export function restore(memento: vscode.Memento, enabled: boolean): void {
  if (!enabled) return;
  const saved = memento.get<Persisted>(STORAGE_KEY);
  if (!saved) return;
  data.goal = saved.goal ?? data.goal;
  data.goal_source = saved.goal_source ?? data.goal_source;
  data.long_term_goal = saved.long_term_goal ?? data.long_term_goal ?? data.goal;
  data.long_term_goal_source = saved.long_term_goal_source ?? data.long_term_goal_source;
  data.short_term_goal = saved.short_term_goal ?? data.short_term_goal;
  data.short_term_goal_source = saved.short_term_goal_source ?? data.short_term_goal_source;
  data.feedback = saved.feedback ?? data.feedback;
  data.dismissed = saved.dismissed ?? data.dismissed;
}

export function persist(memento: vscode.Memento, enabled: boolean): Thenable<void> | undefined {
  if (!enabled) return;
  return memento.update(STORAGE_KEY, {
    goal: data.goal,
    goal_source: data.goal_source,
    long_term_goal: data.long_term_goal,
    long_term_goal_source: data.long_term_goal_source,
    short_term_goal: data.short_term_goal,
    short_term_goal_source: data.short_term_goal_source,
    feedback: data.feedback,
    dismissed: data.dismissed,
  } satisfies Persisted);
}

// Pending approval lifecycle.
let actionSeq = 0;

export function createAction(action: Omit<PendingAction, "id" | "status"> & { id?: string; status?: PendingAction["status"] }): PendingAction {
  actionSeq += 1;
  const full: PendingAction = {
    ...action,
    id: action.id ?? "act-" + actionSeq,
    status: action.status ?? "pending",
  };
  data.pending_actions[full.id] = full;
  return full;
}

export function getAction(id: string): PendingAction | undefined {
  const action = data.pending_actions[id];
  return action && action.status === "pending" ? action : undefined;
}

export function pendingActions(): PendingAction[] {
  return Object.values(data.pending_actions)
    .filter((a) => a.status === "pending")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
