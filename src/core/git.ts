// Thin async git wrapper for repo root, status, diffs, and tracked files.
// argv arrays only; no shell strings. Failures degrade to "" / [].
import { execFile } from "node:child_process";
import { ChangedFile, MHConfig } from "./types";
import { isIgnored } from "./paths";

function timeoutMs(config: MHConfig): number {
  return Math.min(config.commands.timeoutMs || 10000, 3000);
}

function run(root: string | undefined, args: string[], config: MHConfig, input?: string): Promise<string> {
  return new Promise((resolve) => {
    if (!root) return resolve("");
    const child = execFile(
      "git",
      ["-C", root, ...args],
      { timeout: timeoutMs(config), maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => resolve(err ? "" : stdout ?? ""),
    );
    child.on("error", () => resolve(""));
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export function root(cwd: string, config: MHConfig): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: timeoutMs(config), encoding: "utf8" },
      (err, stdout) => resolve(err ? cwd : (stdout ?? "").trim() || cwd),
    );
    child.on("error", () => resolve(cwd));
  });
}

export async function branch(root: string, config: MHConfig): Promise<string> {
  return (await run(root, ["branch", "--show-current"], config)).trim();
}

function parseStatus(out: string, config: MHConfig): ChangedFile[] {
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < out.length) {
    const nul = out.indexOf("\0", i);
    if (nul === -1) break;
    const entry = out.slice(i, nul);
    i = nul + 1;
    if (entry !== "") {
      const status = entry.slice(0, 2);
      const file = entry.slice(3);
      if (status.includes("R") || status.includes("C")) {
        // Renames/copies carry a second NUL-terminated origin path; skip it.
        const nextNul = out.indexOf("\0", i);
        i = nextNul === -1 ? out.length : nextNul + 1;
      }
      if (file !== "" && !isIgnored(file, config.ignore)) files.push({ status, file });
    }
  }
  return files;
}

export async function changedFiles(root: string, config: MHConfig): Promise<ChangedFile[]> {
  return parseStatus(await run(root, ["status", "--porcelain=v1", "-z"], config), config);
}

function truncateDiff(out: string, maxBytes: number): string {
  if (out.length > maxBytes) return out.slice(0, maxBytes) + "\n[diff truncated]";
  return out;
}

// Per-file diff over an explicit file list, sequential so a large change set
// never fans out into many concurrent git processes.
export async function diff(root: string, files: string[] | undefined, maxBytes: number, config: MHConfig): Promise<string> {
  let list = files;
  if (!list) list = (await changedFiles(root, config)).map((c) => c.file);
  const chunks: string[] = [];
  for (const f of list) {
    if (isIgnored(f, config.ignore)) continue;
    const withStaged = await run(root, ["diff", "HEAD", "--", f], config);
    chunks.push(withStaged !== "" ? withStaged : await run(root, ["diff", "--", f], config));
  }
  return truncateDiff(chunks.join("\n"), maxBytes);
}

// Staged diff honors the ignore list like every other diff path, so staged
// .env/secret files never reach model providers.
export async function stagedDiff(root: string, maxBytes: number, config: MHConfig): Promise<string> {
  const names = await run(root, ["diff", "--cached", "--name-only", "-z"], config);
  const chunks: string[] = [];
  for (const f of names.split("\0")) {
    if (f === "" || isIgnored(f, config.ignore)) continue;
    const out = await run(root, ["diff", "--cached", "--", f], config);
    if (out !== "") chunks.push(out);
  }
  return truncateDiff(chunks.join("\n"), maxBytes);
}

export async function lsFiles(root: string, limit: number | undefined, config: MHConfig): Promise<string[]> {
  const raw = await run(root, ["ls-files"], config);
  const out: string[] = [];
  for (const file of raw.split("\n")) {
    if (file === "" || isIgnored(file, config.ignore)) continue;
    out.push(file);
    if (limit && out.length >= limit) break;
  }
  return out;
}

// git apply with stdin; used for diff --check and apply after approval.
export function apply(root: string, diffText: string, check: boolean, config: MHConfig): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const args = check ? ["-C", root, "apply", "--check", "-"] : ["-C", root, "apply", "-"];
    const child = execFile(
      "git",
      args,
      { timeout: config.model.timeoutMs, encoding: "utf8" },
      (err, _stdout, stderr) => resolve({ ok: !err, err: (stderr ?? "").trim() || (err ? String(err.message) : "") }),
    );
    child.on("error", (e) => resolve({ ok: false, err: String(e) }));
    child.stdin?.write(diffText);
    child.stdin?.end();
  });
}
