// Approval-gated command validation and execution. Shell strings stay blocked.
import { execFile } from "node:child_process";
import { MHConfig } from "./types";

const blocked = new Set(["rm", "sudo", "shutdown", "reboot"]);
const badChars = /[|&;<>`]/;

export function parseCommandLine(raw: string): { argv: string[] | null; err?: string } {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;
  const input = raw.trim();

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (ch === "\\" && next && (next === "\\" || next === '"' || next === "'" || /\s/.test(next))) {
      current += next;
      tokenStarted = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      tokenStarted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        argv.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  if (quote) return { argv: null, err: "unterminated quote" };
  if (tokenStarted) argv.push(current);
  if (argv.length === 0) return { argv: null, err: "command is empty" };
  return { argv };
}

function hasSubcommand(argv: string[], command: string, subcommand: string): boolean {
  if (argv[0] !== command) return false;
  return argv.slice(1).includes(subcommand);
}

// Match blocklist entries by argv tokens, not substrings, to avoid false positives.
function isBlocked(argv: string[], rule: string): boolean {
  const parts = rule.split(/\s+/).filter((p) => p !== "");
  if (parts.length === 1) return argv[0] === parts[0];
  if (argv[0] !== parts[0]) return false;
  return parts.slice(1).every((p) => hasSubcommand(argv, parts[0], p));
}

// Validate before enqueue/run. Only argv-style commands are considered safe.
export function validate(argv: unknown, config: MHConfig): { argv: string[] | null; err?: string } {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
    return { argv: null, err: "command must be argv/list of strings" };
  }
  const cmd = argv as string[];
  if (blocked.has(cmd[0])) return { argv: null, err: "blocked command: " + cmd[0] };
  for (const rule of config.commands.blocklist ?? []) {
    if (isBlocked(cmd, rule)) return { argv: null, err: "blocked command: " + rule };
  }
  if (cmd[0] === "git") {
    for (const part of cmd) {
      if (part === "clean" || part === "reset") return { argv: null, err: "blocked command: git " + part };
    }
  }
  for (const part of cmd) {
    if (badChars.test(part)) return { argv: null, err: "shell metacharacters blocked" };
  }
  const allow = config.commands.allowlist ?? [];
  if (allow.length > 0 && !allow.includes(cmd[0])) {
    return { argv: null, err: "command not allowlisted: " + cmd[0] };
  }
  return { argv: cmd };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  argv: string[];
}

export function run(root: string, argv: unknown, config: MHConfig): Promise<{ result: RunResult | null; err?: string }> {
  const { argv: ok, err } = validate(argv, config);
  if (!ok) return Promise.resolve({ result: null, err });
  const timeout = config.commands.timeoutMs || config.model.timeoutMs;
  return new Promise((resolve) => {
    const child = execFile(
      ok[0],
      ok.slice(1),
      { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const rawCode: unknown = error ? (error as NodeJS.ErrnoException & { code?: unknown }).code ?? 1 : 0;
        const out: RunResult = {
          code: typeof rawCode === "number" ? rawCode : 1,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          argv: ok,
        };
        if (error) {
          const detail = (stderr ?? "").trim() || (stdout ?? "").trim() || String(error.message);
          resolve({ result: null, err: `exit ${out.code}: ${detail}` });
        } else {
          resolve({ result: out });
        }
      },
    );
    child.on("error", (e) => resolve({ result: null, err: String(e) }));
  });
}
