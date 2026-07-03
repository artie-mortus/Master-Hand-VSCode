// Deterministic local repo index. No model calls here.
import * as fs from "node:fs";
import * as path from "node:path";
import { MHConfig, RepoIndex } from "./types";
import { isIgnored } from "./paths";

const extLang: Record<string, string> = {
  lua: "Lua", js: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript",
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust", c: "C", h: "C/C++", cpp: "C++",
  hpp: "C++", java: "Java", kt: "Kotlin", swift: "Swift", php: "PHP", sh: "Shell",
  bash: "Shell", zsh: "Shell", fish: "Shell", md: "Markdown", json: "JSON", yaml: "YAML",
  yml: "YAML", toml: "TOML", vim: "Vimscript", rpy: "Ren'Py",
};

function fileExt(file: string): string {
  const m = file.match(/\.([\w\-]+)$/);
  return (m?.[1] ?? "").toLowerCase();
}

function langFor(file: string): string {
  const ext = fileExt(file);
  return extLang[ext] ?? (ext !== "" ? ext : "other");
}

// Read only small file heads; indexing should never pull huge files into memory.
function readHead(root: string, file: string, maxBytes: number): { text: string | null; size: number } {
  const full = path.join(root, file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return { text: null, size: 0 };
  }
  if (!stat.isFile()) return { text: null, size: 0 };
  if (stat.size > maxBytes) return { text: null, size: stat.size };
  try {
    const lines = fs.readFileSync(full, "utf8").split("\n").slice(0, 400);
    return { text: lines.join("\n"), size: stat.size };
  } catch {
    return { text: null, size: stat.size };
  }
}

function addCount(t: Record<string, number>, key: string, n = 1): void {
  t[key] = (t[key] ?? 0) + n;
}

const symbolPatterns = [
  /function\s+([\w.:]+)\s*\(/g,
  /local\s+function\s+([\w.:]+)\s*\(/g,
  /class\s+(\w+)/g,
  /def\s+(\w+)\s*\(/g,
  /(\w+)\s*=\s*function\s*\(/g,
];

function symbolsFor(file: string, text: string, limit: number): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const pat of symbolPatterns) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      out.push({ file, name: m[1] });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function todosFor(file: string, text: string, limit: number): { file: string; lnum: number; text: string }[] {
  const out: { file: string; lnum: number; text: string }[] = [];
  let lnum = 0;
  for (const line of text.split("\n")) {
    lnum += 1;
    const hit = line.match(/\b((?:TODO|FIXME|HACK)[:\s].*)/);
    if (hit) {
      out.push({ file, lnum, text: hit[1].trim() });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function looksLikeTestPath(file: string): boolean {
  return /^tests?\//.test(file) || /\/tests?\//.test(file) || /[_.\-]test\./.test(file) || /[_.\-]spec\./.test(file);
}

// Build compact repo facts for prompts/UI without calling external models.
// `files` is a pre-fetched tracked-file list (already ignore-filtered).
export function build(root: string, files: string[], config: MHConfig): RepoIndex {
  const opts = config.context;
  const maxFiles = opts.indexMaxFiles || 500;
  const maxFileBytes = opts.indexMaxFileBytes || 20000;
  const trimmed = files.slice(0, maxFiles);

  const idx: RepoIndex = {
    files_seen: trimmed.length,
    dirs: {},
    languages: {},
    extensions: {},
    largest_files: [],
    entrypoints: [],
    tests: [],
    docs: [],
    todos: [],
    symbols: [],
  };

  for (const file of trimmed) {
    if (isIgnored(file, config.ignore)) continue;
    const slash = file.lastIndexOf("/");
    addCount(idx.dirs, slash === -1 ? "." : file.slice(0, slash));
    addCount(idx.languages, langFor(file));
    addCount(idx.extensions, fileExt(file) !== "" ? fileExt(file) : "none");
    if (looksLikeTestPath(file)) idx.tests.push(file);
    if (file.toLowerCase().includes("readme") || file.endsWith(".md")) idx.docs.push(file);
    if (/^main\.|\/main\.|^init\.|\/init\.|^src\/extension\./.test(file)) idx.entrypoints.push(file);

    const { text, size } = readHead(root, file, maxFileBytes);
    idx.largest_files.push({ file, bytes: size });
    if (text !== null) {
      idx.todos.push(...todosFor(file, text, opts.indexMaxTodos || 40));
      idx.symbols.push(...symbolsFor(file, text, opts.indexMaxSymbols || 80));
    }
  }

  idx.largest_files.sort((a, b) => b.bytes - a.bytes);
  idx.largest_files = idx.largest_files.slice(0, 10);
  idx.todos = idx.todos.slice(0, opts.indexMaxTodos || 40);
  idx.symbols = idx.symbols.slice(0, opts.indexMaxSymbols || 80);
  return idx;
}
