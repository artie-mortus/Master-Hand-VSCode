// API key and account CLI auth helpers for model providers.
import { ModelConfig } from "./types";

const defaultEnvByProvider: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const accountCliProviders = new Set(["codex", "claude", "gemini", "pi", "cli"]);

const loginCommandByProvider: Record<string, string[]> = {
  codex: ["codex", "login"],
  claude: ["claude", "login"],
  gemini: ["gemini", "auth", "login"],
};

function isOllamaCloud(model: Partial<ModelConfig>): boolean {
  return model.provider === "ollama" && !!model.endpoint && /ollama\.com/.test(model.endpoint);
}

export function defaultEnv(model: Partial<ModelConfig>): string | undefined {
  if (model.apiKeyEnv && model.apiKeyEnv !== "") return model.apiKeyEnv;
  if (isOllamaCloud(model)) return "OLLAMA_API_KEY";
  if (model.provider === "openai_compatible" && (!model.endpoint || /api\.openai\.com/.test(model.endpoint))) {
    return "OPENAI_API_KEY";
  }
  return defaultEnvByProvider[model.provider ?? ""];
}

export function key(model: Partial<ModelConfig>): { key: string | null; env?: string } {
  if (model.apiKey && model.apiKey !== "") return { key: model.apiKey };
  const env = defaultEnv(model);
  if (!env) return { key: null };
  const value = process.env[env];
  if (value && value !== "") return { key: value, env };
  return { key: null, env };
}

export function isAccountProvider(provider: string | undefined): boolean {
  return accountCliProviders.has(provider ?? "");
}

export function loginCommand(model: Partial<ModelConfig>): { argv: string[] | null; err?: string } {
  let cmd: string[] | undefined;
  if (model.loginCommand && model.loginCommand.length > 0) {
    if (model.loginCommand.some((a) => typeof a !== "string")) {
      return { argv: null, err: "loginCommand must be an argv array of strings" };
    }
    cmd = [...model.loginCommand];
  } else {
    cmd = loginCommandByProvider[model.provider ?? ""] ? [...loginCommandByProvider[model.provider!]] : undefined;
  }
  if (!cmd) return { argv: null, err: "login command not configured for provider: " + String(model.provider) };
  if (model.executable && model.executable !== "") cmd[0] = model.executable;
  return { argv: cmd };
}

export function mask(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 4) + "…" + value.slice(-4);
}

export function status(model: Partial<ModelConfig>): string {
  const { key: k, env } = key(model);
  const parts = ["provider=" + String(model.provider ?? "?")];
  if (isAccountProvider(model.provider)) {
    parts.push("auth=account-cli");
    if (model.executable) parts.push("executable=" + model.executable);
    return parts.join(" ");
  }
  if (env) parts.push("api_key_env=" + env);
  if (k) parts.push("auth=set");
  else if (env) parts.push("auth=missing");
  else parts.push("auth=not-required");
  return parts.join(" ");
}
