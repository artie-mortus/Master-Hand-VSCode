// Ripgrep helpers for related files and repo search. rg is optional; every
// search degrades to [] when it is missing or fails.
import { execFile } from "node:child_process";
import { MHConfig, SearchHit } from "./types";
import { isIgnored } from "./paths";

const MAX_GOAL_TERMS = 8;

function timeoutMs(config: MHConfig): number {
  return Math.min(config.commands.timeoutMs || 10000, 3000);
}

function ignoredArgs(config: MHConfig): string[] {
  const args: string[] = [];
  for (const pat of config.ignore ?? []) {
    args.push("--glob", "!" + pat);
  }
  return args;
}

function runRg(root: string, args: string[], config: MHConfig): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      "rg",
      args,
      { cwd: root, timeout: timeoutMs(config), maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      // rg exits 1 on "no matches" with empty stdout; both degrade to "".
      (err, stdout) => resolve(err && !stdout ? "" : stdout ?? ""),
    );
    child.on("error", () => resolve(""));
  });
}

function parseRg(stdout: string, limit: number, config: MHConfig): SearchHit[] {
  const out: SearchHit[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([^:]+):(\d+):(\d+):(.*)$/);
    if (m && !isIgnored(m[1], config.ignore)) {
      out.push({ file: m[1], lnum: Number(m[2]), col: Number(m[3]), text: m[4].trim() });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function rg(root: string, query: string, limit: number, config: MHConfig): Promise<SearchHit[]> {
  if (!query) return [];
  // -e keeps a query starting with "-" from being parsed as an rg flag.
  const args = [
    "--line-number", "--column", "--no-heading", "--smart-case", "--max-count", "5",
    ...ignoredArgs(config), "-e", query,
  ];
  return parseRg(await runRg(root, args, config), limit || 40, config);
}

export async function rgMatches(root: string, pattern: string, limit: number, config: MHConfig): Promise<SearchHit[]> {
  if (!pattern) return [];
  const args = ["--vimgrep", "--no-heading", "--smart-case", ...ignoredArgs(config), "-e", pattern];
  return parseRg(await runRg(root, args, config), limit || 100, config);
}

export function goalTerms(goal: string | undefined): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const word of String(goal ?? "").match(/[\w\-]+/g) ?? []) {
    if (word.length >= 4 && !seen.has(word.toLowerCase())) {
      seen.add(word.toLowerCase());
      terms.push(word);
    }
  }
  return terms;
}

// Terms run one rg at a time (bounded to MAX_GOAL_TERMS) so a snapshot never
// fans out into parallel rg processes.
export async function relatedToGoal(root: string, goal: string, limit: number, config: MHConfig): Promise<SearchHit[]> {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const terms = goalTerms(goal).slice(0, MAX_GOAL_TERMS);
  for (const term of terms) {
    const hits = await rg(root, term, limit || 20, config);
    for (const hit of hits) {
      const key = `${hit.file}:${hit.lnum}`;
      if (!seen.has(key)) {
        seen.add(key);
        hit.term = term;
        out.push(hit);
      }
    }
  }
  return out;
}
