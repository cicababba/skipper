import { ipcMain, type BrowserWindow } from "electron";
import {
  issueSourceForAuthProvider,
  reconcile,
  applyTransition,
  loadOrCreateOrchestratorManifest,
  saveOrchestratorManifest,
  ApiError,
  AuthError,
  listUserInstallationRepos,
  codeHostFor,
  resolveGate,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  IssuePlanSchema,
  readSolutionRecord,
  writeSolutionRecord,
  listSolutionRecords,
  deleteSolutionRecord,
  reconcileMemoryIndex,
  memoryFileName,
  applyFeedbackVote,
  type OrchestratorManifest,
  type OrchestratorSettings,
} from "@skipper/core";
import {
  issueBranchFor,
  repoKey,
  resolveRepoIntakeSettings,
  resolveRepoOrchestratorSettings,
} from "@skipper/shared";
import type {
  Account,
  AgentReview,
  AuthProviderId,
  CodingEvent,
  CodingEventEnvelope,
  ConfidenceReport,
  FollowCandidate,
  FollowCandidatesResult,
  Issue,
  LifecycleState,
  MemoryPhase,
  OrchestratorAccountState,
  OrchestratorState,
  PrReviewComment,
  PullRequest,
  RepoIntakeSettings,
  RepoRef,
  RepoSettingsRow,
  ResolvedRepoIntakeSettings,
  ResolvedRepoOrchestratorSettings,
  ResumeRiteAction,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import { loadCursors, saveCursors, type InboxCursorFile } from "./inbox-cursor-store";
import {
  cloneRepo,
  loadRepoLinks,
  saveRepoLinks,
  validateRepoOrigin,
  type RepoLinksFile,
} from "./repo-links";
import { readLlmSettings } from "./llm-settings";
import { readStoredPlan, updateStoredPlan } from "./plan-store";
import { initPlanner, pokePlanner } from "./planner";
import { initCoder, pokeCoder, cancelCodingRun, killAllCodingRuns } from "./coder";
import { initReviewer, pokeReviewer } from "./reviewer";
import { initShepherd, pokeShepherd, openOrPushPr } from "./shepherd";
import {
  captureWorktreeDiff,
  ensureWorktree,
  fetchOrigin,
  listWorktreeChanges,
  readWorktreeFileVersions,
  resolveBaseRef,
  worktreeDirFor,
  worktreeStatus,
  writeWorktreeFile,
} from "./worktrees";

export { killAllCodingRuns };

// Orchestrator loop (issue #6): absorbs the issue-#5 inbox poller. Keeps
// per-account snapshots of assigned issues + authored PRs fresh via the core
// GitHub adapter, reconciles every poll into the lifecycle manifest, and
// pushes state to the renderer.

export type { OrchestratorAccountState, OrchestratorState } from "@skipper/shared";

export interface OrchestratorDeps {
  getAccounts: () => Account[];
  getToken: (accountId: string, forceRefresh?: boolean) => Promise<string | null>;
  cursorFilePath: string;
  manifestFilePath: string;
  repoLinksFilePath: string;
  plansDir: string;
  worktreesDir: string;
  memoryDir: string;
  /** userData root — settings.json lives here (#59: planner/reviewer provider). */
  dataDir: string;
  /** Absolute path to the CLI bundle for the skipper-memory MCP server (#45),
   * or null when it isn't shipped (dev before a CLI build). */
  cliBundlePath: string | null;
}

const FIRST_POLL_DELAY_MS = 10_000;
const POLL_EVERY_MS = 3 * 60_000;
const FULL_WALK_EVERY_MS = 6 * 60 * 60_000;
const POKE_DEBOUNCE_MS = 1500;

let status: "idle" | "polling" = "idle";
let accountsState: Record<string, OrchestratorAccountState> = {};
let deps: OrchestratorDeps | null = null;
let getWindow: () => BrowserWindow | null = () => null;
let cursors: InboxCursorFile | null = null;
let manifest: OrchestratorManifest | null = null;
let repoLinks: RepoLinksFile | null = null;
let polling = false;
// item maps survive delta polls; state arrays are derived snapshots
const items = new Map<string, Map<string, Issue | PullRequest>>();
const lastFullWalkAt = new Map<string, number>();

function snapshot(): OrchestratorState {
  const tracked = Object.values(manifest?.items ?? {});
  return {
    status,
    intakePaused: manifest?.settings.intakePaused ?? false,
    parkedCount: Object.keys(manifest?.parked ?? {}).length,
    queue: {
      coding: tracked.filter((i) => i.state === "coding").length,
      queued: tracked.filter((i) => i.state === "queued").length,
      wipLimitPerRepo: manifest?.settings.codingWipPerRepo ?? 1,
    },
    items: tracked,
    accounts: accountsState,
    repoSettings: manifest?.repoSettings ?? {},
    resumeRite: manifest?.resumeRite ? { itemIds: [...manifest.resumeRite.itemIds] } : null,
    settings: manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
  };
}

function broadcast(): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("skipper:orchestrator:stateChanged", snapshot());
  }
}

// Fine-grained coding progress (#9): replay buffer + per-item channel, the
// terminal.ts per-id pattern. Coarse state changes ride the broadcast above.
const CODING_EVENT_BUFFER_MAX = 500;
const codingEvents = new Map<string, CodingEventEnvelope[]>();
const codingEventSeq = new Map<string, number>();

function emitCodingEvent(itemId: string, event: CodingEvent): void {
  // A new run restarts the stream: reset the buffer so replay never mixes runs.
  if (event.kind === "status" && event.phase === "fetching") {
    codingEvents.set(itemId, []);
    codingEventSeq.set(itemId, 0);
    void resetMemoryUse(itemId, "coding");
  }
  const seq = codingEventSeq.get(itemId) ?? 0;
  codingEventSeq.set(itemId, seq + 1);
  const envelope: CodingEventEnvelope = { itemId, seq, at: new Date().toISOString(), event };
  const buffer = codingEvents.get(itemId) ?? [];
  buffer.push(envelope);
  if (buffer.length > CODING_EVENT_BUFFER_MAX) buffer.shift();
  codingEvents.set(itemId, buffer);
  if (isMemoryGet(event)) void recordMemoryUse(itemId, "coding", event.detail);
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(`skipper:coding:event:${itemId}`, envelope);
  }
}

// Planner console stream (#32): same machinery as coding events, own channel
// pair so a coding run's buffer reset never wipes planner history.
const planningEvents = new Map<string, CodingEventEnvelope[]>();
const planningEventSeq = new Map<string, number>();

function emitPlanningEvent(itemId: string, event: CodingEvent): void {
  // Every planner run opens with agent-start: reset so replay never mixes runs.
  if (event.kind === "status" && event.phase === "agent-start") {
    planningEvents.set(itemId, []);
    planningEventSeq.set(itemId, 0);
    void resetMemoryUse(itemId, "planning");
  }
  const seq = planningEventSeq.get(itemId) ?? 0;
  planningEventSeq.set(itemId, seq + 1);
  const envelope: CodingEventEnvelope = { itemId, seq, at: new Date().toISOString(), event };
  const buffer = planningEvents.get(itemId) ?? [];
  buffer.push(envelope);
  if (buffer.length > CODING_EVENT_BUFFER_MAX) buffer.shift();
  planningEvents.set(itemId, buffer);
  if (isMemoryGet(event)) void recordMemoryUse(itemId, "planning", event.detail);
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(`skipper:planning:event:${itemId}`, envelope);
  }
}

// "Memories used" (#46): record which solutions a run fetched in full via
// get_memory — the ground truth for the card, persisted on the tracked item so
// it survives restart. search_memory queries surface only in the live console.
const MEMORY_GET_TOOL_SUFFIX = "__get_memory";

/** Ground-truth signal: a get_memory tool call fetched a full record. */
function isMemoryGet(event: CodingEvent): event is CodingEvent & { detail: string } {
  return (
    event.kind === "tool-use" &&
    event.tool.endsWith(MEMORY_GET_TOOL_SUFFIX) &&
    typeof event.detail === "string" &&
    event.detail.length > 0
  );
}

/** Append a fetched memory id to the item's phase list (deduped), then persist. */
async function recordMemoryUse(itemId: string, phase: MemoryPhase, id: string): Promise<void> {
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) return;
  const used = item.usedMemory ?? {};
  const list = used[phase] ?? [];
  if (list.some((ref) => ref.id === id)) return;
  item.usedMemory = { ...used, [phase]: [...list, { id }] };
  await saveOrchestratorManifest(deps!.manifestFilePath, m);
  broadcast();
}

/** Clear a phase's used-memory list at the start of a fresh run. */
async function resetMemoryUse(itemId: string, phase: MemoryPhase): Promise<void> {
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item?.usedMemory?.[phase]?.length) return;
  item.usedMemory = { ...item.usedMemory, [phase]: [] };
  await saveOrchestratorManifest(deps!.manifestFilePath, m);
  broadcast();
}

function patchAccount(accountId: string, patch: Partial<OrchestratorAccountState>): void {
  const current: OrchestratorAccountState = accountsState[accountId] ?? {
    accountId,
    status: "idle",
    issues: [],
    pullRequests: [],
  };
  accountsState = { ...accountsState, [accountId]: { ...current, ...patch } };
  broadcast();
}

async function ensureManifest(): Promise<OrchestratorManifest> {
  if (!manifest) {
    if (!deps) throw new Error("orchestrator not initialized");
    manifest = await loadOrCreateOrchestratorManifest(deps.manifestFilePath);
  }
  return manifest;
}

async function ensureRepoLinks(): Promise<RepoLinksFile> {
  if (!repoLinks) {
    if (!deps) throw new Error("orchestrator not initialized");
    repoLinks = await loadRepoLinks(deps.repoLinksFilePath);
  }
  return repoLinks;
}

function repoPathFor(repo: RepoRef): string | undefined {
  return repoLinks?.repos[repoKey(repo)]?.localPath;
}

// Per-key validation for the two settings writers (#62). Each returns the value to
// store, or undefined to reject the write.
const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const clampInt =
  (min: number, max: number) =>
  (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(max, Math.max(min, Math.round(v)))
      : undefined;
const oneOf =
  <T extends string>(...allowed: readonly T[]) =>
  (v: unknown): T | undefined =>
    (allowed as readonly unknown[]).includes(v) ? (v as T) : undefined;
const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const SETTINGS_VALIDATORS: {
  [K in keyof OrchestratorSettings]?: (v: unknown) => OrchestratorSettings[K] | undefined;
} = {
  autoPlanPaused: asBool,
  autoCoding: oneOf("on", "off", "auto"),
  review: oneOf("on", "off", "auto"),
  reviewMaxRounds: clampInt(1, 5),
  ciReentry: oneOf("off", "auto"),
  codingWipPerRepo: clampInt(1, 10),
  // #58: model strings stay opaque CLI aliases — no enum, so a manifest
  // hand-edited to a full model id survives a write from the UI.
  plannerModel: nonEmptyString,
  coderModel: nonEmptyString,
  reviewerModel: nonEmptyString,
  coderMaxTurns: clampInt(10, 200),
};

const REPO_SETTINGS_VALIDATORS: {
  [K in keyof RepoIntakeSettings]-?: (v: unknown) => RepoIntakeSettings[K] | undefined;
} = {
  followed: asBool,
  priority: oneOf("high", "normal", "low"),
  autoPlan: oneOf("on", "off", "label"),
  autoPlanLabel: nonEmptyString,
  wipLimit: clampInt(1, 10),
  autoCoding: oneOf("on", "off", "auto"),
  review: oneOf("on", "off", "auto"),
  reviewMaxRounds: clampInt(1, 5),
  ciReentry: oneOf("off", "auto"),
  plannerModel: nonEmptyString,
  coderModel: nonEmptyString,
  reviewerModel: nonEmptyString,
};

function repoIntake(repo: RepoRef): ResolvedRepoIntakeSettings {
  return resolveRepoIntakeSettings(manifest?.repoSettings[repoKey(repo)]);
}

/** Intake settings plus every per-repo override of a global setting (#62). */
function repoOrch(repo: RepoRef): ResolvedRepoOrchestratorSettings {
  return resolveRepoOrchestratorSettings(
    manifest?.repoSettings[repoKey(repo)],
    manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
  );
}

/** Accounts whose auth provider backs an issue source (identity-only providers filtered out). */
function issueAccounts(): Account[] {
  return (deps?.getAccounts() ?? []).filter((a) => issueSourceForAuthProvider(a.provider));
}

/** Exposed to main (CJS) via the orchestrator bundle — core's registry is ESM-only. */
export function isIssueSourceProvider(provider: AuthProviderId): boolean {
  return issueSourceForAuthProvider(provider) !== undefined;
}

/** Token for cloning: explicit account, else the account that sees the repo, else the first one. */
async function tokenForRepo(
  owner: string,
  name: string,
  accountId?: string,
): Promise<string | null> {
  if (!deps) return null;
  if (accountId) return deps.getToken(accountId);
  const key = repoKey({ owner, name });
  for (const [acctId, map] of items) {
    for (const item of map.values()) {
      if (repoKey(item.repo) === key) return deps.getToken(acctId);
    }
  }
  const first = issueAccounts()[0];
  return first ? deps.getToken(first.id) : null;
}

function admissionPolicy(m: OrchestratorManifest): {
  intakePaused: boolean;
  shouldAdmit: (issue: Issue) => boolean;
} {
  return {
    intakePaused: m.settings.intakePaused,
    // Follow list (#15): default-all — an absent record means followed. Ignored
    // repos' issues stay in the raw inbox arrays; linking still gates planning.
    shouldAdmit: (issue) =>
      resolveRepoIntakeSettings(m.repoSettings[repoKey(issue.repo)])
        .followed,
  };
}

function byUpdatedAtDesc(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function deriveArrays(accountId: string): { issues: Issue[]; pullRequests: PullRequest[] } {
  const map = items.get(accountId) ?? new Map();
  const issues: Issue[] = [];
  const pullRequests: PullRequest[] = [];
  for (const item of map.values()) {
    if (item.kind === "issue") issues.push(item);
    else pullRequests.push(item);
  }
  return { issues: issues.sort(byUpdatedAtDesc), pullRequests: pullRequests.sort(byUpdatedAtDesc) };
}

async function pollAccount(account: Account, ignoreBackoff: boolean): Promise<void> {
  if (!deps || !cursors) return;
  const source = issueSourceForAuthProvider(account.provider);
  if (!source) return;
  const accountId = account.id;
  const existing = accountsState[accountId];
  if (!ignoreBackoff && existing?.nextPollAt && Date.now() < existing.nextPollAt) return;

  const forceFull = Date.now() - (lastFullWalkAt.get(accountId) ?? 0) > FULL_WALK_EVERY_MS;
  const cursor = forceFull ? undefined : cursors.platforms[source.id]?.[accountId];

  patchAccount(accountId, { status: "polling" });
  try {
    const m = await ensureManifest();
    // Tracked PRs (#11): reviews/CI don't bump updated_at, so deltas alone
    // would never surface them — hydrate them unconditionally each poll.
    const deepHydrate = Object.values(m.items)
      .filter(
        (i) =>
          i.accountId === accountId &&
          i.pr &&
          (i.state === "pr-open" || i.state === "in-review" || i.state === "changes-requested"),
      )
      .map((i) => ({ owner: i.repo.owner, name: i.repo.name, number: i.pr!.number }));

    const result = await source.poll({
      accountId,
      getToken: (force) => deps!.getToken(accountId, force),
      baseUrl: account.baseUrl,
      cursor,
      deepHydrate,
    });

    let map = items.get(accountId);
    if (result.mode === "full" || !map) {
      map = new Map();
      items.set(accountId, map);
      lastFullWalkAt.set(accountId, Date.now());
    }
    for (const item of [...result.issues, ...result.pullRequests]) {
      if (item.kind === "pull-request") {
        // The same PR can arrive under its issue-record id (list streams) or its
        // pull-record id (deep hydration) — evict the other id before upserting.
        for (const [id, existing] of map) {
          if (
            id !== item.id &&
            existing.kind === "pull-request" &&
            existing.number === item.number &&
            existing.repo.owner === item.repo.owner &&
            existing.repo.name === item.repo.name
          ) {
            map.delete(id);
          }
        }
      }
      map.set(item.id, item);
    }
    // Closed issues leave the inbox; closed/merged PRs stay (terminal state
    // is signal for shepherding/review).
    for (const [id, item] of map) {
      if (item.kind === "issue" && item.state === "closed") map.delete(id);
    }

    await ensureRepoLinks();
    const outcome = reconcile(
      m,
      accountId,
      { mode: result.mode, issues: result.issues, pullRequests: result.pullRequests },
      admissionPolicy(m),
    );
    for (const conflict of outcome.conflicts) {
      console.warn(`[orchestrator] conflict on ${conflict.itemId}: ${conflict.detail}`);
    }
    await saveOrchestratorManifest(deps.manifestFilePath, m);

    (cursors.platforms[source.id] ??= {})[accountId] = result.cursor;
    await saveCursors(deps.cursorFilePath, cursors);

    patchAccount(accountId, {
      status: "idle",
      lastSyncAt: Date.now(),
      nextPollAt: undefined,
      error: undefined,
      ...deriveArrays(accountId),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      patchAccount(accountId, { status: "auth-error", error: err.message });
      return;
    }
    if (err instanceof ApiError && err.retryAfterSeconds) {
      patchAccount(accountId, {
        status: "error",
        error: err.message,
        nextPollAt: Date.now() + err.retryAfterSeconds * 1000,
      });
      return;
    }
    patchAccount(accountId, { status: "error", error: String(err) });
  }
}

async function pollNow(ignoreBackoff = false): Promise<void> {
  if (!deps || polling) return;
  polling = true;
  status = "polling";
  broadcast();
  try {
    if (!cursors) cursors = await loadCursors(deps.cursorFilePath);
    await ensureManifest();

    const accounts = issueAccounts();
    const known = new Set(accounts.map((a) => a.id));

    // Accounts signed out since the last tick: prune poll state + cursors.
    // Manifest items survive sign-out so lifecycle state outlives re-login.
    let pruned = false;
    for (const accountId of Object.keys(accountsState)) {
      if (!known.has(accountId)) {
        const { [accountId]: _gone, ...rest } = accountsState;
        accountsState = rest;
        items.delete(accountId);
        for (const perPlatform of Object.values(cursors.platforms)) {
          delete perPlatform?.[accountId];
        }
        pruned = true;
      }
    }
    if (pruned) {
      await saveCursors(deps.cursorFilePath, cursors);
      broadcast();
    }

    for (const account of accounts) {
      await pollAccount(account, ignoreBackoff);
    }
  } finally {
    polling = false;
    status = "idle";
    broadcast();
    pokePlanner();
    pokeCoder();
    pokeReviewer();
    pokeShepherd();
  }
}

/**
 * Re-runs reconcile from the cached per-account item maps — used after a repo
 * link/clone so already-seen issues admit retroactively without waiting for
 * the next delta poll (which would not re-send unchanged items). Delta mode:
 * the absence walk must never fire on a partial cache.
 */
async function reconcileFromCache(): Promise<void> {
  if (!deps) return;
  const m = await ensureManifest();
  await ensureRepoLinks();
  let changed = false;
  for (const accountId of items.keys()) {
    const { issues, pullRequests } = deriveArrays(accountId);
    const outcome = reconcile(m, accountId, { mode: "delta", issues, pullRequests }, admissionPolicy(m));
    if (outcome.admitted.length > 0 || outcome.transitions.length > 0) changed = true;
  }
  if (changed) {
    await saveOrchestratorManifest(deps.manifestFilePath, m);
  }
  broadcast();
  pokePlanner();
  pokeCoder();
  pokeReviewer();
  pokeShepherd();
}

/** Sets plan.ref + confidence and the gated transition in a single manifest write (#8). */
async function completePlan(
  itemId: string,
  ref: string,
  confidence?: ConfidenceReport,
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  // No score is a scoring *failure*, not a decision — #8's contract is the
  // conservative gate, so autoCoding:"on" deliberately does not apply here.
  const target = confidence
    ? resolveGate(confidence.composite, m.settings.confidence, repoOrch(item.repo).autoCoding)
    : "plan-gate";
  let reason: string;
  if (confidence) {
    const divergent = confidence.signals.convergence?.divergent
      ? " — plans diverge, issue may be ambiguous"
      : "";
    reason = `confidence ${confidence.composite.toFixed(2)}${divergent}`;
  } else {
    reason = "plan generated (confidence unavailable)";
  }
  const withRef = { ...item, plan: { ...item.plan, ref, confidence: confidence?.composite } };
  // Below the low floor the plan itself is broken — resume means replan.
  m.items[itemId] = applyTransition(withRef, target, "planner", reason, {
    resumeTo: target === "needs-input" ? "planning" : undefined,
  });
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  // High confidence gates straight to queued — wake the coder.
  pokeCoder();
}

/**
 * Sets item.review + the transition in a single manifest write (#10) — atomic
 * rounds+transition so a crash can never burn a review round.
 */
async function completeReview(
  itemId: string,
  review: AgentReview,
  to: LifecycleState,
  reason: string,
  resumeTo?: LifecycleState,
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  m.items[itemId] = applyTransition({ ...item, review }, to, "reviewer", reason, { resumeTo });
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  // Fix round lands the item back in queued-for-coding territory — wake the coder.
  pokeCoder();
  // A fix round converging to human-review is the auto-repush trigger (#11).
  pokeShepherd();
}

/**
 * Sets the authoritative PR link + lastPushedSha, clears pending review
 * comments, and transitions to pr-open in a single manifest write (#11).
 */
async function completePrOpen(
  itemId: string,
  pr: { id: string; number: number; url: string },
  pushedSha: string,
  actor: "user" | "shepherd",
  reason: string,
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  const withPr: TrackedItem = {
    ...item,
    pr,
    shepherd: { ...item.shepherd, pendingReviewComments: undefined, lastPushedSha: pushedSha },
  };
  m.items[itemId] = applyTransition(withPr, "pr-open", actor, reason);
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
}

/**
 * Sets shepherd.pendingReviewComments + the changes-requested → coding
 * transition in a single manifest write (#11). The item lands directly in
 * "coding": the coder's scan picks it up (counts toward the WIP limit) without
 * passing through the queue — finishing in-flight work beats starting new.
 */
async function completeReentry(
  itemId: string,
  comments: PrReviewComment[],
  reason: string,
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  const withComments: TrackedItem = {
    ...item,
    shepherd: { ...item.shepherd, pendingReviewComments: comments },
  };
  m.items[itemId] = applyTransition(withComments, "coding", "shepherd", reason);
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  pokeCoder();
}

/** Stamps the memory ref and drops the worktree record — no transition, merged is terminal (#11). */
async function completeMergedCleanup(itemId: string, memoryRef: string): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  m.items[itemId] = {
    ...item,
    worktree: undefined,
    shepherd: { ...item.shepherd, memoryRef },
    updatedAt: new Date().toISOString(),
  };
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
}

/** Persists the coding worktree record (path/branch/sessionId) without a transition (#9). */
async function setWorktree(
  itemId: string,
  worktree: { path: string; branch: string; sessionId?: string },
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  m.items[itemId] = { ...item, worktree, updatedAt: new Date().toISOString() };
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
}

/**
 * Drives one lifecycle transition and persists it. In-process API for the
 * planner/coder/reviewer/shepherd (#7-#11); throws IllegalTransitionError on
 * a bad edge — the IPC handler wraps it for the renderer.
 */
export async function requestTransition(
  itemId: string,
  to: LifecycleState,
  actor: TransitionActor,
  reason?: string,
  resumeTo?: LifecycleState,
): Promise<TrackedItem> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  const prevState = item.state;
  // A user moving a held item out of triage overrides the resume-rite hold (#15).
  const source =
    actor === "user" && item.state === "triage" && item.holdAutoPlan
      ? { ...item, holdAutoPlan: undefined }
      : item;
  const next = applyTransition(source, to, actor, reason, { resumeTo });
  m.items[itemId] = next;
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  if (actor !== "planner") pokePlanner();
  if (actor !== "coder") {
    // Someone else moved a live coding item — abort its run.
    if (prevState === "coding") cancelCodingRun(itemId);
    pokeCoder();
  }
  // The coder landing on agent-review arrives here — wake the reviewer.
  if (actor !== "reviewer") pokeReviewer();
  if (actor !== "shepherd") pokeShepherd();
  return next;
}

export async function setIntakePaused(paused: boolean): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  m.settings.intakePaused = paused;
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  if (!paused) {
    // Resume (#15): drain cached parked issues now (they admit held from
    // auto-plan and surface the rite prompt); a poll picks up the rest.
    await reconcileFromCache();
    pokeOrchestrator();
  }
}

/**
 * Resolves the one-shot resume-rite prompt (#15). Selected items move to
 * planning; the rest keep holdAutoPlan and stay in triage for manual planning.
 * Any resolution — including dismiss — clears the rite.
 */
export async function resolveResumeRite(
  action: ResumeRiteAction,
  itemIds?: string[],
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  if (!m.resumeRite) return;
  const rite = m.resumeRite.itemIds;
  const selected =
    action === "plan-all"
      ? rite
      : action === "plan-selected"
        ? (itemIds ?? []).filter((id) => rite.includes(id))
        : [];
  for (const id of selected) {
    const item = m.items[id];
    if (!item || item.state !== "triage") continue; // closed/moved meanwhile — skip
    m.items[id] = applyTransition(
      { ...item, holdAutoPlan: undefined },
      "planning",
      "user",
      "resume rite",
    );
  }
  delete m.resumeRite;
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  pokePlanner();
}

let pokeTimer: NodeJS.Timeout | null = null;

/** Debounced out-of-band re-poll — fired on auth changes. */
export function pokeOrchestrator(): void {
  if (!deps) return;
  if (pokeTimer) clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => {
    pokeTimer = null;
    void pollNow().catch(() => {
      /* per-account errors already captured */
    });
  }, POKE_DEBOUNCE_MS);
}

export function initOrchestrator(
  windowGetter: () => BrowserWindow | null,
  orchestratorDeps: OrchestratorDeps,
): void {
  getWindow = windowGetter;
  deps = orchestratorDeps;

  ipcMain.handle("skipper:orchestrator:getState", async () => {
    await ensureManifest();
    return snapshot();
  });
  ipcMain.handle("skipper:orchestrator:refresh", async () => {
    await pollNow(true);
    return snapshot();
  });
  ipcMain.handle(
    "skipper:orchestrator:requestTransition",
    async (_e, itemId: string, to: LifecycleState, reason?: string) => {
      try {
        const item = await requestTransition(itemId, to, "user", reason);
        return { ok: true as const, item };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle("skipper:orchestrator:setIntakePaused", async (_e, paused: boolean) => {
    await setIntakePaused(Boolean(paused));
    return snapshot();
  });
  // Settings writer (#15, generalized in #62). The validator table IS the whitelist:
  // a key absent from it is not writable over IPC. intakePaused keeps its own handler
  // (it carries the parked/resume-rite rite); confidence.* and shepherdRepush are
  // hand-edit by design.
  ipcMain.handle(
    "skipper:orchestrator:updateSettings",
    async (_e, patch: Partial<OrchestratorSettings>) => {
      const m = await ensureManifest();
      for (const key of Object.keys(SETTINGS_VALIDATORS) as (keyof OrchestratorSettings)[]) {
        // `key in patch`, not a truthiness check: an absent key is not a clear.
        if (!patch || !(key in patch)) continue;
        const next = SETTINGS_VALIDATORS[key]!((patch as Record<string, unknown>)[key]);
        if (next !== undefined) (m.settings as unknown as Record<string, unknown>)[key] = next;
      }
      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      broadcast();
      pokePlanner(); // autoPlanPaused — without this the topbar toggle reads as dead
      pokeCoder(); // codingWipPerRepo, autoCoding
      pokeReviewer(); // review, reviewMaxRounds
      // The model keys need no poke: each run reads its model at start (#58).
      return snapshot();
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:setRepoSettings",
    async (_e, owner: string, name: string, patch: Partial<RepoIntakeSettings>) => {
      const m = await ensureManifest();
      const key = repoKey({ owner, name });
      const followedBefore = resolveRepoIntakeSettings(m.repoSettings[key]).followed;
      const merged: RepoIntakeSettings = { ...m.repoSettings[key] };
      for (const k of Object.keys(REPO_SETTINGS_VALIDATORS) as (keyof RepoIntakeSettings)[]) {
        if (!patch || !(k in patch)) continue;
        // undefined is meaningful here — it clears the override back to the global.
        if (patch[k] === undefined) {
          delete merged[k];
          continue;
        }
        const next = REPO_SETTINGS_VALIDATORS[k]!(patch[k]);
        // Invalid values are dropped, never coerced to undefined: coercing would
        // silently clear a working override instead of rejecting the write.
        if (next !== undefined) (merged as Record<string, unknown>)[k] = next;
      }
      if (Object.keys(merged).length === 0) delete m.repoSettings[key];
      else m.repoSettings[key] = merged;
      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      if (!followedBefore && resolveRepoIntakeSettings(m.repoSettings[key]).followed) {
        // Re-followed: cached issues admit retroactively, like a fresh repo link.
        await reconcileFromCache();
      } else {
        broadcast();
        pokePlanner();
        pokeCoder();
      }
      return snapshot();
    },
  );
  ipcMain.handle("skipper:orchestrator:listRepoSettings", async (): Promise<RepoSettingsRow[]> => {
    const m = await ensureManifest();
    const links = await ensureRepoLinks();
    const repos = new Map<string, RepoRef>();
    const put = (key: string, repo: RepoRef): void => {
      if (!repos.has(key)) repos.set(key, repo);
    };
    // Poll cache + tracked items carry proper-case RepoRefs; keys reconstructed
    // from links/settings fall back to the lowercased form.
    for (const map of items.values()) {
      for (const item of map.values()) put(repoKey(item.repo), item.repo);
    }
    for (const item of Object.values(m.items)) {
      put(repoKey(item.repo), item.repo);
    }
    for (const key of [...Object.keys(links.repos), ...Object.keys(m.repoSettings)]) {
      const [owner, name] = key.split("/");
      if (owner && name) put(key, { owner, name });
    }
    return [...repos.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, repo]) => ({
        key,
        repo,
        linked: Boolean(links.repos[key]),
        localPath: links.repos[key]?.localPath,
        settings: m.repoSettings[key] ?? {},
        resolved: resolveRepoOrchestratorSettings(m.repoSettings[key], m.settings),
      }));
  });
  ipcMain.handle(
    "skipper:orchestrator:listFollowCandidates",
    async (_e, accountId?: string): Promise<FollowCandidatesResult> => {
      try {
        const account = accountId
          ? issueAccounts().find((a) => a.id === accountId)
          : issueAccounts()[0];
        if (!account) return { ok: false, error: "no GitHub account connected" };
        const m = await ensureManifest();
        const links = await ensureRepoLinks();
        const result = await listUserInstallationRepos((force) =>
          deps!.getToken(account.id, force),
        );

        const candidates = new Map<string, FollowCandidate>();
        const describe = (repo: RepoRef, key: string): Omit<FollowCandidate, "repo" | "source"> => ({
          followed: resolveRepoIntakeSettings(m.repoSettings[key]).followed,
          linked: Boolean(links.repos[key]),
        });
        for (const repo of result.repos) {
          const key = repoKey(repo);
          const ref = { owner: repo.owner, name: repo.name };
          candidates.set(key, {
            repo: ref,
            private: repo.private,
            source: "installation",
            ...describe(ref, key),
          });
        }
        // Public repos assigned via general visibility never show in
        // installations — merge everything the poller has already seen.
        for (const map of items.values()) {
          for (const item of map.values()) {
            const key = repoKey(item.repo);
            if (candidates.has(key)) continue;
            candidates.set(key, {
              repo: item.repo,
              source: "polled",
              ...describe(item.repo, key),
            });
          }
        }

        const installUrl = result.appSlug
          ? `https://github.com/apps/${result.appSlug}/installations/new`
          : "https://github.com/settings/installations";
        return {
          ok: true,
          installationCount: result.installationCount,
          installUrl,
          repos: [...candidates.values()].sort((a, b) =>
            `${a.repo.owner}/${a.repo.name}`.localeCompare(`${b.repo.owner}/${b.repo.name}`),
          ),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:resolveResumeRite",
    async (_e, action: ResumeRiteAction, itemIds?: string[]) => {
      await resolveResumeRite(action, itemIds);
      return snapshot();
    },
  );
  ipcMain.handle("skipper:orchestrator:setPinned", async (_e, itemId: string, pinned: boolean) => {
    const m = await ensureManifest();
    const item = m.items[itemId];
    if (!item) return { ok: false as const, error: `unknown item ${itemId}` };
    m.items[itemId] = {
      ...item,
      pinned: pinned ? true : undefined,
      updatedAt: new Date().toISOString(),
    };
    await saveOrchestratorManifest(deps!.manifestFilePath, m);
    broadcast();
    pokeCoder();
    return { ok: true as const, item: m.items[itemId] };
  });
  ipcMain.handle(
    "skipper:orchestrator:linkRepo",
    async (_e, owner: string, name: string, localPath: string) => {
      try {
        // TODO(#68): pick the host from the repo's code-host axis once a second host lands.
        await validateRepoOrigin(localPath, { owner, name }, codeHostFor("github"));
        const links = await ensureRepoLinks();
        links.repos[repoKey({ owner, name })] = { localPath, linkedAt: new Date().toISOString() };
        await saveRepoLinks(deps!.repoLinksFilePath, links);
        await reconcileFromCache();
        return { ok: true as const, localPath };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:cloneRepo",
    async (_e, owner: string, name: string, destParent: string, accountId?: string) => {
      try {
        const token = await tokenForRepo(owner, name, accountId);
        if (!token) throw new Error("no GitHub account token available");
        const host = codeHostFor("github");
        const localPath = await cloneRepo(
          host,
          { owner, name },
          destParent,
          host.pushCredentials(token),
        );
        const links = await ensureRepoLinks();
        links.repos[repoKey({ owner, name })] = { localPath, linkedAt: new Date().toISOString() };
        await saveRepoLinks(deps!.repoLinksFilePath, links);
        await reconcileFromCache();
        return { ok: true as const, localPath };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle("skipper:orchestrator:unlinkRepo", async (_e, owner: string, name: string) => {
    try {
      const links = await ensureRepoLinks();
      delete links.repos[repoKey({ owner, name })];
      await saveRepoLinks(deps!.repoLinksFilePath, links);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("skipper:orchestrator:listRepos", async () => {
    const links = await ensureRepoLinks();
    const seen = new Map<string, RepoRef>();
    for (const map of items.values()) {
      for (const item of map.values()) {
        seen.set(repoKey(item.repo), item.repo);
      }
    }
    const linked = Object.entries(links.repos).map(([key, link]) => ({
      key,
      localPath: link.localPath,
      linkedAt: link.linkedAt,
      linked: true as const,
    }));
    const unlinked = [...seen.entries()]
      .filter(([key]) => !links.repos[key])
      .map(([key, repo]) => ({ key, repo, linked: false as const }));
    return { linked, unlinked };
  });
  ipcMain.handle("skipper:orchestrator:getPlan", async (_e, itemId: string) => {
    const m = await ensureManifest();
    const ref = m.items[itemId]?.plan?.ref;
    if (!ref) return null;
    return readStoredPlan(deps!.plansDir, ref);
  });
  // Persist a user-edited plan at the gate (#13). Only legal while the item sits
  // in plan-gate — during a replan the item is back in planning, so stale saves lose.
  ipcMain.handle("skipper:orchestrator:updatePlan", async (_e, itemId: string, plan: unknown) => {
    const m = await ensureManifest();
    const item = m.items[itemId];
    if (!item) return { ok: false as const, error: `unknown item ${itemId}` };
    if (item.state !== "plan-gate") {
      return { ok: false as const, error: `plan is only editable in plan-gate (item is ${item.state})` };
    }
    const ref = item.plan?.ref;
    if (!ref) return { ok: false as const, error: "item has no stored plan" };
    const parsed = IssuePlanSchema.safeParse(plan);
    if (!parsed.success) {
      return { ok: false as const, error: `invalid plan: ${parsed.error.issues[0]?.message ?? "schema mismatch"}` };
    }
    const stored = await updateStoredPlan(deps!.plansDir, ref, parsed.data);
    if (!stored) return { ok: false as const, error: "stored plan not found" };
    return { ok: true as const, stored };
  });
  // Replay for renderers that mount mid-run; live events ride the per-item channel.
  ipcMain.handle("skipper:coding:getEvents", (_e, itemId: string) => {
    return codingEvents.get(itemId) ?? [];
  });
  ipcMain.handle("skipper:planning:getEvents", (_e, itemId: string) => {
    return planningEvents.get(itemId) ?? [];
  });
  // Solutions memory surface (#46). get/feedback drive the "memories used" card;
  // list is the read side #47's browser will consume.
  ipcMain.handle("skipper:memory:get", async (_e, id: string) => {
    return readSolutionRecord(deps!.memoryDir, memoryFileName(id));
  });
  ipcMain.handle("skipper:memory:list", async (_e, repo: RepoRef) => {
    const key = repoKey(repo);
    const entries = await listSolutionRecords(deps!.memoryDir);
    return entries
      .map((e) => e.record)
      .filter((r) => repoKey(r.repo) === key);
  });
  // 👍/👎 (#46): move the record's aggregate counters by the delta between the
  // item entry's old vote and the new one, and store the new vote as the local
  // idempotency anchor. Feedback is query-time only — no reindex.
  ipcMain.handle(
    "skipper:memory:feedback",
    async (_e, itemId: string, phase: MemoryPhase, id: string, vote: "up" | "down" | null) => {
      const m = await ensureManifest();
      const entry = m.items[itemId]?.usedMemory?.[phase]?.find((ref) => ref.id === id);
      if (!entry) return { ok: false as const, error: "used-memory entry not found" };
      const record = await readSolutionRecord(deps!.memoryDir, memoryFileName(id));
      if (!record) return { ok: false as const, error: `no memory record for id "${id}"` };
      const oldVote = entry.vote;
      if (oldVote === (vote ?? undefined)) return { ok: true as const };
      record.feedback = applyFeedbackVote(record.feedback, oldVote, vote);
      try {
        await writeSolutionRecord(deps!.memoryDir, record);
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
      if (vote) entry.vote = vote;
      else delete entry.vote;
      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      broadcast();
      return { ok: true as const };
    },
  );
  // Delete a record from the browser (#47): drop the file, then reconcile the
  // vector index so the removed record stops surfacing in retrieval.
  ipcMain.handle("skipper:memory:delete", async (_e, id: string) => {
    const removed = await deleteSolutionRecord(deps!.memoryDir, memoryFileName(id));
    if (!removed) return { ok: false as const, error: `no memory record for id "${id}"` };
    try {
      await reconcileMemoryIndex(deps!.memoryDir);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
    broadcast();
    return { ok: true as const };
  });
  // Pre-PR diff review (#14). The human-review gate bounds what the renderer
  // can reach: only worktrees of items the user is actively reviewing.
  async function reviewableWorktree(
    itemId: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const m = await ensureManifest();
    const item = m.items[itemId];
    if (!item) return { ok: false, error: `unknown item ${itemId}` };
    if (item.state !== "human-review") {
      return {
        ok: false,
        error: `worktree is only reviewable in human-review (item is ${item.state})`,
      };
    }
    if (!item.worktree?.path) return { ok: false, error: "no worktree recorded for item" };
    return { ok: true, path: item.worktree.path };
  }

  ipcMain.handle("skipper:orchestrator:getWorktreeChanges", async (_e, itemId: string) => {
    const wt = await reviewableWorktree(itemId);
    if (!wt.ok) return wt;
    try {
      return { ok: true as const, files: await listWorktreeChanges(wt.path) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(
    "skipper:orchestrator:readWorktreeFile",
    async (_e, itemId: string, path: string, oldPath?: string) => {
      const wt = await reviewableWorktree(itemId);
      if (!wt.ok) return wt;
      try {
        return { ok: true as const, file: await readWorktreeFileVersions(wt.path, path, oldPath) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:saveWorktreeFile",
    async (_e, itemId: string, path: string, content: string) => {
      const wt = await reviewableWorktree(itemId);
      if (!wt.ok) return wt;
      try {
        await writeWorktreeFile(wt.path, path, content);
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  // Worktree control center (#40): location + liveness for any item with a
  // worktree, in any lifecycle state — unlike the review-gated diff handlers.
  ipcMain.handle("skipper:orchestrator:getWorktreeStatus", async (_e, itemId: string) => {
    const m = await ensureManifest();
    const item = m.items[itemId];
    if (!item) return { ok: false as const, error: `unknown item ${itemId}` };
    return worktreeStatus(item.worktree);
  });
  // Open the draft PR from human-review, or push a fix round's updates (#11).
  ipcMain.handle("skipper:orchestrator:openPr", async (_e, itemId: string) => {
    await ensureManifest();
    await ensureRepoLinks();
    return openOrPushPr(itemId, "user");
  });

  initPlanner({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = items.get(item.accountId)?.get(item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    getRepoPath: repoPathFor,
    getRepoSettings: repoOrch,
    requestTransition,
    completePlan,
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    emitEvent: emitPlanningEvent,
    plansDir: orchestratorDeps.plansDir,
    getMemoryMcp: (item) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo: item.repo }
        : undefined,
  });

  initCoder({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = items.get(item.accountId)?.get(item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    getPlan: async (item) => {
      const ref = item.plan?.ref;
      return ref ? readStoredPlan(orchestratorDeps.plansDir, ref) : null;
    },
    requestTransition,
    setWorktree,
    prepareWorktree: async (item) => {
      const link = repoLinks?.repos[repoKey(item.repo)];
      if (!link) throw new Error(`repo ${item.repo.owner}/${item.repo.name} is not linked`);
      const token = await tokenForRepo(item.repo.owner, item.repo.name, item.accountId);
      await fetchOrigin(
        link.localPath,
        token ? codeHostFor(item.codeHost).pushCredentials(token) : undefined,
      );
      const baseRef = await resolveBaseRef(link.localPath, link.baseBranch);
      return ensureWorktree({
        repoPath: link.localPath,
        worktreePath: worktreeDirFor(orchestratorDeps.worktreesDir, item.repo, item.key),
        branch: issueBranchFor(item.key),
        baseRef,
      });
    },
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getRepoPriority: (repo) => repoOrch(repo).priority,
    getRepoWipLimit: (repo) => repoOrch(repo).wipLimit,
    getRepoSettings: repoOrch,
    emitEvent: emitCodingEvent,
    getMemoryMcp: (item) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo: item.repo }
        : undefined,
  });

  initReviewer({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = items.get(item.accountId)?.get(item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    getPlan: async (item) => {
      const ref = item.plan?.ref;
      return ref ? readStoredPlan(orchestratorDeps.plansDir, ref) : null;
    },
    getDiff: async (item) => {
      if (!item.worktree?.path) throw new Error("no worktree recorded for item");
      return captureWorktreeDiff(item.worktree.path);
    },
    completeReview,
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getRepoSettings: repoOrch,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
  });

  initShepherd({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getTokenProvider: (item) => (force) => deps!.getToken(item.accountId, force),
    getBaseUrl: (item) => deps!.getAccounts().find((a) => a.id === item.accountId)?.baseUrl,
    getRepoPath: repoPathFor,
    getBaseBranch: async (item) => {
      const link = repoLinks?.repos[repoKey(item.repo)];
      if (!link) throw new Error(`repo ${item.repo.owner}/${item.repo.name} is not linked`);
      const baseRef = await resolveBaseRef(link.localPath, link.baseBranch);
      return baseRef.replace(/^origin\//, "");
    },
    getPlan: async (item) => {
      const ref = item.plan?.ref;
      return ref ? readStoredPlan(orchestratorDeps.plansDir, ref) : null;
    },
    requestTransition,
    completePrOpen,
    completeReentry,
    completeMergedCleanup,
    memoryDir: orchestratorDeps.memoryDir,
  });

  setTimeout(
    () =>
      void pollNow().catch(() => {
        /* keep loop alive */
      }),
    FIRST_POLL_DELAY_MS,
  );
  setInterval(
    () =>
      void pollNow().catch(() => {
        /* keep loop alive */
      }),
    POLL_EVERY_MS,
  );
}
