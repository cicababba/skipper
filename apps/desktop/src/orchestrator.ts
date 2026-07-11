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
  type OrchestratorManifest,
} from "@nestbrain/core";
import type {
  Account,
  Issue,
  LifecycleState,
  PullRequest,
  TrackedItem,
  TransitionActor,
} from "@nestbrain/shared";
import { loadCursors, saveCursors, type InboxCursorFile } from "./inbox-cursor-store";

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
    const result = await pollGitHubAccount({
      accountId,
      getToken: (force) => deps!.getToken(accountId, force),
      cursor,
    });

    let map = items.get(accountId);
    if (result.mode === "full" || !map) {
      map = new Map();
      items.set(accountId, map);
      lastFullWalkAt.set(accountId, Date.now());
    }
    for (const item of [...result.issues, ...result.pullRequests]) {
      map.set(item.id, item);
    }
    // Closed issues leave the inbox; closed/merged PRs stay (terminal state
    // is signal for shepherding/review).
    for (const [id, item] of map) {
      if (item.kind === "issue" && item.state === "closed") map.delete(id);
    }

    const m = await ensureManifest();
    const outcome = reconcile(
      m,
      accountId,
      { mode: result.mode, issues: result.issues, pullRequests: result.pullRequests },
      { intakePaused: m.settings.intakePaused },
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
  }
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
  const next = applyTransition(item, to, actor, reason);
  m.items[itemId] = next;
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
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
