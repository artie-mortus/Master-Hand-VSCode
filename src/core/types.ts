// Shared shapes for config, context snapshots, and suggestions.
// Core modules never import "vscode" so headless tests can exercise them.

export interface ModelConfig {
  provider: string; // none | auto | openai_compatible | openrouter | ollama | anthropic | pi | codex | claude | gemini | cli
  name?: string;
  endpoint?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  executable?: string;
  command?: string[]; // argv template; "$" or {prompt} = prompt; shell strings rejected
  loginCommand?: string[];
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  selection?: "auto" | "fixed";
  cloudPolicy?: "fallback" | "best";
  ranked?: RankedCandidate[];
  rankingModel?: Partial<ModelConfig> | null;
  rankingMaxTokens?: number;
}

export interface RankedCandidate extends Partial<ModelConfig> {
  rank?: number;
  isLocal?: boolean;
  cloud?: boolean;
}

export interface ContextConfig {
  maxFiles: number;
  maxDiffBytes: number;
  maxFileBytes: number;
  maxSearchResults: number;
  maxModelCodeFiles: number;
  maxModelFileBytes: number;
  includeRelatedFiles: boolean;
  includeSymbols: boolean;
  includeIndex: boolean;
  indexMaxFiles: number;
  indexMaxFileBytes: number;
  indexMaxTodos: number;
  indexMaxSymbols: number;
}

export interface MHConfig {
  proactivity: "passive" | "advisory";
  suggestionFrequencyMs: number;
  observation: { buffers: boolean; edits: boolean; diagnostics: boolean; git: boolean };
  ignore: string[];
  model: ModelConfig;
  context: ContextConfig;
  commands: { allowlist: string[]; blocklist: string[]; timeoutMs: number };
  agent: { enabled: boolean; adapter: string; executable?: string; command?: string[] };
  updates: { enabled: boolean; checkIntervalHours: number };
  storage: { enabled: boolean };
}

export interface ChangedFile {
  status: string;
  file: string;
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  info: number;
  hints: number;
  files: Record<string, { errors: number; warnings: number; info: number; hints: number }>;
}

export interface RecentEdit {
  file: string;
  line: string;
  time: number;
}

export interface SearchHit {
  file: string;
  lnum: number;
  col: number;
  text: string;
  term?: string;
}

export interface RepoIndex {
  files_seen: number;
  dirs: Record<string, number>;
  languages: Record<string, number>;
  extensions: Record<string, number>;
  largest_files: { file: string; bytes: number }[];
  entrypoints: string[];
  tests: string[];
  docs: string[];
  todos: { file: string; lnum: number; text: string }[];
  symbols: { file: string; name: string }[];
}

export interface Snapshot {
  root: string;
  branch: string;
  goal: string;
  goal_source: string;
  short_term_goal: string;
  short_term_goal_source: string;
  long_term_goal: string;
  long_term_goal_source: string;
  open_buffers: string[];
  recent_edits: RecentEdit[];
  diagnostics: DiagnosticCounts;
  git_status: string;
  changed_files: string[];
  changed: ChangedFile[];
  diff: string;
  repo_files: string[];
  repo_index: RepoIndex | Record<string, never>;
  related: SearchHit[];
  symbols: { name: string; lnum: number; kind: string }[];
  feedback: Record<string, string>;
  code?: { file: string; text: string }[];
}

export type ActionType = "advice" | "proposed_edit" | "command";

export interface Suggestion {
  id: string;
  title: string;
  reason: string;
  files: string[];
  confidence: number;
  next_action: string;
  action_type: ActionType;
  requires_approval: boolean;
  command?: unknown;
  diff_request?: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PendingAction {
  id: string;
  status: "pending" | "approved" | "rejected" | "done" | "failed";
  kind: "command" | "diff";
  title: string;
  argv?: string[];
  diff?: string;
  root: string;
}
