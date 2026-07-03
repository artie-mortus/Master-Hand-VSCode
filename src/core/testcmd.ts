// Deterministic test-command inference. Pure fs checks; no process spawning.
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_READ = 65536;

function exists(root: string, name: string): boolean {
  try {
    fs.statSync(path.join(root, name));
    return true;
  } catch {
    return false;
  }
}

function readSmall(root: string, name: string): string | null {
  const file = path.join(root, name);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_READ) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function packageManager(root: string): string {
  if (exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (exists(root, "yarn.lock")) return "yarn";
  return "npm";
}

function hasPackageTest(root: string): boolean {
  const raw = readSmall(root, "package.json");
  if (!raw) return false;
  try {
    const decoded = JSON.parse(raw);
    return typeof decoded?.scripts?.test === "string" && decoded.scripts.test !== "";
  } catch {
    return false;
  }
}

function hasMakeTest(root: string): boolean {
  const raw = readSmall(root, "Makefile");
  // Anchor to line start so targets like "pretest:" or "unittest:" do not match.
  return raw !== null && /(^|\n)test\s*:/.test(raw);
}

export function infer(root: string): { argv: string[] | null; err?: string } {
  if (hasPackageTest(root)) return { argv: [packageManager(root), "test"] };
  if (exists(root, "Cargo.toml")) return { argv: ["cargo", "test"] };
  if (exists(root, "go.mod")) return { argv: ["go", "test", "./..."] };
  if (exists(root, "pyproject.toml") || exists(root, "pytest.ini") || exists(root, "setup.py")) return { argv: ["pytest"] };
  if (hasMakeTest(root)) return { argv: ["make", "test"] };
  return { argv: null, err: "no test setup detected" };
}
