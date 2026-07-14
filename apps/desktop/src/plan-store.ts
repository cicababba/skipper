// Generated plans, one JSON file per tracked item under <userData>/plans/.
// Pure Node module; the planner injects the directory. TrackedItem.plan.ref
// stores the filename. Replan and user edits overwrite (no history).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IssuePlan, StoredPlan } from "@skipper/shared";

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
    // v1 = pre-#8 plans without confidence; read back as-is.
    return parsed.version === 2 || (parsed.version as number) === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export async function updateStoredPlan(
  plansDir: string,
  ref: string,
  plan: IssuePlan,
): Promise<StoredPlan | null> {
  const stored = await readStoredPlan(plansDir, ref);
  if (!stored) return null;
  const updated: StoredPlan = { ...stored, plan, editedAt: new Date().toISOString() };
  await writeStoredPlan(plansDir, ref, updated);
  return updated;
}
