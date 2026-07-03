// Headless unit tests over the compiled core modules (no VS Code API).
// Run with: npm test   (compiles first, then executes this file)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = (name) => require(path.join(root, "out", "core", name + ".js"));

const paths = core("paths");
const schema = core("schema");
const heuristics = core("heuristics");
const runner = core("runner");
const testcmd = core("testcmd");
const diffsafety = core("diffsafety");
const providers = core("providers");
const agentPrompt = core("agentPrompt");
const repoindex = core("repoindex");
const search = core("search");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(e && e.stack ? e.stack : e);
  }
}

function defaultConfig(overrides = {}) {
  return {
    proactivity: "passive",
    suggestionFrequencyMs: 5000,
    observation: { buffers: true, edits: true, diagnostics: true, git: true },
    ignore: [".git/", "node_modules/", "dist/", "build/", "out/", ".env", ".env.*"],
    model: { provider: "none", timeoutMs: 60000, temperature: 0.2, maxTokens: 1200 },
    context: {
      maxFiles: 80, maxDiffBytes: 24000, maxFileBytes: 12000, maxSearchResults: 40,
      maxModelCodeFiles: 8, maxModelFileBytes: 12000, includeRelatedFiles: true,
      includeSymbols: true, includeIndex: true, indexMaxFiles: 500,
      indexMaxFileBytes: 20000, indexMaxTodos: 40, indexMaxSymbols: 80,
    },
    commands: {
      allowlist: ["git", "make", "npm", "pnpm", "yarn", "cargo", "go", "pytest", "python", "node", "npx"],
      blocklist: ["rm", "sudo", "git reset", "git clean"],
      timeoutMs: 10000,
    },
    agent: { enabled: true, adapter: "auto" },
    storage: { enabled: false },
    ...overrides,
  };
}

function emptySnapshot(overrides = {}) {
  return {
    root: "/repo",
    branch: "main",
    goal: "",
    goal_source: "inferred",
    short_term_goal: "",
    short_term_goal_source: "inferred",
    long_term_goal: "",
    long_term_goal_source: "inferred",
    open_buffers: [],
    recent_edits: [],
    diagnostics: { errors: 0, warnings: 0, info: 0, hints: 0, files: {} },
    git_status: "",
    changed_files: [],
    changed: [],
    diff: "",
    repo_files: [],
    repo_index: {},
    related: [],
    symbols: [],
    feedback: {},
    ...overrides,
  };
}

// ---------- paths ----------

test("paths.normalize collapses separators", () => {
  assert.equal(paths.normalize("a\\b//c"), "a/b/c");
  assert.equal(paths.normalize(""), "");
});

test("paths.relative strips root prefix", () => {
  assert.equal(paths.relative("/repo", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(paths.relative("/repo", "/other/a.ts"), "/other/a.ts");
});

test("paths.isIgnored matches dirs, globs, and names", () => {
  const patterns = [".git/", "node_modules/", ".env", ".env.*", "*.lock"];
  assert.equal(paths.isIgnored(".git/config", patterns), true);
  assert.equal(paths.isIgnored("a/node_modules/x.js", patterns), true);
  assert.equal(paths.isIgnored(".env", patterns), true);
  assert.equal(paths.isIgnored("config/.env.local", patterns), true);
  assert.equal(paths.isIgnored("yarn.lock", patterns), true);
  assert.equal(paths.isIgnored("src/env.ts", patterns), false);
  assert.equal(paths.isIgnored("environment.ts", patterns), false);
});

test("paths.dedupe preserves first occurrence order", () => {
  assert.deepEqual(paths.dedupe(["a", "b", "a", "", null, "c"]), ["a", "b", "c"]);
});

// ---------- schema ----------

test("schema.suggestion normalizes and clamps", () => {
  const s = schema.suggestion({ title: "Do thing", confidence: 9, action_type: "evil" });
  assert.equal(s.id, "do-thing");
  assert.equal(s.confidence, 1);
  assert.equal(s.action_type, "advice");
  assert.equal(s.requires_approval, false);
});

test("schema.suggestion flags non-advice as requiring approval", () => {
  const s = schema.suggestion({ title: "Run tests", action_type: "command" });
  assert.equal(s.requires_approval, true);
});

test("schema rejects titleless and non-object items", () => {
  assert.equal(schema.suggestion({}), null);
  assert.equal(schema.suggestion("nope"), null);
  assert.deepEqual(schema.list("not a list"), []);
  assert.equal(schema.list([{ title: "ok" }, {}, null]).length, 1);
});

// ---------- heuristics ----------

test("heuristics: empty snapshot yields no-obstacle", () => {
  const out = heuristics.heuristic(emptySnapshot(), defaultConfig());
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "no-obstacle");
});

test("heuristics: merge conflict flagged first from status", () => {
  const snap = emptySnapshot({ changed: [{ status: "UU", file: "a.ts" }], changed_files: ["a.ts"] });
  const out = heuristics.heuristic(snap, defaultConfig());
  assert.equal(out[0].id, "merge-conflict");
});

test("heuristics: conflict markers in diff also flag", () => {
  const snap = emptySnapshot({ diff: "x\n<<<<<<< HEAD\ny\n" });
  const out = heuristics.heuristic(snap, defaultConfig());
  assert.equal(out[0].id, "merge-conflict");
});

test("heuristics: diagnostics errors produce suggestion", () => {
  const snap = emptySnapshot({ diagnostics: { errors: 2, warnings: 0, info: 0, hints: 0, files: {} } });
  const ids = heuristics.heuristic(snap, defaultConfig()).map((s) => s.id);
  assert.ok(ids.includes("diagnostics-errors"));
});

test("heuristics: oversized diff nudges reviewable slices", () => {
  const snap = emptySnapshot({ changed_files: Array.from({ length: 13 }, (_, i) => `f${i}.ts`) });
  const ids = heuristics.heuristic(snap, defaultConfig()).map((s) => s.id);
  assert.ok(ids.includes("oversized-diff"));
});

test("heuristics: source changed without tests when repo has tests", () => {
  const snap = emptySnapshot({
    changed_files: ["src/a.ts"],
    repo_files: ["src/a.ts", "tests/a.test.ts"],
  });
  const ids = heuristics.heuristic(snap, defaultConfig()).map((s) => s.id);
  assert.ok(ids.includes("tests-not-updated"));
});

test("heuristics: no test nag when tests were touched", () => {
  const snap = emptySnapshot({
    changed_files: ["src/a.ts", "tests/a.test.ts"],
    repo_files: ["src/a.ts", "tests/a.test.ts"],
  });
  const ids = heuristics.heuristic(snap, defaultConfig()).map((s) => s.id);
  assert.ok(!ids.includes("tests-not-updated"));
});

test("heuristics: warning hotspot in changed file", () => {
  const snap = emptySnapshot({
    changed_files: ["src/a.ts"],
    diagnostics: { errors: 0, warnings: 4, info: 0, hints: 0, files: { "src/a.ts": { errors: 0, warnings: 4, info: 0, hints: 0 } } },
  });
  const ids = heuristics.heuristic(snap, defaultConfig()).map((s) => s.id);
  assert.ok(ids.includes("diagnostics-hotspot"));
});

// ---------- runner ----------

test("runner.parseCommandLine handles quotes like VS Code input", () => {
  assert.deepEqual(runner.parseCommandLine('npm test -- --grep "auth flow"').argv, ["npm", "test", "--", "--grep", "auth flow"]);
  assert.deepEqual(runner.parseCommandLine("node 'scripts/my file.js'").argv, ["node", "scripts/my file.js"]);
  assert.deepEqual(runner.parseCommandLine("node C:\\Users\\me\\script.js").argv, ["node", "C:\\Users\\me\\script.js"]);
  assert.deepEqual(runner.parseCommandLine('node -e ""').argv, ["node", "-e", ""]);
  assert.equal(runner.parseCommandLine('npm "unterminated').argv, null);
});

test("runner.validate rejects shell strings and metacharacters", () => {
  const cfg = defaultConfig();
  assert.equal(runner.validate("npm test", cfg).argv, null);
  assert.equal(runner.validate(["npm", "test;rm"], cfg).argv, null);
  assert.equal(runner.validate(["npm", "test|x"], cfg).argv, null);
});

test("runner.validate blocks dangerous commands", () => {
  const cfg = defaultConfig();
  assert.equal(runner.validate(["rm", "-rf", "/"], cfg).argv, null);
  assert.equal(runner.validate(["sudo", "ls"], cfg).argv, null);
  assert.equal(runner.validate(["git", "reset", "--hard"], cfg).argv, null);
  assert.equal(runner.validate(["git", "clean", "-fd"], cfg).argv, null);
});

test("runner.validate blocklist matches tokens, not substrings", () => {
  const cfg = defaultConfig();
  // "git reset" rule must not block commands that merely mention reset inside a path
  assert.ok(runner.validate(["git", "status"], cfg).argv);
  assert.ok(runner.validate(["git", "log", "--", "reset-notes.md"], cfg).argv);
});

test("runner.validate enforces allowlist", () => {
  const cfg = defaultConfig();
  assert.ok(runner.validate(["npm", "test"], cfg).argv);
  assert.equal(runner.validate(["curl", "http"], cfg).argv, null);
});

// ---------- testcmd ----------

test("testcmd.infer detects package.json test script and lockfiles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }));
  assert.deepEqual(testcmd.infer(dir).argv, ["npm", "test"]);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  assert.deepEqual(testcmd.infer(dir).argv, ["pnpm", "test"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("testcmd.infer detects cargo/go/pytest/make", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-test-"));
  fs.writeFileSync(path.join(dir, "Cargo.toml"), "");
  assert.deepEqual(testcmd.infer(dir).argv, ["cargo", "test"]);
  fs.rmSync(path.join(dir, "Cargo.toml"));
  fs.writeFileSync(path.join(dir, "go.mod"), "");
  assert.deepEqual(testcmd.infer(dir).argv, ["go", "test", "./..."]);
  fs.rmSync(path.join(dir, "go.mod"));
  fs.writeFileSync(path.join(dir, "Makefile"), "build:\n\ttrue\ntest:\n\ttrue\n");
  assert.deepEqual(testcmd.infer(dir).argv, ["make", "test"]);
  fs.rmSync(path.join(dir, "Makefile"));
  fs.writeFileSync(path.join(dir, "Makefile"), "pretest:\n\ttrue\n");
  assert.equal(testcmd.infer(dir).argv, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- diffsafety ----------

const okDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;

test("diffsafety accepts a plain repo-relative diff", () => {
  assert.equal(diffsafety.unsafe(okDiff, defaultConfig()), null);
});

test("diffsafety rejects escapes, binary, quoted, ignored", () => {
  const cfg = defaultConfig();
  assert.ok(diffsafety.unsafe("", cfg));
  assert.ok(diffsafety.unsafe(okDiff.replace(/src\/a\.ts/g, "../evil.ts"), cfg));
  assert.ok(diffsafety.unsafe(okDiff.replace(/src\/a\.ts/g, "/etc/passwd"), cfg));
  assert.ok(diffsafety.unsafe(okDiff.replace(/src\/a\.ts/g, ".git/config"), cfg));
  assert.ok(diffsafety.unsafe(okDiff.replace(/src\/a\.ts/g, ".env"), cfg));
  assert.ok(diffsafety.unsafe(okDiff + "GIT binary patch\n", cfg));
  assert.ok(diffsafety.unsafe('diff --git "a/we ird" "b/we ird"\n', cfg));
});

// ---------- providers (pure parsing + routing helpers) ----------

test("providers.parseOllamaNames prefers coder/qwen models", () => {
  const stdout = "NAME SIZE\nllama3:latest 4GB\nqwen3-coder:latest 9GB\nmistral:latest 4GB\n";
  assert.deepEqual(providers.parseOllamaNames(stdout), ["qwen3-coder:latest", "llama3:latest", "mistral:latest"]);
});

test("providers.parseModelIds handles data/models shapes", () => {
  assert.deepEqual(providers.parseModelIds({ data: [{ id: "m1" }, { id: "m2" }] }), ["m1", "m2"]);
  assert.deepEqual(providers.parseModelIds({ models: [{ name: "t1" }] }), ["t1"]);
  assert.equal(providers.parseModelIds({}), null);
});

test("providers.parseModelsDev sorts newest release first", () => {
  const catalog = {
    anthropic: {
      models: {
        "old-model": { id: "old-model", release_date: "2024-01-01", limit: { context: 200000 }, cost: { input: 3, output: 15 } },
        "new-model": { id: "new-model", release_date: "2026-01-01", reasoning: true },
      },
    },
  };
  const items = providers.parseModelsDev(catalog, "anthropic");
  assert.equal(items[0].id, "new-model");
  assert.equal(items[0].reasoning, true);
  assert.equal(items[1].context, 200000);
  assert.equal(providers.parseModelsDev(catalog, "missing"), null);
});

test("providers.applyProviderDefaults fills endpoints and env vars", () => {
  const m1 = providers.applyProviderDefaults({ provider: "openai" });
  assert.equal(m1.provider, "openai_compatible");
  assert.equal(m1.apiKeyEnv, "OPENAI_API_KEY");
  const m2 = providers.applyProviderDefaults({ provider: "ollama-cloud" });
  assert.equal(m2.provider, "ollama");
  assert.equal(m2.endpoint, "https://ollama.com/api/chat");
  const m3 = providers.applyProviderDefaults({ name: "gpt-4.1-mini" });
  assert.equal(m3.provider, "openai_compatible");
});

test("providers.isCloudModel distinguishes local ollama from cloud", () => {
  assert.equal(providers.isCloudModel({ provider: "ollama" }), false);
  assert.equal(providers.isCloudModel({ provider: "ollama", endpoint: "https://ollama.com/api/chat" }), true);
  assert.equal(providers.isCloudModel({ provider: "anthropic" }), true);
  assert.equal(providers.isCloudModel({ provider: "anthropic", isLocal: true }), false);
});

test("providers.messagesPrompt flattens roles", () => {
  const text = providers.messagesPrompt([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.ok(text.includes("system:\nsys"));
  assert.ok(text.includes("user:\nhi"));
});

// ---------- agent prompt / argv ----------

test("agentPrompt.agentArgv expands $ and {vars}, keeps embedded $ literal", () => {
  const { argv } = agentPrompt.agentArgv({ enabled: true, adapter: "auto", command: ["run", "--cwd", "{root}", "$", "A=$B"] }, "the prompt", "/repo");
  assert.deepEqual(argv, ["run", "--cwd", "/repo", "the prompt", "A=$B"]);
});

test("agentPrompt.agentArgv defaults: codex adapter uses codex exec", () => {
  const { argv } = agentPrompt.agentArgv({ enabled: true, adapter: "codex" }, "p", "/repo");
  assert.deepEqual(argv, ["codex", "exec", "p"]);
});

test("agentPrompt.buildPrompt includes workspace intent and constraints", () => {
  const prompt = agentPrompt.buildPrompt(
    { id: "x", title: "T", reason: "R", files: ["a.ts"], confidence: 0.5, next_action: "N", action_type: "advice", requires_approval: false },
    "/repo",
    { long_term_goal: "LT", short_term_goal: "ST", changed_files: ["a.ts"] },
  );
  assert.ok(prompt.includes("Project goal: LT"));
  assert.ok(prompt.includes("Current focus: ST"));
  assert.ok(prompt.includes("Approved suggestion"));
  assert.ok(prompt.includes("Do not commit, push"));
});

// ---------- repoindex ----------

test("repoindex.build counts languages, tests, docs, todos", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-index-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "src", "main.ts"), "function hello() {}\n// TODO: finish\n");
  fs.writeFileSync(path.join(dir, "tests", "main.test.ts"), "function t() {}\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  const idx = repoindex.build(dir, ["src/main.ts", "tests/main.test.ts", "README.md"], defaultConfig());
  assert.equal(idx.files_seen, 3);
  assert.equal(idx.languages.TypeScript, 2);
  assert.deepEqual(idx.tests, ["tests/main.test.ts"]);
  assert.deepEqual(idx.docs, ["README.md"]);
  assert.equal(idx.todos.length, 1);
  assert.ok(idx.symbols.some((s) => s.name === "hello"));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- search helpers ----------

test("search.goalTerms extracts unique 4+ char terms", () => {
  assert.deepEqual(search.goalTerms("Fix the auth auth redirect bug"), ["auth", "redirect"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
