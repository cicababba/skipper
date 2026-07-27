// Solutions-memory records (issue #11), one JSON file per merged item under
// <userData>/memory/. Pure Node module; callers inject the directory.
// TrackedItem.shepherd.memoryRef stores the filename. Promoted from the
// desktop app with #44 so the CLI (indexing/retrieval host) can read it too.

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SolutionRecord } from "@skipper/shared";

/** Item ids contain ":" which is illegal on Windows filenames. */
export function memoryFileName(itemId: string): string {
  return `${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/**
 * Delete a record file. Returns true if a file was removed. The vector index
 * entry is not touched here — callers reconcile the index afterwards.
 */
export async function deleteSolutionRecord(memoryDir: string, ref: string): Promise<boolean> {
  try {
    await rm(join(memoryDir, ref));
    return true;
  } catch {
    return false;
  }
}

export async function writeSolutionRecord(
  memoryDir: string,
  record: SolutionRecord,
): Promise<string> {
  const ref = memoryFileName(record.itemId);
  await mkdir(memoryDir, { recursive: true });
  const path = join(memoryDir, ref);
  const tmp = `${path}.tmp`;
  // Every mutating path (feedback, curation, distillation, usage, staleness)
  // goes through here, so a touched v1 record upgrades to v2 in one place (#256).
  const upgraded: SolutionRecord = { ...record, version: 2 };
  await writeFile(tmp, JSON.stringify(upgraded, null, 2), "utf-8");
  await rename(tmp, path);
  return ref;
}

export async function readSolutionRecord(
  memoryDir: string,
  ref: string,
): Promise<SolutionRecord | null> {
  try {
    const raw = await readFile(join(memoryDir, ref), "utf-8");
    const parsed = JSON.parse(raw) as SolutionRecord;
    return parsed.version === 1 || parsed.version === 2 ? parsed : null;
  } catch {
    return null;
  }
}

export interface SolutionRecordEntry {
  ref: string;
  record: SolutionRecord;
}

/**
 * Enumerate every record in the memory dir. Foreign/invalid JSON files
 * (including the vector index, which shares the directory) are skipped.
 */
export async function listSolutionRecords(memoryDir: string): Promise<SolutionRecordEntry[]> {
  let names: string[];
  try {
    names = await readdir(memoryDir);
  } catch {
    return [];
  }
  const entries: SolutionRecordEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readSolutionRecord(memoryDir, name);
    if (record) entries.push({ ref: name, record });
  }
  return entries;
}
