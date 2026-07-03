// Model-proposed diff safety checks. Reject patches that can escape the repo,
// touch ignored paths, or include binary data.
import { MHConfig } from "./types";
import { isIgnored } from "./paths";

function touchesGitDir(p: string): boolean {
  return p === ".git" || p.startsWith(".git/") || p.includes("/.git/");
}

function collect(diff: string, re: RegExp, groups: number[]): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(diff)) !== null) {
    for (const g of groups) if (m[g]) out.push(m[g]);
  }
  return out;
}

// Returns a rejection reason, or null when the diff looks safe to git-check.
export function unsafe(diff: string | undefined, config: MHConfig): string | null {
  if (!diff || diff === "") return "empty diff";
  if (diff.includes("GIT binary patch")) return "binary patches blocked";
  // Git quotes paths with special characters (`"a/..."`); the extractors below
  // cannot parse those, so reject rather than validate a truncated path.
  if (/diff --git "/.test(diff) || /^[+-]{3} "/m.test(diff) || /rename to "/.test(diff) || /copy to "/.test(diff)) {
    return "quoted paths blocked";
  }
  const paths: string[] = [
    ...collect(diff, /diff --git a\/(\S+) b\/(\S+)/g, [1, 2]),
    ...collect(diff, /^[+-]{3} [ab]\/([^\n]+)$/gm, [1]),
    ...collect(diff, /^rename to ([^\n]+)$/gm, [1]),
    ...collect(diff, /^copy to ([^\n]+)$/gm, [1]),
  ];
  for (let p of paths) {
    // Strip only the trailing tab+metadata git appends; spaces are legal in paths.
    p = p.replace(/\t.*$/, "");
    if (p.startsWith("/") || p.includes("../") || touchesGitDir(p) || isIgnored(p, config.ignore)) {
      return "unsafe path: " + p;
    }
  }
  return null;
}
