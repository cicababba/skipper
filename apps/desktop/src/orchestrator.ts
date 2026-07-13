import { ipcMain, type BrowserWindow } from "electron";
import {
  pollGitHubAccount,
  emptyGitHubCursor,
  reconcile,
  applyTransition,
  loadOrCreateOrchestratorManifest,
  saveOrchestratorManifest,
  GitHubApiError,
  GitHubAuthError,
  resolveGate,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  type OrchestratorManifest,
} from "@nestbrain/core";
import type {
  Account,
  AgentReview,
  CodingEvent,
  CodingEventEnvelope,
  ConfidenceReport,
  Issue,
  LifecycleState,
  PrReviewComment,
  PullRequest,
  RepoRef,
  TrackedItem,
  TransitionActor,
} from "@nestbrain/shared";
import { loadCursors, saveCursors, type InboxCursorFile } from "./inbox-cursor-store";
import {
  cloneGitHubRepo,
  loadRepoLinks,
  repoKey,
  saveRepoLinks,
  validateRepoOrigin,
  type RepoLinksFile,
} from "./repo-links";
import { readStoredPlan } from "./plan-store";
import { initPlanner, pokePlanner } from "./planner";
import { initCoder, pokeCoder, cancelCodingRun, killAllCodingRuns } from "./coder";
import { initReviewer, pokeReviewer } from "./reviewer";
import { initShepherd, pokeShepherd, openOrPushPr } from "./shepherd";
import {
  branchFor,
  captureWorktreeDiff,
  ensureWorktree,
  fetchOrigin,
  resolveBaseRef,
  worktreeDirFor,
} from "./worktrees";

export { killAllCodingRuns };

// Orchestrator loop (issue #6): absorbs the issue-#5 inbox poller. Keeps
// per-account snapshots of assigned issues + authored PRs fresh via the core
// GitHub adapter, reconciles every poll into the lifecycle manifest, and
// pushes state to the renderer.

export interface OrchestratorAccountState {
  accountId: string;
  status: "idle" | "polling" | "error" | "auth-error";
  lastSyncAt?: number;
  /** Epoch ms before which polls are skipped (rate-limit backoff). */
  nextPollAt?: number;
  error?: string;
  issues: Issue[];
  pullRequests: PullRequest[];
}

export interface OrchestratorState {
  status: "idle" | "polling";
  intakePaused: boolean;
  parkedCount: number;
  items: TrackedItem[];
  accounts: Record<string, OrchestratorAccountState>;
}

export interface OrchestratorDeps {
  getAccounts: () => Account[];
  getToken: (accountId: string, forceRefresh?: boolean) => Promise<string | null>;
  cursorFilePath: string;
  manifestFilePath: string;
  repoLinksFilePath: string;
  plansDir: string;
  worktreesDir: string;
  memoryDir: string;
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
  return {
    status,
    intakePaused: manifest?.settings.intakePaused ?? false,
    parkedCount: Object.keys(manifest?.parked ?? {}).length,
    items: Object.values(manifest?.items ?? {}),
    accounts: accountsState,
  };
}

function broadcast(): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("nestbrain:orchestrator:stateChanged", snapshot());
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
  }
  const seq = codingEventSeq.get(itemId) ?? 0;
  codingEventSeq.set(itemId, seq + 1);
  const envelope: CodingEventEnvelope = { itemId, seq, at: new Date().toISOString(), event };
  const buffer = codingEvents.get(itemId) ?? [];
  buffer.push(envelope);
  if (buffer.length > CODING_EVENT_BUFFER_MAX) buffer.shift();
  codingEvents.set(itemId, buffer);
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(`nestbrain:coding:event:${itemId}`, envelope);
  }
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
  return repoLinks?.repos[repoKey(repo.owner, repo.name)]?.localPath;
}

/** Token for cloning: explicit account, else the account that sees the repo, else the first one. */
async function tokenForRepo(
  owner: string,
  name: string,
  accountId?: string,
): Promise<string | null> {
  if (!deps) return null;
  if (accountId) return deps.getToken(accountId);
  const key = repoKey(owner, name);
  for (const [acctId, map] of items) {
    for (const item of map.values()) {
      if (repoKey(item.repo.owner, item.repo.name) === key) return deps.getToken(acctId);
    }
  }
  const first = deps.getAccounts()[0];
  return first ? deps.getToken(first.id) : null;
}

function admissionPolicy(m: OrchestratorManifest): {
  intakePaused: boolean;
  shouldAdmit: (issue: Issue) => boolean;
} {
  return {
    intakePaused: m.settings.intakePaused,
    // Only linked repos enter the lifecycle (linked = followed); unlinked
    // issues stay in the raw inbox arrays until the user links the repo.
    shouldAdmit: (issue) => Boolean(repoPathFor(issue.repo)),
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
  const accountId = account.id;
  const existing = accountsState[accountId];
  if (!ignoreBackoff && existing?.nextPollAt && Date.now() < existing.nextPollAt) return;

  const forceFull = Date.now() - (lastFullWalkAt.get(accountId) ?? 0) > FULL_WALK_EVERY_MS;
  const cursor = forceFull ? undefined : cursors.github[accountId];

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

    const result = await pollGitHubAccount({
      accountId,
      getToken: (force) => deps!.getToken(accountId, force),
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

    cursors.github[accountId] = result.cursor ?? emptyGitHubCursor();
    await saveCursors(deps.cursorFilePath, cursors);

    patchAccount(accountId, {
      status: "idle",
      lastSyncAt: Date.now(),
      nextPollAt: undefined,
      error: undefined,
      ...deriveArrays(accountId),
    });
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      patchAccount(accountId, { status: "auth-error", error: err.message });
      return;
    }
    if (err instanceof GitHubApiError && err.retryAfterSeconds) {
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

    const accounts = deps.getAccounts();
    const known = new Set(accounts.map((a) => a.id));

    // Accounts signed out since the last tick: prune poll state + cursors.
    // Manifest items survive sign-out so lifecycle state outlives re-login.
    let pruned = false;
    for (const accountId of Object.keys(accountsState)) {
      if (!known.has(accountId)) {
        const { [accountId]: _gone, ...rest } = accountsState;
        accountsState = rest;
        items.delete(accountId);
        delete cursors.github[accountId];
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
  const target = confidence
    ? resolveGate(confidence.composite, m.settings.confidence)
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
  m.items[itemId] = applyTransition(withRef, target, "planner", reason);
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
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  m.items[itemId] = applyTransition({ ...item, review }, to, "reviewer", reason);
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
): Promise<TrackedItem> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  const prevState = item.state;
  const next = applyTransition(item, to, actor, reason);
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

  ipcMain.handle("nestbrain:orchestrator:getState", async () => {
    await ensureManifest();
    return snapshot();
  });
  ipcMain.handle("nestbrain:orchestrator:refresh", async () => {
    await pollNow(true);
    return snapshot();
  });
  ipcMain.handle(
    "nestbrain:orchestrator:requestTransition",
    async (_e, itemId: string, to: LifecycleState, reason?: string) => {
      try {
        const item = await requestTransition(itemId, to, "user", reason);
        return { ok: true as const, item };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle("nestbrain:orchestrator:setIntakePaused", async (_e, paused: boolean) => {
    await setIntakePaused(Boolean(paused));
    return snapshot();
  });
  ipcMain.handle(
    "nestbrain:orchestrator:linkRepo",
    async (_e, owner: string, name: string, localPath: string) => {
      try {
        await validateRepoOrigin(localPath, owner, name);
        const links = await ensureRepoLinks();
        links.repos[repoKey(owner, name)] = { localPath, linkedAt: new Date().toISOString() };
        await saveRepoLinks(deps!.repoLinksFilePath, links);
        await reconcileFromCache();
        return { ok: true as const, localPath };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "nestbrain:orchestrator:cloneRepo",
    async (_e, owner: string, name: string, destParent: string, accountId?: string) => {
      try {
        const token = await tokenForRepo(owner, name, accountId);
        if (!token) throw new Error("no GitHub account token available");
        const localPath = await cloneGitHubRepo(owner, name, destParent, token);
        const links = await ensureRepoLinks();
        links.repos[repoKey(owner, name)] = { localPath, linkedAt: new Date().toISOString() };
        await saveRepoLinks(deps!.repoLinksFilePath, links);
        await reconcileFromCache();
        return { ok: true as const, localPath };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle("nestbrain:orchestrator:listRepos", async () => {
    const links = await ensureRepoLinks();
    const seen = new Map<string, RepoRef>();
    for (const map of items.values()) {
      for (const item of map.values()) {
        seen.set(repoKey(item.repo.owner, item.repo.name), item.repo);
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
  ipcMain.handle("nestbrain:orchestrator:getPlan", async (_e, itemId: string) => {
    const m = await ensureManifest();
    const ref = m.items[itemId]?.plan?.ref;
    if (!ref) return null;
    return readStoredPlan(deps!.plansDir, ref);
  });
  // Replay for renderers that mount mid-run; live events ride the per-item channel.
  ipcMain.handle("nestbrain:coding:getEvents", (_e, itemId: string) => {
    return codingEvents.get(itemId) ?? [];
  });
  // Open the draft PR from human-review, or push a fix round's updates (#11).
  ipcMain.handle("nestbrain:orchestrator:openPr", async (_e, itemId: string) => {
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
    requestTransition,
    completePlan,
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    plansDir: orchestratorDeps.plansDir,
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
      const link = repoLinks?.repos[repoKey(item.repo.owner, item.repo.name)];
      if (!link) throw new Error(`repo ${item.repo.owner}/${item.repo.name} is not linked`);
      const token = await tokenForRepo(item.repo.owner, item.repo.name, item.accountId);
      await fetchOrigin(link.localPath, token);
      const baseRef = await resolveBaseRef(link.localPath, link.baseBranch);
      return ensureWorktree({
        repoPath: link.localPath,
        worktreePath: worktreeDirFor(orchestratorDeps.worktreesDir, item.repo, item.number),
        branch: branchFor(item.number),
        baseRef,
      });
    },
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    emitEvent: emitCodingEvent,
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
  });

  initShepherd({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getTokenProvider: (item) => (force) => deps!.getToken(item.accountId, force),
    getRepoPath: repoPathFor,
    getBaseBranch: async (item) => {
      const link = repoLinks?.repos[repoKey(item.repo.owner, item.repo.name)];
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
