import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { TrackedItem } from "@nestbrain/shared";

export interface OrchestratorSettings {
  intakePaused: boolean;
  /** Model handed to the planner's LLM provider (also scores confidence, #8). */
  plannerModel: string;
  /** Gate thresholds + convergence sample count (#8). Hand-editable; UI with #13. */
  confidence: { high: number; low: number; extraPlanRuns: number };
  /** Model handed to the coding agent (#9). */
  coderModel: string;
  /** Max agent turns per coding run (#9). */
  coderMaxTurns: number;
  /** Agent review policy (#10): always / never / auto (mechanical skip heuristic). */
  reviewMode: "always" | "never" | "auto";
  /** Model handed to the diff critic (#10). */
  reviewerModel: string;
  /** After a change-request fix round (#11): hold at human-review or repush unattended. */
  shepherdRepush: "human" | "auto";
}

export interface OrchestratorManifest {
  version: 1;
  settings: OrchestratorSettings;
  /** itemId → tracked issue. */
  items: Record<string, TrackedItem>;
  /** Issues seen while intake was paused; #15's resume rite consumes this. */
  parked: Record<string, { firstSeenAt: string }>;
}

export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = {
  intakePaused: false,
  plannerModel: "opus",
  confidence: { high: 0.85, low: 0.4, extraPlanRuns: 2 },
  coderModel: "opus",
  coderMaxTurns: 60,
  reviewMode: "auto",
  reviewerModel: "opus",
  shepherdRepush: "human",
};

function freshManifest(): OrchestratorManifest {
  return {
    version: 1,
    settings: structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS),
    items: {},
    parked: {},
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
      // Additive settings (#8, #9, #10): fill defaults into older manifests.
      parsed.settings.plannerModel ??= DEFAULT_ORCHESTRATOR_SETTINGS.plannerModel;
      parsed.settings.confidence ??= structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS.confidence);
      parsed.settings.coderModel ??= DEFAULT_ORCHESTRATOR_SETTINGS.coderModel;
      parsed.settings.coderMaxTurns ??= DEFAULT_ORCHESTRATOR_SETTINGS.coderMaxTurns;
      parsed.settings.reviewMode ??= DEFAULT_ORCHESTRATOR_SETTINGS.reviewMode;
      parsed.settings.reviewerModel ??= DEFAULT_ORCHESTRATOR_SETTINGS.reviewerModel;
      parsed.settings.shepherdRepush ??= DEFAULT_ORCHESTRATOR_SETTINGS.shepherdRepush;
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
