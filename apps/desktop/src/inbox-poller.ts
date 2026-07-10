import { ipcMain, type BrowserWindow } from "electron";
import {
  pollGitHubAccount,
  emptyGitHubCursor,
  GitHubApiError,
  GitHubAuthError,
} from "@nestbrain/core";
import type { Account, Issue, PullRequest } from "@nestbrain/shared";
import { loadCursors, saveCursors, type InboxCursorFile } from "./inbox-cursor-store";

// Thin, disposable inbox poller (issue #5): keeps a per-account snapshot of
// assigned issues + authored PRs fresh via the core GitHub adapter, and
// pushes it to the renderer. The orchestrator (#6) will absorb this loop.

export interface InboxAccountState {
  accountId: string;
  status: "idle" | "polling" | "error" | "auth-error";
  lastSyncAt?: number;
  /** Epoch ms before which polls are skipped (rate-limit backoff). */
  nextPollAt?: number;
  error?: string;
  issues: Issue[];
  pullRequests: PullRequest[];
}

export interface InboxState {
  status: "idle" | "polling";
  accounts: Record<string, InboxAccountState>;
}

export interface InboxPollerDeps {
  getAccounts: () => Account[];
  getToken: (accountId: string, forceRefresh?: boolean) => Promise<string | null>;
  cursorFilePath: string;
}

const FIRST_POLL_DELAY_MS = 10_000;
const POLL_EVERY_MS = 3 * 60_000;
const FULL_WALK_EVERY_MS = 6 * 60 * 60_000;
const POKE_DEBOUNCE_MS = 1500;

let state: InboxState = { status: "idle", accounts: {} };
let deps: InboxPollerDeps | null = null;
let getWindow: () => BrowserWindow | null = () => null;
let cursors: InboxCursorFile | null = null;
let polling = false;
// item maps survive delta polls; state arrays are derived snapshots
const items = new Map<string, Map<string, Issue | PullRequest>>();
const lastFullWalkAt = new Map<string, number>();

function set(next: InboxState): void {
  state = next;
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("nestbrain:inbox:stateChanged", state);
  }
}

function patchAccount(accountId: string, patch: Partial<InboxAccountState>): void {
  const current: InboxAccountState = state.accounts[accountId] ?? {
    accountId,
    status: "idle",
    issues: [],
    pullRequests: [],
  };
  set({
    ...state,
    accounts: { ...state.accounts, [accountId]: { ...current, ...patch } },
  });
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
  const existing = state.accounts[accountId];
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
  set({ ...state, status: "polling" });
  try {
    if (!cursors) cursors = await loadCursors(deps.cursorFilePath);

    const accounts = deps.getAccounts();
    const known = new Set(accounts.map((a) => a.id));

    // Accounts signed out since the last tick: prune state + cursors.
    let pruned = false;
    for (const accountId of Object.keys(state.accounts)) {
      if (!known.has(accountId)) {
        const { [accountId]: _gone, ...rest } = state.accounts;
        state = { ...state, accounts: rest };
        items.delete(accountId);
        delete cursors.github[accountId];
        pruned = true;
      }
    }
    if (pruned) {
      await saveCursors(deps.cursorFilePath, cursors);
      set({ ...state });
    }

    for (const account of accounts) {
      await pollAccount(account, ignoreBackoff);
    }
  } finally {
    polling = false;
    set({ ...state, status: "idle" });
  }
}

let pokeTimer: NodeJS.Timeout | null = null;

/** Debounced out-of-band re-poll — fired on auth changes. */
export function pokeInboxPoller(): void {
  if (!deps) return;
  if (pokeTimer) clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => {
    pokeTimer = null;
    void pollNow().catch(() => { /* per-account errors already captured */ });
  }, POKE_DEBOUNCE_MS);
}

export function initInboxPoller(
  windowGetter: () => BrowserWindow | null,
  pollerDeps: InboxPollerDeps,
): void {
  getWindow = windowGetter;
  deps = pollerDeps;

  ipcMain.handle("nestbrain:inbox:getState", () => state);
  ipcMain.handle("nestbrain:inbox:refresh", async () => {
    await pollNow(true);
    return state;
  });

  setTimeout(() => void pollNow().catch(() => { /* keep loop alive */ }), FIRST_POLL_DELAY_MS);
  setInterval(() => void pollNow().catch(() => { /* keep loop alive */ }), POLL_EVERY_MS);
}
