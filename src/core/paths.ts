// Path normalization, ignore matching, and list de-duplication utilities.

export function normalize(p: string | undefined | null): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function relative(root: string | undefined, p: string): string {
  const norm = normalize(p);
  const nroot = normalize(root ?? "");
  if (nroot !== "" && norm.startsWith(nroot + "/")) return norm.slice(nroot.length + 1);
  return norm;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+\-^$()[\]{}|\\?]/g, (c) => "\\" + c).replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

export function isIgnored(p: string, patterns: string[] | undefined): boolean {
  const norm = normalize(p);
  for (let pat of patterns ?? []) {
    pat = normalize(pat);
    if (pat.endsWith("/")) {
      const dir = pat.slice(0, -1);
      if (norm === dir || norm.startsWith(dir + "/") || norm.includes("/" + dir + "/")) return true;
    } else if (pat.includes("*")) {
      const re = globToRegExp(pat);
      if (re.test(norm) || re.test(basename(norm))) return true;
    } else if (norm === pat || basename(norm) === pat) {
      return true;
    }
  }
  return false;
}

export function dedupe(list: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list ?? []) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
