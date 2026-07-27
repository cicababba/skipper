// Pure list shaping for the Memory tab (#255): ordering, the files a record
// touches, and the file-chip filter applied to either records or search hits.

import type { MemoryHit, SolutionRecord } from "@skipper/shared";

/** Newest capture first. */
export function chronological(records: SolutionRecord[]): SolutionRecord[] {
  return [...records].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/** The files a record is about — captured diff, planned files, or note links. */
export function recordFiles(record: SolutionRecord): string[] {
  return (
    record.diffStats?.files ??
    record.plan?.plan.files.map((f) => f.path) ??
    record.note?.files ??
    []
  );
}

/** Every file mentioned by any record, deduplicated and sorted. */
export function fileOptions(records: SolutionRecord[]): string[] {
  const all = new Set<string>();
  for (const record of records) for (const file of recordFiles(record)) all.add(file);
  return [...all].sort();
}

export function filterRecordsByFile(
  records: SolutionRecord[],
  file: string | null,
): SolutionRecord[] {
  if (!file) return records;
  return records.filter((r) => recordFiles(r).includes(file));
}

export function filterHitsByFile(hits: MemoryHit[], file: string | null): MemoryHit[] {
  if (!file) return hits;
  return hits.filter((h) => h.filesTouched.includes(file));
}
