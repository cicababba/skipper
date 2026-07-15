import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  type OrchestratorSettings,
  type RepoIntakeSettings,
  type TrackedItem,
} from "@skipper/shared";

// The settings model lives in @skipper/shared (#62) so the renderer can read it
// without importing this package. Re-exported to keep the core surface intact.
export { DEFAULT_ORCHESTRATOR_SETTINGS };
export type { OrchestratorSettings };

export interface OrchestratorManifest {
  version: 1;
  settings: OrchestratorSettings;
  /** itemId → tracked issue. */
  items: Record<string, TrackedItem>;
  /** Issues seen while intake was paused; the resume rite consumes this (#15). */
  parked: Record<string, { firstSeenAt: string }>;
  /** repoKey(owner, name) → per-repo intake settings (#15). */
  repoSettings: Record<string, RepoIntakeSettings>;
  /** Pending resume-rite prompt (#15); survives restarts, cleared on resolution. */
  resumeRite?: { itemIds: string[]; createdAt: string };
}

/**
 * #62: reviewMode: "always" | "never" | "auto" → review: "on" | "off" | "auto".
 *
 * The knob was hand-edit-only, never UI-writable — but hand-editing is exactly how
 * it was used, so a plain `??=` would silently turn a hand-set "always" into "auto",
 * i.e. less review than the user asked for. Consume the legacy key explicitly, then
 * delete it: the whole object is reserialized on save, and a surviving reviewMode
 * would lie to the next person who opens the file.
 */
function migrateReviewMode(settings: OrchestratorSettings): void {
  const legacy = settings as unknown as { reviewMode?: string };
  if (settings.review === undefined && legacy.reviewMode !== undefined) {
    settings.review =
      legacy.reviewMode === "always" ? "on" : legacy.reviewMode === "never" ? "off" : "auto";
  }
  delete legacy.reviewMode;
  settings.review ??= DEFAULT_ORCHESTRATOR_SETTINGS.review;
}

function freshManifest(): OrchestratorManifest {
  return {
    version: 1,
    settings: structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS),
    items: {},
    parked: {},
    repoSettings: {},
  };
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
      // Additive settings (#8, #9, #10, #62): fill defaults into older manifests.
      parsed.settings.autoPlanPaused ??= DEFAULT_ORCHESTRATOR_SETTINGS.autoPlanPaused;
      parsed.settings.plannerModel ??= DEFAULT_ORCHESTRATOR_SETTINGS.plannerModel;
      parsed.settings.confidence ??= structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS.confidence);
      parsed.settings.coderModel ??= DEFAULT_ORCHESTRATOR_SETTINGS.coderModel;
      parsed.settings.coderMaxTurns ??= DEFAULT_ORCHESTRATOR_SETTINGS.coderMaxTurns;
      parsed.settings.autoCoding ??= DEFAULT_ORCHESTRATOR_SETTINGS.autoCoding;
      migrateReviewMode(parsed.settings);
      parsed.settings.reviewMaxRounds ??= DEFAULT_ORCHESTRATOR_SETTINGS.reviewMaxRounds;
      parsed.settings.reviewerModel ??= DEFAULT_ORCHESTRATOR_SETTINGS.reviewerModel;
      parsed.settings.shepherdRepush ??= DEFAULT_ORCHESTRATOR_SETTINGS.shepherdRepush;
      parsed.settings.codingWipPerRepo ??= DEFAULT_ORCHESTRATOR_SETTINGS.codingWipPerRepo;
      parsed.repoSettings ??= {};
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
