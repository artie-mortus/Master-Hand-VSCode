// Model provider adapters: API providers over fetch, plus login-backed CLI
// subscription providers (pi/codex/claude/gemini/custom) over child_process.
// All requests carry bounded timeouts and degrade to (null, err).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChatMessage, ModelConfig, RankedCandidate } from "./types";
import * as auth from "./auth";

export type Completion = { content: string | null; err?: string };

// ---------- HTTP ----------

async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ decoded: unknown | null; err?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return { decoded: null, err: "provider returned invalid JSON" };
    }
    if (!res.ok) {
      return { decoded: null, err: `provider request failed (${res.status}): ${text.slice(0, 400)}` };
    }
    if (typeof decoded !== "object" || decoded === null) {
      return { decoded: null, err: "provider returned unexpected JSON type" };
    }
    return { decoded };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { decoded: null, err: `provider request timed out after ${((timeoutMs || 0) / 1000).toFixed(1)}s` };
    }
    return { decoded: null, err: String(err.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number) {
  return fetchJson(
    url,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    timeoutMs,
  );
}

// ---------- Account CLI providers ----------

const accountCliCommands: Record<string, string[]> = {
  codex: ["codex", "exec", "{prompt}"],
  claude: ["claude", "-p", "{prompt}"],
  gemini: ["gemini", "-p", "{prompt}"],
  pi: ["pi", "--no-tools", "--no-session", "-p", "{prompt}"],
};

export function messagesPrompt(messages: ChatMessage[]): string {
  return (messages ?? []).map((m) => `${m.role ?? "user"}:\n${m.content ?? ""}`).join("\n\n");
}

function cliCommand(model: ModelConfig, prompt: string): { argv: string[] | null; stdin?: string; err?: string } {
  let cmd: string[] | undefined;
  if (model.command && model.command.length > 0) {
    if (model.command.some((a) => typeof a !== "string")) {
      return { argv: null, err: "model.command must be an argv array of strings" };
    }
    cmd = [...model.command];
  } else {
    cmd = accountCliCommands[model.provider] ? [...accountCliCommands[model.provider]] : undefined;
  }
  if (!cmd) return { argv: null, err: "model.command required for cli provider" };
  if (model.executable && model.executable !== "") cmd[0] = model.executable;
  let usedPrompt = false;
  const out = cmd.map((arg) => {
    if (arg === "$") {
      // "$" as a whole argv element is prompt shorthand, same as agent.command.
      usedPrompt = true;
      return prompt;
    }
    if (arg.includes("{prompt}")) {
      usedPrompt = true;
      return arg.split("{prompt}").join(prompt);
    }
    return arg;
  });
  // When no placeholder consumed the prompt, send it over stdin instead.
  return { argv: out, stdin: usedPrompt ? undefined : prompt };
}

function runCli(argv: string[], stdin: string | undefined, timeoutMs: number, provider?: string): Promise<Completion> {
  return new Promise((resolve) => {
    const child = execFile(
      argv[0],
      argv.slice(1),
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            resolve({ content: null, err: `provider request timed out after ${((timeoutMs || 0) / 1000).toFixed(1)}s` });
            return;
          }
          const detail = (stderr ?? "").trim() || (stdout ?? "").trim() || String(error.message);
          const hint = provider && accountCliCommands[provider] ? `; run Master Hand: Sign In / Check Provider (login ${provider})` : "";
          resolve({ content: null, err: detail + hint });
          return;
        }
        const content = (stdout ?? "").trim();
        resolve(content !== "" ? { content } : { content: null, err: "cli provider returned empty output" });
      },
    );
    child.on("error", (e) => resolve({ content: null, err: String(e) }));
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin?.end();
    }
  });
}

async function accountCli(model: ModelConfig, messages: ChatMessage[]): Promise<Completion> {
  const prompt = messagesPrompt(messages);
  const { argv, stdin, err } = cliCommand(model, prompt);
  if (!argv) return { content: null, err };
  return runCli(argv, stdin, model.timeoutMs, model.provider);
}

export function runLogin(argv: string[]): Promise<{ ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    const child = execFile(argv[0], argv.slice(1), { encoding: "utf8" }, (error, _stdout, stderr) => {
      resolve(error ? { ok: false, err: (stderr ?? "").trim() || String(error.message) } : { ok: true });
    });
    child.on("error", (e) => resolve({ ok: false, err: String(e) }));
  });
}

// ---------- OpenAI-compatible / OpenRouter ----------

function openaiBody(model: ModelConfig, messages: ChatMessage[]) {
  return {
    model: model.name,
    messages,
    temperature: model.temperature,
    max_tokens: model.maxTokens,
  };
}

function openaiContent(decoded: unknown): Completion {
  const d = decoded as { choices?: { message?: { content?: string } }[] };
  const content = d?.choices?.[0]?.message?.content;
  if (content) return { content };
  return { content: null, err: "provider response missing choices[0].message.content" };
}

async function openaiCompatible(model: ModelConfig, messages: ChatMessage[]): Promise<Completion> {
  if (!model.endpoint || !model.name) return { content: null, err: "model.endpoint and model.name required" };
  const { key } = auth.key(model);
  const headers: Record<string, string> = key ? { Authorization: "Bearer " + key } : {};
  const { decoded, err } = await postJson(model.endpoint, openaiBody(model, messages), headers, model.timeoutMs);
  if (!decoded) return { content: null, err };
  return openaiContent(decoded);
}

async function openrouter(model: ModelConfig, messages: ChatMessage[]): Promise<Completion> {
  model.endpoint = model.endpoint || "https://openrouter.ai/api/v1/chat/completions";
  model.apiKeyEnv = model.apiKeyEnv || "OPENROUTER_API_KEY";
  const { key } = auth.key(model);
  if (!key) return { content: null, err: "openrouter api key missing: set masterHand.model.apiKeyEnv" };
  return openaiCompatible(model, messages);
}

// ---------- Ollama ----------

// Parse `ollama list` stdout into installed model names, preferred coder/code/
// qwen names first (preserving listed order), then the rest.
export function parseOllamaNames(stdout: string): string[] {
  const preferred: string[] = [];
  const fallback: string[] = [];
  for (const line of (stdout ?? "").split("\n")) {
    const name = line.match(/^(\S+)/)?.[1];
    if (name && name !== "NAME") {
      if (/coder|code|qwen/i.test(name)) preferred.push(name);
      else fallback.push(name);
    }
  }
  return [...preferred, ...fallback];
}

export function listOllamaModels(): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = execFile("ollama", ["list"], { timeout: 3000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : parseOllamaNames(stdout ?? ""));
    });
    child.on("error", () => resolve(null));
  });
}

function ollamaBody(model: ModelConfig, messages: ChatMessage[]) {
  return {
    model: model.name,
    messages,
    stream: false,
    options: { temperature: model.temperature, num_predict: model.maxTokens },
  };
}

function ollamaContent(decoded: unknown): Completion {
  const d = decoded as { message?: { content?: string } };
  const content = d?.message?.content;
  if (content) return { content };
  return { content: null, err: "ollama response missing message.content" };
}

async function ollama(model: ModelConfig, messages: ChatMessage[]): Promise<Completion> {
  const endpoint = model.endpoint || "http://localhost:11434/api/chat";
  if (!model.name) {
    const names = await listOllamaModels();
    model.name = names?.[0];
  }
  if (!model.name) return { content: null, err: "no local ollama model available" };
  const { key } = auth.key(model);
  const headers: Record<string, string> = key ? { Authorization: "Bearer " + key } : {};
  const { decoded, err } = await postJson(endpoint, ollamaBody(model, messages), headers, model.timeoutMs);
  if (!decoded) return { content: null, err };
  return ollamaContent(decoded);
}

// ---------- Anthropic ----------

function anthropicPayload(model: ModelConfig, messages: ChatMessage[]) {
  const systemParts: string[] = [];
  const userMessages: { role: string; content: string }[] = [];
  for (const msg of messages ?? []) {
    if (msg.role === "system") systemParts.push(msg.content);
    else userMessages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
  }
  return {
    model: model.name,
    max_tokens: model.maxTokens,
    temperature: model.temperature,
    system: systemParts.join("\n\n"),
    messages: userMessages,
  };
}

function anthropicContent(decoded: unknown): Completion {
  const d = decoded as { content?: { text?: string }[] };
  const content = d?.content?.[0]?.text;
  if (content) return { content };
  return { content: null, err: "anthropic response missing content[0].text" };
}

function anthropicHeaders(key: string): Record<string, string> {
  return { "x-api-key": key, "anthropic-version": "2023-06-01" };
}

async function anthropic(model: ModelConfig, messages: ChatMessage[]): Promise<Completion> {
  if (!model.name) return { content: null, err: "model.name required" };
  const endpoint = model.endpoint || "https://api.anthropic.com/v1/messages";
  const { key } = auth.key(model);
  if (!key) return { content: null, err: "anthropic api key missing: set masterHand.model.apiKeyEnv" };
  const { decoded, err } = await postJson(endpoint, anthropicPayload(model, messages), anthropicHeaders(key), model.timeoutMs);
  if (!decoded) return { content: null, err };
  return anthropicContent(decoded);
}

// ---------- Provider normalization + routing ----------

const handlers: Record<string, (m: ModelConfig, msgs: ChatMessage[]) => Promise<Completion>> = {
  auto: ollama,
  openai_compatible: openaiCompatible,
  openrouter,
  ollama,
  anthropic,
};

function inferProvider(modelName: string | undefined): string {
  const name = (modelName ?? "").toLowerCase();
  if (/^gpt-?\d/.test(name) || /^o\d/.test(name)) return "openai_compatible";
  return "ollama";
}

function isOllamaCloudId(provider: string | undefined): boolean {
  return provider === "ollama_cloud" || provider === "ollama-cloud";
}

function normalizeProvider(provider: string | undefined): string {
  if (provider === "openai") return "openai_compatible";
  if (isOllamaCloudId(provider)) return "ollama";
  return provider ?? "auto";
}

export function applyProviderDefaults(model: Partial<ModelConfig>): ModelConfig {
  const out: ModelConfig = {
    timeoutMs: 60000,
    temperature: 0.2,
    maxTokens: 1200,
    ...structuredClone(model),
    provider: model.provider ?? (model.name ? inferProvider(model.name) : "auto"),
  };
  const cloud = isOllamaCloudId(out.provider);
  out.provider = normalizeProvider(out.provider);
  if (cloud) {
    out.endpoint = out.endpoint || "https://ollama.com/api/chat";
    out.apiKeyEnv = out.apiKeyEnv || "OLLAMA_API_KEY";
  } else if (out.provider === "openai_compatible") {
    out.endpoint = out.endpoint || "https://api.openai.com/v1/chat/completions";
    out.apiKeyEnv = out.apiKeyEnv || "OPENAI_API_KEY";
  } else if (out.provider === "openrouter") {
    out.apiKeyEnv = out.apiKeyEnv || "OPENROUTER_API_KEY";
  } else if (out.provider === "anthropic") {
    out.apiKeyEnv = out.apiKeyEnv || "ANTHROPIC_API_KEY";
  }
  return out;
}

export function isCloudModel(model: RankedCandidate | ModelConfig): boolean {
  const m = model as RankedCandidate;
  if (m.cloud !== undefined) return m.cloud === true;
  if (m.isLocal === true) return false;
  const provider = m.provider;
  if (provider === "auto") return false;
  if (provider === "ollama") {
    const endpoint = m.endpoint || "http://localhost:11434/api/chat";
    return !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(endpoint);
  }
  return (
    provider === "openai_compatible" ||
    provider === "openrouter" ||
    provider === "anthropic" ||
    auth.isAccountProvider(provider)
  );
}

function rankValue(model: RankedCandidate): number {
  const n = Number(model.rank ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function commonModel(model: ModelConfig): Partial<ModelConfig> {
  const out = { ...model } as Record<string, unknown>;
  for (const key of [
    "ranked", "rankingModel", "selection", "cloudPolicy", "provider", "name", "endpoint",
    "apiKeyEnv", "apiKey", "executable", "command", "loginCommand", "rank", "isLocal", "cloud",
  ]) {
    delete out[key];
  }
  return out as Partial<ModelConfig>;
}

interface RoutedCandidate extends ModelConfig {
  _rankIndex: number;
  rank?: number;
  isLocal?: boolean;
  cloud?: boolean;
}

function routedCandidates(model: ModelConfig): RoutedCandidate[] | null {
  if (model.selection === "fixed") return null;
  const ranked = model.ranked;
  if (!Array.isArray(ranked) || ranked.length === 0) return null;

  const common = commonModel(model);
  const candidates: RoutedCandidate[] = ranked
    .filter((c) => typeof c === "object" && c !== null)
    .map((candidate, index) => ({
      ...applyProviderDefaults({ ...common, ...candidate }),
      rank: candidate.rank,
      isLocal: candidate.isLocal,
      cloud: candidate.cloud,
      selection: "fixed" as const,
      _rankIndex: index,
    }));

  const bestFirst = model.cloudPolicy === "best";
  candidates.sort((a, b) => {
    if (!bestFirst) {
      const aCloud = isCloudModel(a);
      const bCloud = isCloudModel(b);
      if (aCloud !== bCloud) return aCloud ? 1 : -1;
    }
    const ar = rankValue(a);
    const br = rankValue(b);
    if (ar !== br) return br - ar;
    return a._rankIndex - b._rankIndex;
  });
  return candidates;
}

function modelLabel(model: ModelConfig): string {
  return `${model.provider ?? "?"}/${model.name ?? "auto"}`;
}

async function completeOne(model: ModelConfig, messages: ChatMessage[]): Promise<Completion> {
  if (model.provider === "none") return { content: null, err: "model provider disabled" };
  const handler = handlers[model.provider];
  if (handler) return handler(model, messages);
  if (auth.isAccountProvider(model.provider)) return accountCli(model, messages);
  return { content: null, err: "provider not implemented: " + String(model.provider) };
}

function requestExcerpt(messages: ChatMessage[]): string {
  let text = messagesPrompt(messages).replace(/\s+/g, " ");
  if (text.length > 2000) text = text.slice(0, 2000) + "…";
  return text;
}

function rankingRequest(model: ModelConfig, messages: ChatMessage[], candidates: RoutedCandidate[]): ChatMessage[] {
  const instruction = model.cloudPolicy === "best"
    ? "Pick strongest best-fit model candidate for this request. Return only one number."
    : "Pick best model candidate for this request. Prefer local models unless task clearly needs stronger cloud reasoning. Return only one number.";
  const lines = [instruction, "Request: " + requestExcerpt(messages), "Candidates:"];
  candidates.forEach((candidate, i) => {
    lines.push(
      `${i + 1}. provider=${candidate.provider} name=${candidate.name ?? "auto"} local=${!isCloudModel(candidate)} rank=${rankValue(candidate)}`,
    );
  });
  return [{ role: "user", content: lines.join("\n") }];
}

function defaultRankingModel(model: ModelConfig, candidates: RoutedCandidate[]): ModelConfig | null {
  if (model.rankingModel && typeof model.rankingModel === "object") {
    return applyProviderDefaults({ ...commonModel(model), ...model.rankingModel, selection: "fixed" });
  }
  let best: RoutedCandidate | null = null;
  for (const candidate of candidates) {
    if (isCloudModel(candidate) && (!best || rankValue(candidate) > rankValue(best))) best = candidate;
  }
  if (!best) return null;
  const ranker: ModelConfig = { ...best };
  ranker.selection = "fixed";
  ranker.maxTokens = Math.min(Number(model.rankingMaxTokens ?? ranker.maxTokens ?? 24) || 24, 64);
  ranker.temperature = 0;
  return ranker;
}

function reorderCandidates(candidates: RoutedCandidate[], picked: string | null): RoutedCandidate[] {
  const n = Number((picked ?? "").match(/\d+/)?.[0]);
  if (!n || !candidates[n - 1]) return candidates;
  return [candidates[n - 1], ...candidates.filter((_, i) => i !== n - 1)];
}

async function cloudRank(model: ModelConfig, messages: ChatMessage[], candidates: RoutedCandidate[]): Promise<RoutedCandidate[]> {
  const ranker = defaultRankingModel(model, candidates);
  if (!ranker || !isCloudModel(ranker)) return candidates;
  const { content } = await completeOne(ranker, rankingRequest(model, messages, candidates));
  return reorderCandidates(candidates, content);
}

async function completeRouted(model: ModelConfig, messages: ChatMessage[], candidates: RoutedCandidate[]): Promise<Completion> {
  const errors: string[] = [];
  for (const candidate of await cloudRank(model, messages, candidates)) {
    const { content, err } = await completeOne(candidate, messages);
    if (content) return { content };
    errors.push(modelLabel(candidate) + " " + String(err));
  }
  return { content: null, err: "all routed model candidates failed: " + errors.join("; ") };
}

export async function complete(baseModel: ModelConfig, messages: ChatMessage[], opts?: Partial<ModelConfig>): Promise<Completion> {
  const model = applyProviderDefaults({ ...baseModel, ...(opts ?? {}) });
  const candidates = routedCandidates(model);
  if (candidates) return completeRouted(model, messages, candidates);
  return completeOne(model, messages);
}

// ---------- Model listing (models.dev catalog + provider endpoints) ----------

export interface ModelListItem {
  id: string;
  context?: number;
  max_output?: number;
  reasoning?: boolean;
  cost_input?: number;
  cost_output?: number;
  release_date?: string;
}

const listModelsTimeoutMs = 8000;

// Extract model ids from a provider model-list response. Anthropic, OpenAI, and
// OpenRouter return {data: [{id}]}; Ollama's /api/tags returns {models: [{name}]}.
export function parseModelIds(decoded: unknown): string[] | null {
  const d = decoded as { data?: unknown; models?: unknown };
  const items = Array.isArray(d?.data) ? d.data : Array.isArray(d?.models) ? d.models : null;
  if (!items) return null;
  const names: string[] = [];
  for (const item of items) {
    const id = (item as { id?: unknown; name?: unknown })?.id ?? (item as { name?: unknown })?.name;
    if (typeof id === "string" && id !== "") names.push(id);
  }
  return names.length > 0 ? names : null;
}

// Direct fetch from the provider's own model-list endpoint. Fallback path when
// models.dev is unreachable or does not cover the provider.
async function listModelsDirect(model: ModelConfig): Promise<{ items: ModelListItem[] | null; err?: string }> {
  const provider = model.provider;
  const { key } = auth.key(model);
  let url: string;
  let headers: Record<string, string>;
  if (provider === "anthropic") {
    if (!key) return { items: null, err: "anthropic api key missing: set masterHand.model.apiKeyEnv" };
    url = "https://api.anthropic.com/v1/models?limit=1000";
    headers = anthropicHeaders(key);
  } else if (provider === "openrouter") {
    // OpenRouter's model list is public; the key is optional here.
    url = "https://openrouter.ai/api/v1/models";
    headers = key ? { Authorization: "Bearer " + key } : {};
  } else if (provider === "openai_compatible") {
    const chat = model.endpoint || "https://api.openai.com/v1/chat/completions";
    url = chat.replace(/\/chat\/completions\/?$/, "/models");
    if (url === chat) return { items: null, err: "cannot derive models endpoint from " + chat };
    headers = key ? { Authorization: "Bearer " + key } : {};
  } else if (provider === "ollama" && model.endpoint && /ollama\.com/.test(model.endpoint)) {
    if (!key) return { items: null, err: "ollama cloud api key missing: set masterHand.model.apiKeyEnv" };
    url = "https://ollama.com/api/tags";
    headers = { Authorization: "Bearer " + key };
  } else {
    return { items: null, err: "model listing not supported for provider " + String(provider) };
  }
  const { decoded, err } = await fetchJson(url, { headers }, listModelsTimeoutMs);
  if (!decoded) return { items: null, err };
  const ids = parseModelIds(decoded);
  if (!ids) return { items: null, err: "provider returned no model list" };
  return { items: ids.map((id) => ({ id })) };
}

function modelsDevProviderId(model: ModelConfig): string | null {
  const provider = model.provider;
  if (provider === "anthropic") return "anthropic";
  if (provider === "openrouter") return "openrouter";
  if (provider === "openai_compatible" && (!model.endpoint || /api\.openai\.com/.test(model.endpoint))) return "openai";
  return null;
}

// Session cache of the models.dev catalog; one fetch covers every provider.
// Failures are not cached in memory so a later attempt can retry.
let modelsDev: { catalog: unknown | null; err?: string; done: boolean; pending: Promise<{ catalog: unknown | null; err?: string }> | null } = {
  catalog: null,
  done: false,
  pending: null,
};

export function _resetModelsDevCache(): void {
  modelsDev = { catalog: null, done: false, pending: null };
}

// The catalog is also persisted to disk so model lists work offline: a fresh
// copy (younger than the TTL) skips the network entirely, and a stale copy is
// served when the fetch fails. Path is injected by the extension (globalStorage).
const modelsDevCacheTtlS = 24 * 60 * 60;
export let modelsDevCacheFile: string | null = null;
export function setModelsDevCacheFile(p: string | null): void {
  modelsDevCacheFile = p;
}

function readModelsDevCache(): { catalog: unknown; fetchedAt: number } | null {
  if (!modelsDevCacheFile) return null;
  try {
    const wrapper = JSON.parse(fs.readFileSync(modelsDevCacheFile, "utf8"));
    if (typeof wrapper !== "object" || wrapper === null || typeof wrapper.catalog !== "object" || wrapper.catalog === null) return null;
    return { catalog: wrapper.catalog, fetchedAt: Number(wrapper.fetched_at) };
  } catch {
    return null;
  }
}

function writeModelsDevCache(catalog: unknown): void {
  if (!modelsDevCacheFile) return;
  try {
    fs.mkdirSync(path.dirname(modelsDevCacheFile), { recursive: true });
    fs.writeFileSync(modelsDevCacheFile, JSON.stringify({ fetched_at: Math.floor(Date.now() / 1000), catalog }));
  } catch {
    // Cache write failure only costs a refetch later.
  }
}

async function fetchModelsDev(): Promise<{ catalog: unknown | null; err?: string }> {
  if (modelsDev.done) return { catalog: modelsDev.catalog, err: modelsDev.err };
  if (modelsDev.pending) return modelsDev.pending;
  const cached = readModelsDevCache();
  if (cached && Number.isFinite(cached.fetchedAt) && Math.floor(Date.now() / 1000) - cached.fetchedAt < modelsDevCacheTtlS) {
    modelsDev.done = true;
    modelsDev.catalog = cached.catalog;
    return { catalog: cached.catalog };
  }
  modelsDev.pending = (async () => {
    let { decoded, err } = await fetchJson("https://models.dev/api.json", {}, listModelsTimeoutMs);
    if (decoded) {
      writeModelsDevCache(decoded);
    } else if (cached) {
      // Offline or fetch failure: serve the stale disk copy rather than nothing.
      decoded = cached.catalog;
      err = undefined;
    }
    modelsDev.done = decoded !== null && decoded !== undefined;
    modelsDev.catalog = decoded ?? null;
    modelsDev.err = err;
    modelsDev.pending = null;
    return { catalog: modelsDev.catalog, err };
  })();
  return modelsDev.pending;
}

// Extract one provider's models from a models.dev catalog, newest release first.
export function parseModelsDev(catalog: unknown, providerId: string): ModelListItem[] | null {
  const provider = (catalog as Record<string, unknown> | null)?.[providerId] as { models?: Record<string, unknown> } | undefined;
  const models = provider?.models;
  if (typeof models !== "object" || models === null) return null;
  const items: ModelListItem[] = [];
  for (const [id, raw] of Object.entries(models)) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as { id?: unknown; limit?: { context?: unknown; output?: unknown }; cost?: { input?: unknown; output?: unknown }; reasoning?: unknown; release_date?: unknown };
    const limit = typeof m.limit === "object" && m.limit !== null ? m.limit : {};
    const cost = typeof m.cost === "object" && m.cost !== null ? m.cost : {};
    items.push({
      id: typeof m.id === "string" ? m.id : id,
      context: Number((limit as { context?: unknown }).context) || undefined,
      max_output: Number((limit as { output?: unknown }).output) || undefined,
      reasoning: m.reasoning === true,
      cost_input: Number((cost as { input?: unknown }).input) || undefined,
      cost_output: Number((cost as { output?: unknown }).output) || undefined,
      release_date: typeof m.release_date === "string" ? m.release_date : undefined,
    });
  }
  if (items.length === 0) return null;
  items.sort((a, b) => {
    if ((a.release_date ?? "") !== (b.release_date ?? "")) return (a.release_date ?? "") > (b.release_date ?? "") ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return items;
}

// List available models for an API provider. Primary source is the models.dev
// catalog (keyless, one fetch for all providers, carries context/cost metadata);
// the provider's own model-list endpoint is the fallback.
export async function listModels(model: ModelConfig): Promise<{ items: ModelListItem[] | null; err?: string }> {
  const devId = modelsDevProviderId(model);
  if (!devId) return listModelsDirect(model);
  const { catalog, err: devErr } = await fetchModelsDev();
  const items = catalog ? parseModelsDev(catalog, devId) : null;
  if (items) return { items };
  const direct = await listModelsDirect(model);
  if (direct.items) return direct;
  return { items: null, err: direct.err ?? devErr };
}
