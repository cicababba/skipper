import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { TrackedItem } from "@nestbrain/shared";

export interface OrchestratorManifest {
  version: 1;
  settings: { intakePaused: boolean };
  /** itemId → tracked issue. */
  items: Record<string, TrackedItem>;
  /** Issues seen while intake was paused; #15's resume rite consumes this. */
  parked: Record<string, { firstSeenAt: string }>;
}

function freshManifest(): OrchestratorManifest {
  return { version: 1, settings: { intakePaused: false }, items: {}, parked: {} };
}

export async function loadOrCreateOrchestratorManifest(
  filePath: string,
): Promise<OrchestratorManifest> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as OrchestratorManifest;
    if (
      parsed.version === 1 &&
      typeof parsed.settings === "object" &&
      parsed.settings !== null &&
      typeof parsed.items === "object" &&
      parsed.items !== null &&
      typeof parsed.parked === "object" &&
      parsed.parked !== null
    ) {
      return parsed;
    }
    return freshManifest();
  } catch {
    return freshManifest();
  }
}

// Serialized saves so concurrent poll ticks never race the write+rename.
const saveQueue = new Map<string, Promise<void>>();

export async function saveOrchestratorManifest(
  filePath: string,
  manifest: OrchestratorManifest,
): Promise<void> {
  const bytes = JSON.stringify(manifest, null, 2);
  const prev = saveQueue.get(filePath) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* swallow previous error so this save still runs */
    })
    .then(() => writeAtomic(filePath, bytes));
  saveQueue.set(filePath, next);
  try {
    await next;
  } finally {
    if (saveQueue.get(filePath) === next) saveQueue.delete(filePath);
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf-8");
  await rename(tmp, path);
}
