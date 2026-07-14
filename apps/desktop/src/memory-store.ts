// Solutions-memory records (issue #11), one JSON file per merged item under
// <userData>/memory/. Pure Node module; the shepherd injects the directory.
// TrackedItem.shepherd.memoryRef stores the filename. Capture from day 1;
// retrieval arrives with v2 (docs/DIRECTION.md "Memoria").

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SolutionRecord } from "@skipper/shared";

/** Item ids contain ":" which is illegal on Windows filenames. */
export function memoryFileName(itemId: string): string {
  return `${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export async function writeSolutionRecord(
  memoryDir: string,
  record: SolutionRecord,
): Promise<string> {
  const ref = memoryFileName(record.itemId);
  await mkdir(memoryDir, { recursive: true });
  const path = join(memoryDir, ref);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), "utf-8");
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
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}
