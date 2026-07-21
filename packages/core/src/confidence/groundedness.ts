import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { GroundednessSignal, IssuePlan } from "@skipper/shared";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "release", ".next", "out", "coverage"]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_WALKED = 20_000;

/**
 * Throws unless repoPath is an existing directory. Without this a vanished repo
 * (e.g. a worktree removed mid-run) reads as "every cited file missing" and
 * fabricates an all-missing score of 0 — worse than no score at all (#157).
 */
export async function assertRepoDir(repoPath: string): Promise<void> {
  const info = await stat(repoPath).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`repoPath is not a directory: ${repoPath}`);
}

/** Cheap FS check, no LLM: do the files/symbols the plan cites actually exist? */
export async function scoreGroundedness(
  plan: IssuePlan,
  repoPath: string,
): Promise<GroundednessSignal> {
  await assertRepoDir(repoPath);
  const newFiles = new Set(
    plan.files.filter((f) => f.status === "new").map((f) => normalizeRepoPath(f.path) ?? f.path),
  );
  const cited = new Map<string, string | null>(); // original → normalized (null = invalid)
  for (const p of [...plan.files.map((f) => f.path), ...plan.steps.flatMap((s) => s.files)]) {
    const norm = normalizeRepoPath(p);
    if (norm !== null && newFiles.has(norm)) continue;
    if (!cited.has(p)) cited.set(p, norm);
  }

  const missingFiles: string[] = [];
  const existingFiles: string[] = [];
  for (const [original, norm] of cited) {
    if (norm !== null && (await isFile(join(repoPath, norm)))) existingFiles.push(norm);
    else missingFiles.push(original);
  }

  // Symbols cited by steps whose files are all "new" are exempt — they don't exist yet.
  const symbols = new Set<string>();
  for (const step of plan.steps) {
    const normed = step.files.map(normalizeRepoPath);
    const allNew = step.files.length > 0 && normed.every((n) => n !== null && newFiles.has(n));
    if (allNew) continue;
    for (const s of step.symbols) if (s.trim()) symbols.add(s.trim());
  }

  const foundSymbols = await findSymbols(repoPath, symbols, existingFiles);
  const missingSymbols = [...symbols].filter((s) => !foundSymbols.has(s)).sort();

  const filesChecked = cited.size;
  const filesFound = filesChecked - missingFiles.length;
  const symbolsChecked = symbols.size;
  const symbolsFound = symbolsChecked - missingSymbols.length;

  const fileScore = filesChecked === 0 ? 1 : filesFound / filesChecked;
  const symbolScore = symbolsChecked === 0 ? 1 : symbolsFound / symbolsChecked;

  return {
    score: 0.7 * fileScore + 0.3 * symbolScore,
    filesChecked,
    filesFound,
    symbolsChecked,
    symbolsFound,
    missingFiles: missingFiles.sort(),
    missingSymbols,
    newFiles: [...newFiles].sort(),
  };
}

/** Repo-relative only; absolute paths and ../ escapes are rejected (null). */
function normalizeRepoPath(p: string): string | null {
  if (!p.trim() || isAbsolute(p)) return null;
  const norm = normalize(p.replace(/[\\/]/g, sep));
  if (norm === ".." || norm.startsWith(`..${sep}`)) return null;
  return norm;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Substring search: cited files first, then a bounded repo walk, early exit. */
async function findSymbols(
  repoPath: string,
  symbols: Set<string>,
  hintFiles: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (symbols.size === 0) return found;
  const pending = new Set(symbols);

  const checkFile = async (path: string): Promise<void> => {
    try {
      const s = await stat(path);
      if (!s.isFile() || s.size > MAX_FILE_BYTES) return;
      const text = await readFile(path, "utf-8");
      if (text.includes("\0")) return;
      for (const sym of [...pending]) {
        if (text.includes(sym)) {
          found.add(sym);
          pending.delete(sym);
        }
      }
    } catch {
      /* unreadable file — skip */
    }
  };

  for (const rel of hintFiles) {
    if (pending.size === 0) return found;
    await checkFile(join(repoPath, rel));
  }

  let walked = 0;
  const dirs = [repoPath];
  while (dirs.length > 0 && pending.size > 0 && walked < MAX_FILES_WALKED) {
    const dir = dirs.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (pending.size === 0 || walked >= MAX_FILES_WALKED) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) dirs.push(path);
      } else if (entry.isFile()) {
        walked++;
        await checkFile(path);
      }
    }
  }
  return found;
}
