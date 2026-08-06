// How relevant a base advance is to a plan (#329). Pure path/set arithmetic over
// what a plan cites and what a merge changed — no IO, no LLM. The caller owns the
// git diff and the groundedness re-run.

import { posix, win32 } from "node:path";
import type { GroundednessSignal, IssuePlan } from "@skipper/shared";

/**
 * Repo-relative POSIX form, or null for anything that isn't one (absolute paths,
 * ../ escapes) — the same rule groundedness applies to a citation, normalized to
 * one separator so plan citations and `git diff --name-only` output compare.
 */
function normalizeCitedPath(p: string): string | null {
  const trimmed = p.trim();
  if (!trimmed || posix.isAbsolute(trimmed) || win32.isAbsolute(trimmed)) return null;
  const norm = posix.normalize(trimmed.replace(/\\/g, "/"));
  if (norm === ".." || norm.startsWith("../")) return null;
  const clean = norm.replace(/\/+$/, "");
  return clean && clean !== "." ? clean : null;
}

function normalizeAll(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const norm = normalizeCitedPath(p);
    if (norm) out.add(norm);
  }
  return [...out].sort();
}

/** Every repo-relative path the plan cites: files[].path ∪ steps[].files, deduped. */
export function planCitedPaths(plan: IssuePlan): string[] {
  return normalizeAll([...plan.files.map((f) => f.path), ...plan.steps.flatMap((s) => s.files)]);
}

/** The plan citations a change set also touches, sorted. */
export function overlappingPaths(plan: IssuePlan, changedFiles: string[]): string[] {
  const changed = new Set(normalizeAll(changedFiles));
  return planCitedPaths(plan).filter((p) => changed.has(p));
}

/**
 * Citations that stopped resolving between two groundedness runs: entries the
 * fresh signal misses and the stored one did not. No prior report means every
 * miss is new — the plan was never scored against a tree we can compare with.
 */
export function newGroundednessMisses(
  before: GroundednessSignal | undefined,
  after: GroundednessSignal,
): { files: string[]; symbols: string[] } {
  const knownFiles = new Set(before?.missingFiles ?? []);
  const knownSymbols = new Set(before?.missingSymbols ?? []);
  return {
    files: after.missingFiles.filter((f) => !knownFiles.has(f)),
    symbols: after.missingSymbols.filter((s) => !knownSymbols.has(s)),
  };
}
