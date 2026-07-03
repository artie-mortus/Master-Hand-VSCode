// Approved suggestion handoff to external coding agents.
// The agent runs in a VS Code terminal created with shellPath/shellArgs (argv,
// no shell string), so the user can watch and interact with it. VS Code reloads
// externally changed files on its own; no checktime polling is needed.
import * as vscode from "vscode";
import { MHConfig, Suggestion } from "./core/types";
import { agentArgv, buildPrompt } from "./core/agentPrompt";
import * as state from "./state";

export function dispatch(suggestion: Suggestion, config: MHConfig): { ok: boolean; err?: string } {
  if (!config.agent.enabled) return { ok: false, err: "agent handoff disabled (masterHand.agent.enabled)" };
  const root = state.data.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return { ok: false, err: "no workspace root" };
  const prompt = buildPrompt(suggestion, root, state.data.last_context);
  const { argv, err } = agentArgv(config.agent, prompt, root);
  if (!argv) return { ok: false, err };

  const terminal = vscode.window.createTerminal({
    name: "Master Hand Agent",
    cwd: root,
    shellPath: argv[0],
    shellArgs: argv.slice(1),
  });
  terminal.show(true);
  return { ok: true };
}
