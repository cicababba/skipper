// Staleness (#256): a memory whose files no longer exist at the repo's base ref
// describes code that is gone. Pure math over a path set — the sweep that reads
// the git tree and persists the result lives in the desktop app.

import type { SolutionRecord } from "@skipper/shared";

/** The files a record claims to touch: captured diff, else the plan, else a note's links. */
export function recordFilesTouched(record: SolutionRecord): string[] {
  return (
    record.diffStats?.files ??
    record.plan?.plan.files.map((f) => f.path) ??
    record.note?.files ??
    []
  );
}

/** Fraction of the record's files missing at the base ref; undefined = nothing to measure. */
export function stalenessFraction(files: string[], existing: Set<string>): number | undefined {
  const unique = [...new Set(files)];
  if (unique.length === 0) return undefined;
  const missing = unique.filter((file) => !existing.has(file)).length;
  return missing / unique.length;
}
