// Structured coder reports (#146), one JSON file per tracked item under
// <userData>/plans/ alongside the plan. TrackedItem.coderReport.ref stores the
// filename. Overwritten each coding run — no history.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredCoderReport } from "@skipper/shared";

/** The `.report.json` suffix keeps refs unambiguous in the shared plansDir. */
export function reportFileName(itemId: string): string {
  return `${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}.report.json`;
}

export async function writeStoredCoderReport(
  plansDir: string,
  ref: string,
  stored: StoredCoderReport,
): Promise<void> {
  await mkdir(plansDir, { recursive: true });
  const path = join(plansDir, ref);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(stored, null, 2), "utf-8");
  await rename(tmp, path);
}

export async function readStoredCoderReport(
  plansDir: string,
  ref: string,
): Promise<StoredCoderReport | null> {
  try {
    const raw = await readFile(join(plansDir, ref), "utf-8");
    const parsed = JSON.parse(raw) as StoredCoderReport;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}
