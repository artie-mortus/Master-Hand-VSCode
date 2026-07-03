// Approved-suggestion handoff prompt and argv template expansion.
import { MHConfig, Snapshot, Suggestion } from "./types";

function oneLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ");
}

export function buildPrompt(suggestion: Suggestion, root: string, snap: Partial<Snapshot> | null): string {
  const files = (suggestion.files ?? []).join(", ");
  const lines = [
    "You are a coding agent launched by Master Hand from VS Code.",
    "Repo root: " + root,
    "",
    "Approved suggestion:",
    "Title: " + oneLine(suggestion.title),
    "Reason: " + oneLine(suggestion.reason),
    "Files: " + (files !== "" ? files : "none specified"),
    "Next action: " + oneLine(suggestion.next_action),
    "Action type: " + oneLine(suggestion.action_type),
    "",
    "Steering:",
    "Long-term: " + oneLine(snap?.long_term_goal ?? "none"),
    "Short-term: " + oneLine(snap?.short_term_goal ?? "none"),
    "",
    "Constraints:",
    "- Edit only this repo unless explicitly required.",
    "- Keep changes minimal and focused on approved suggestion.",
    "- Preserve uncommitted user work; inspect git status before broad edits.",
    "- Do not commit, push, or run destructive commands unless user explicitly asks.",
    "- Save modified files. VS Code reloads changed files automatically.",
  ];
  if (snap?.changed_files && snap.changed_files.length > 0) {
    lines.push("", "Changed files: " + snap.changed_files.join(", "));
  }
  if (snap?.diagnostics) {
    lines.push("Diagnostics: " + JSON.stringify(snap.diagnostics));
  }
  return lines.join("\n");
}

function replaceVars(value: string, vars: Record<string, string>): string {
  // "$" as a whole argv element is prompt shorthand; embedded "$" stays
  // literal so env-var-looking arguments are never rewritten.
  if (value === "$") return vars.prompt ?? "";
  return value.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

function configuredExecutable(agent: MHConfig["agent"]): string {
  if (agent.executable && agent.executable !== "") return agent.executable;
  if (agent.adapter === "codex") return "codex";
  return "pi";
}

// Resolve the agent argv. Custom command templates must be argv arrays; shell
// strings are rejected. Default adapters run in a VS Code terminal.
export function agentArgv(agent: MHConfig["agent"], prompt: string, root: string): { argv: string[] | null; err?: string } {
  const vars = { prompt, root };
  if (agent.command && agent.command.length > 0) {
    if (agent.command.some((part) => typeof part !== "string")) {
      return { argv: null, err: "agent.command must be an argv array of strings" };
    }
    return { argv: agent.command.map((part) => replaceVars(part, vars)) };
  }
  const adapter = agent.adapter || "auto";
  const exe = configuredExecutable(agent);
  if (adapter === "codex" || exe === "codex") return { argv: ["codex", "exec", prompt] };
  if (adapter === "pi" || adapter === "terminal" || adapter === "auto") return { argv: [exe, prompt] };
  return { argv: null, err: "unknown agent adapter: " + adapter };
}
