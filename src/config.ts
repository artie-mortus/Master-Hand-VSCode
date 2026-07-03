// Maps VS Code settings into one MHConfig object, plus session-only model
// overrides (the Pick Model / Auth commands change runtime config only;
// persistent defaults live in settings.json).
import * as vscode from "vscode";
import { MHConfig, ModelConfig, RankedCandidate } from "./core/types";

let modelOverride: Partial<ModelConfig> = {};

export function setModelOverride(patch: Partial<ModelConfig>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (modelOverride as Record<string, unknown>)[k];
    else (modelOverride as Record<string, unknown>)[k] = v;
  }
}

export function resetModelOverride(): void {
  modelOverride = {};
}

function strOrUndef(v: string | undefined): string | undefined {
  return v && v !== "" ? v : undefined;
}

function arrOrUndef(v: string[] | undefined): string[] | undefined {
  return v && v.length > 0 ? v : undefined;
}

export function get(): MHConfig {
  const c = vscode.workspace.getConfiguration("masterHand");
  const model: ModelConfig = {
    provider: c.get<string>("model.provider", "auto"),
    name: strOrUndef(c.get<string>("model.name", "")),
    endpoint: strOrUndef(c.get<string>("model.endpoint", "")),
    apiKeyEnv: strOrUndef(c.get<string>("model.apiKeyEnv", "")),
    executable: strOrUndef(c.get<string>("model.executable", "")),
    command: arrOrUndef(c.get<string[]>("model.command", [])),
    loginCommand: arrOrUndef(c.get<string[]>("model.loginCommand", [])),
    timeoutMs: c.get<number>("model.timeoutMs", 60000),
    temperature: c.get<number>("model.temperature", 0.2),
    maxTokens: c.get<number>("model.maxTokens", 1200),
    selection: c.get<"auto" | "fixed">("model.selection", "auto"),
    cloudPolicy: c.get<"fallback" | "best">("model.cloudPolicy", "fallback"),
    ranked: c.get<RankedCandidate[]>("model.ranked", []),
    rankingModel: c.get<Partial<ModelConfig> | null>("model.rankingModel", null),
    rankingMaxTokens: c.get<number>("model.rankingMaxTokens", 24),
    ...modelOverride,
  };
  return {
    proactivity: c.get<"passive" | "advisory">("proactivity", "passive"),
    suggestionFrequencyMs: c.get<number>("suggestionFrequencyMs", 5000),
    observation: {
      buffers: c.get<boolean>("observation.buffers", true),
      edits: c.get<boolean>("observation.edits", true),
      diagnostics: c.get<boolean>("observation.diagnostics", true),
      git: c.get<boolean>("observation.git", true),
    },
    ignore: c.get<string[]>("ignore", [".git/", "node_modules/", "dist/", "build/", "out/", ".env", ".env.*"]),
    model,
    context: {
      maxFiles: c.get<number>("context.maxFiles", 80),
      maxDiffBytes: c.get<number>("context.maxDiffBytes", 24000),
      maxFileBytes: c.get<number>("context.maxFileBytes", 12000),
      maxSearchResults: c.get<number>("context.maxSearchResults", 40),
      maxModelCodeFiles: c.get<number>("context.maxModelCodeFiles", 8),
      maxModelFileBytes: c.get<number>("context.maxModelFileBytes", 12000),
      includeRelatedFiles: c.get<boolean>("context.includeRelatedFiles", true),
      includeSymbols: c.get<boolean>("context.includeSymbols", true),
      includeIndex: c.get<boolean>("context.includeIndex", true),
      indexMaxFiles: c.get<number>("context.indexMaxFiles", 500),
      indexMaxFileBytes: c.get<number>("context.indexMaxFileBytes", 20000),
      indexMaxTodos: c.get<number>("context.indexMaxTodos", 40),
      indexMaxSymbols: c.get<number>("context.indexMaxSymbols", 80),
    },
    commands: {
      allowlist: c.get<string[]>("commands.allowlist", ["git", "make", "npm", "pnpm", "yarn", "cargo", "go", "pytest", "python", "node", "npx"]),
      blocklist: c.get<string[]>("commands.blocklist", ["rm", "sudo", "git reset", "git clean"]),
      timeoutMs: c.get<number>("commands.timeoutMs", 10000),
    },
    agent: {
      enabled: c.get<boolean>("agent.enabled", true),
      adapter: c.get<string>("agent.adapter", "auto"),
      executable: strOrUndef(c.get<string>("agent.executable", "")),
      command: arrOrUndef(c.get<string[]>("agent.command", [])),
    },
    storage: { enabled: c.get<boolean>("storage.enabled", true) },
  };
}
