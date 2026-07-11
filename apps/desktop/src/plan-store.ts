// Generated plans, one JSON file per tracked item under <userData>/plans/.
// Pure Node module; the planner injects the directory. TrackedItem.plan.ref
// stores the filename. Replan overwrites (history arrives with #13 if ever).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredPlan } from "@nestbrain/shared";

/** Item ids contain ":" which is illegal on Windows filenames. */
export function planFileName(itemId: string): string {
  return `${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export async function writeStoredPlan(
  plansDir: string,
  ref: string,
  stored: StoredPlan,
): Promise<void> {
  await mkdir(plansDir, { recursive: true });
  const path = join(plansDir, ref);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(stored, null, 2), "utf-8");
  await rename(tmp, path);
}

export async function readStoredPlan(plansDir: string, ref: string): Promise<StoredPlan | null> {
  try {
    const raw = await readFile(join(plansDir, ref), "utf-8");
    const parsed = JSON.parse(raw) as StoredPlan;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}
