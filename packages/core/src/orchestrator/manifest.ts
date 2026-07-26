import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  type AgentRuntimeId,
  type AgentSelection,
  type CodeHostId,
  type IssueSourceId,
  type OrchestratorSettings,
  type RepoIntakeSettings,
  type TrackedItem,
} from "@skipper/shared";

// The settings model lives in @skipper/shared (#62) so the renderer can read it
// without importing this package. Re-exported to keep the core surface intact.
export { DEFAULT_ORCHESTRATOR_SETTINGS };
export type { OrchestratorSettings };

export interface OrchestratorManifest {
  version: 3;
  settings: OrchestratorSettings;
  /** itemId → tracked issue. */
  items: Record<string, TrackedItem>;
  /** Issues seen while intake was paused; the resume rite consumes this (#15). */
  parked: Record<string, { firstSeenAt: string }>;
  /** repoKey(owner, name) → per-repo intake settings (#15). */
  repoSettings: Record<string, RepoIntakeSettings>;
  /** projectMappingKey → canonical repoKey (#79) — repo for trackers whose
   *  projects have no inherent repo (Jira). */
  projectMappings: Record<string, string>;
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

/**
 * #194: the agent-turn knobs coderMaxTurns / plannerMaxTurns became wall-clock
 * budgets coderTimeBudgetMin / plannerTimeBudgetMin. Turns no longer bound the work,
 * so the old values do NOT convert (pre-beta) — they are consumed and deleted, since a
 * surviving key would lie to the next person who opens the file (reviewMode precedent).
 * Then backfill the new keys with defaults. Idempotent, no version gate.
 */
function migrateTurnBudgets(settings: OrchestratorSettings): void {
  const legacy = settings as unknown as { coderMaxTurns?: number; plannerMaxTurns?: number };
  delete legacy.coderMaxTurns;
  delete legacy.plannerMaxTurns;
  settings.coderTimeBudgetMin ??= DEFAULT_ORCHESTRATOR_SETTINGS.coderTimeBudgetMin;
  settings.plannerTimeBudgetMin ??= DEFAULT_ORCHESTRATOR_SETTINGS.plannerTimeBudgetMin;
}

/**
 * #125: the per-role model globals became optional overrides of llm.claudeModel.
 * Old builds materialized the "opus" default onto disk, so a v1 manifest can't tell a
 * deliberate opus from the old default — both strip to "inherit". Anything else was
 * user-chosen and survives as an explicit override. One-time (v1 only) and idempotent:
 * v2 manifests are never re-stripped, so opus chosen after the upgrade sticks.
 */
function migrateRoleModelInherit(settings: OrchestratorSettings): void {
  const legacy = settings as unknown as Record<string, string | undefined>;
  for (const key of ["plannerModel", "coderModel", "reviewerModel"] as const) {
    if (legacy[key] === "opus") delete legacy[key];
  }
}

/**
 * v2 → v3: the flat per-role model + runtime keys become atomic (runtime, model)
 * pairs. The legacy model rides along only when the pair lands on claude-cli —
 * legacy models were Claude aliases by definition, so carrying "opus" onto a codex
 * pair would inject a bogus `--model opus`. Legacy keys are consumed then deleted
 * (reviewMode precedent): the object reserializes on save and a surviving
 * coderModel would lie to the next person who opens the file.
 */
function migrateAgentPairs(settings: OrchestratorSettings | RepoIntakeSettings): void {
  const legacy = settings as unknown as Record<string, string | undefined>;
  for (const role of ["planner", "coder", "reviewer"] as const) {
    const model = legacy[`${role}Model`];
    const runtime = legacy[`${role}Runtime`];
    if (model !== undefined || runtime !== undefined) {
      const id = (runtime as AgentRuntimeId | undefined) ?? "claude-cli";
      (settings as Record<string, unknown>)[`${role}Agent`] = {
        runtime: id,
        ...(id === "claude-cli" && model ? { model } : {}),
      } satisfies AgentSelection;
    }
    delete legacy[`${role}Model`];
    delete legacy[`${role}Runtime`];
  }
}

/**
 * #71 two-axis migration: platform → source + codeHost, string key derived from
 * the GitHub number. Legacy key consumed then deleted (reviewMode precedent) —
 * the object reserializes on save. Worktrees on disk need nothing:
 * item.worktree.path is persisted per-item and never reconstructed.
 */
function migrateTwoAxisItem(item: TrackedItem): void {
  const legacy = item as unknown as { platform?: IssueSourceId };
  if (item.source === undefined && legacy.platform !== undefined) {
    item.source = legacy.platform;
    item.codeHost = legacy.platform as CodeHostId;
  }
  delete legacy.platform;
  item.source ??= "github";
  item.codeHost ??= "github";
  item.key ??= String(item.number);
  item.sourceRef ??= { project: `${item.repo.owner}/${item.repo.name}`, key: item.key };
}

/**
 * #101: TrackedItem.accountId was a provider-native id; it is now the account
 * key (`provider:id` / `provider:host:id`). Best-effort in-place migration on
 * load — no separate migration file, matching migrateTwoAxisItem.
 *
 * Rule per item: already a known key → keep; exactly one account whose native id
 * matches → rewrite to its key; otherwise (unknown or ambiguous across hosts) →
 * drop the item, since we can't tell which host it belonged to. Callers pass a
 * `warn` sink rather than logging: core never writes to stdout.
 */
function resolveAccountKeys(
  manifest: OrchestratorManifest,
  accounts: Array<{ id: string; key: string }>,
  warn?: (message: string) => void,
): void {
  const knownKeys = new Set(accounts.map((a) => a.key));
  for (const [itemId, item] of Object.entries(manifest.items)) {
    if (knownKeys.has(item.accountId)) continue;
    const matches = accounts.filter((a) => a.id === item.accountId);
    if (matches.length === 1) {
      item.accountId = matches[0].key;
    } else {
      warn?.(
        `dropping tracked item ${itemId}: account "${item.accountId}" is ${
          matches.length === 0 ? "unknown" : "ambiguous across hosts"
        }`,
      );
      delete manifest.items[itemId];
    }
  }
}

function freshManifest(): OrchestratorManifest {
  return {
    version: 3,
    settings: structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS),
    items: {},
    parked: {},
    repoSettings: {},
    projectMappings: {},
  };
}

export async function loadOrCreateOrchestratorManifest(
  filePath: string,
  accounts?: Array<{ id: string; key: string }>,
  warn?: (message: string) => void,
): Promise<OrchestratorManifest> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as OrchestratorManifest;
    // On-disk version can lag the current literal, so read it as a plain number.
    const version = parsed.version as number;
    if (
      (version === 1 || version === 2 || version === 3) &&
      typeof parsed.settings === "object" &&
      parsed.settings !== null &&
      typeof parsed.items === "object" &&
      parsed.items !== null &&
      typeof parsed.parked === "object" &&
      parsed.parked !== null
    ) {
      // Additive settings (#8, #9, #10, #62): fill defaults into older manifests.
      parsed.settings.autoPlanPaused ??= DEFAULT_ORCHESTRATOR_SETTINGS.autoPlanPaused;
      parsed.settings.confidence ??= structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS.confidence);
      migrateTurnBudgets(parsed.settings);
      parsed.settings.autoCoding ??= DEFAULT_ORCHESTRATOR_SETTINGS.autoCoding;
      migrateReviewMode(parsed.settings);
      parsed.settings.reviewMaxRounds ??= DEFAULT_ORCHESTRATOR_SETTINGS.reviewMaxRounds;
      parsed.settings.shepherdRepush ??= DEFAULT_ORCHESTRATOR_SETTINGS.shepherdRepush;
      parsed.settings.ciReentry ??= DEFAULT_ORCHESTRATOR_SETTINGS.ciReentry;
      parsed.settings.codingWipPerRepo ??= DEFAULT_ORCHESTRATOR_SETTINGS.codingWipPerRepo;
      // #125: strip the materialized opus trio once (v1 only), so an opus chosen
      // after the upgrade sticks and survives into its pair below.
      if (version === 1) migrateRoleModelInherit(parsed.settings);
      parsed.repoSettings ??= {};
      parsed.projectMappings ??= {};
      // Flat role model/runtime keys → atomic pairs, then pin v3 so it never re-runs.
      if (version <= 2) {
        migrateAgentPairs(parsed.settings);
        for (const repo of Object.values(parsed.repoSettings)) migrateAgentPairs(repo);
        parsed.version = 3;
      }
      for (const item of Object.values(parsed.items)) migrateTwoAxisItem(item);
      // Empty/absent accounts (e.g. a transient auth failure) must never
      // mass-drop items — skip resolution entirely in that case (#101).
      if (accounts && accounts.length > 0) resolveAccountKeys(parsed, accounts, warn);
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
