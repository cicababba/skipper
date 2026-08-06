import {
  issueSourceForAuthProvider,
  reconcile,
  resolveProjectRepos,
  type IssueSource,
  type OrchestratorManifest,
  type ReconcileOutcome,
} from "@skipper/core";
import { mappingHost } from "@skipper/shared";
import type {
  Account,
  CodeHostId,
  Issue,
  OrchestratorAccountState,
  PullRequest,
  SourceRef,
  TrackedItem,
  UnmappedProject,
} from "@skipper/shared";
import type { InboxCursorFile } from "./inbox-cursor-store";
import {
  admissionPolicy,
  shouldSkipPoll,
  selectPollCursor,
  pollFailurePatch,
} from "./poll-policy";

const FULL_WALK_EVERY_MS = 6 * 60 * 60_000;
// Per-poll ceiling on dependency fetches (#85): one API call per target, so cap
// the fan-out. Admission candidates are fetched before tracked items.
const DEP_FETCH_CAP = 30;

export interface PollerDeps {
  /** Accounts whose auth provider backs an issue source. */
  getAccounts: () => Account[];
  /** Token for the account with this key (Account.key), refreshed if needed. */
  getToken: (accountKey: string, forceRefresh?: boolean) => Promise<string | null>;
  /** The connected account that authenticates a code host for an item. */
  codeHostAccountFor: (codeHost: CodeHostId, preferKey?: string) => Account | undefined;
  loadCursors: () => Promise<InboxCursorFile>;
  saveCursors: (c: InboxCursorFile) => Promise<void>;
  ensureManifest: () => Promise<OrchestratorManifest>;
  saveManifest: (m: OrchestratorManifest) => Promise<void>;
  ensureRepoLinks: () => Promise<unknown>;
  broadcast: () => void;
  /** pokePlanner + pokeCoder + pokeReviewer + pokeShepherd, in that order. */
  pokeDrivers: () => void;
  /** Abort a live planning run reconcile moved out of "planning" (#307). */
  cancelPlanningRun: (itemId: string) => void;
  sweepStaleness: () => void;
  now?: () => number;
}

export interface Poller {
  pollNow(ignoreBackoff?: boolean): Promise<void>;
  reconcileFromCache(): Promise<void>;
  /** refresh(full): clear delta cursors + full-walk timers, persist. */
  resetForFullWalk(): Promise<void>;
  status(): "idle" | "polling";
  accountsState(): Record<string, OrchestratorAccountState>;
  unmappedProjects(): UnmappedProject[];
  getCached(accountId: string, itemId: string): Issue | PullRequest | undefined;
  cachedByAccount(): Iterable<[string, Map<string, Issue | PullRequest>]>;
  cachedFor(accountId: string): Map<string, Issue | PullRequest> | undefined;
  allCached(): Iterable<Issue | PullRequest>;
  /** untrackItem: drop from the raw cache, re-derive, patchAccount. */
  dropCached(accountId: string, itemId: string): void;
  /** closeItemOnTracker: flip the cached issue to closed, re-derive, patchAccount. */
  markCachedIssueClosed(accountId: string, itemId: string): void;
}

function byUpdatedAtDesc(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * The inbox poller (#5, absorbed by the orchestrator loop in #6). Owns the raw
 * per-account item cache, the derived account snapshots, the delta cursors and
 * the full-walk timers; every reader goes through the returned handle.
 */
export function makePoller(deps: PollerDeps): Poller {
  const now = (): number => (deps.now ? deps.now() : Date.now());

  // An item's PRs arrive under the account that authenticates its code host, which
  // on a cross-platform repo isn't its tracker account (#328).
  const codeHostAccountIdFor = (i: TrackedItem): string =>
    deps.codeHostAccountFor(i.codeHost, i.accountId)?.key ?? i.accountId;

  let status: "idle" | "polling" = "idle";
  let accountsState: Record<string, OrchestratorAccountState> = {};
  let cursors: InboxCursorFile | null = null;
  let polling = false;
  // item maps survive delta polls; state arrays are derived snapshots
  const items = new Map<string, Map<string, Issue | PullRequest>>();
  const lastFullWalkAt = new Map<string, number>();
  // accountId → tracker projects with open, still-repo-less issues (#79). In-memory
  // only (stale across restarts otherwise); recomputed from the full derived cache.
  const unmappedProjects = new Map<string, UnmappedProject[]>();

  function patchAccount(accountId: string, patch: Partial<OrchestratorAccountState>): void {
    const current: OrchestratorAccountState = accountsState[accountId] ?? {
      accountId,
      status: "idle",
      issues: [],
      pullRequests: [],
    };
    accountsState = { ...accountsState, [accountId]: { ...current, ...patch } };
    deps.broadcast();
  }

  function deriveArrays(accountId: string): { issues: Issue[]; pullRequests: PullRequest[] } {
    const map = items.get(accountId) ?? new Map();
    const issues: Issue[] = [];
    const pullRequests: PullRequest[] = [];
    for (const item of map.values()) {
      if (item.kind === "issue") issues.push(item);
      else pullRequests.push(item);
    }
    return {
      issues: issues.sort(byUpdatedAtDesc),
      pullRequests: pullRequests.sort(byUpdatedAtDesc),
    };
  }

  /**
   * Fills repo-less tracker issues from the project→repo mapping before reconcile
   * (#79), and refreshes this account's unmappedProjects warning surface. The
   * returned issues drive reconcile (delta-correct — closed deltas are preserved);
   * the warning counts come from the full derived cache so a delta poll never
   * understates them.
   */
  function resolveAccountIssues(
    accountId: string,
    issues: Issue[],
    m: OrchestratorManifest,
  ): Issue[] {
    const account = deps.getAccounts().find((a) => a.key === accountId);
    const host = mappingHost(account?.baseUrl);
    const resolved = resolveProjectRepos(issues, { accountId, host }, m.projectMappings).issues;
    const { unmapped } = resolveProjectRepos(
      deriveArrays(accountId).issues,
      { accountId, host },
      m.projectMappings,
    );
    if (unmapped.length) unmappedProjects.set(accountId, unmapped);
    else unmappedProjects.delete(accountId);
    return resolved;
  }

  /**
   * Dependency evidence (#85): fetch "blocked by" for admission candidates and
   * resting/blocked tracked items, so reconcile can park/release in this round.
   * Candidates first; per-target failure leaves the key absent (stored stands).
   * Runs on every admission path (#307) — a retroactive admission from the cache
   * would otherwise admit a blocked issue blind and let the planner promote it.
   */
  async function collectDependencies(
    accountId: string,
    account: Account,
    source: IssueSource,
    resolvedIssues: Issue[],
    m: OrchestratorManifest,
  ): Promise<Record<string, SourceRef[]> | undefined> {
    if (!source.fetchDependencies) return undefined;
    const policy = admissionPolicy(m);
    const candidates = resolvedIssues.filter((iss) => {
      if (iss.state !== "open") return false;
      const t = m.items[iss.id];
      if (t) {
        return (
          t.state === "triage" ||
          t.state === "plan-gate" ||
          t.state === "queued" ||
          t.state === "blocked"
        );
      }
      return !m.settings.intakePaused && policy.shouldAdmit(iss);
    });
    candidates.sort((a, b) => Number(Boolean(m.items[a.id])) - Number(Boolean(m.items[b.id])));
    const dependencies: Record<string, SourceRef[]> = {};
    for (const iss of candidates.slice(0, DEP_FETCH_CAP)) {
      try {
        dependencies[iss.id] = await source.fetchDependencies(
          iss,
          (force) => deps.getToken(accountId, force),
          account.baseUrl,
          account.cloudId,
          account.authMethod,
        );
      } catch (err) {
        console.warn(`[orchestrator] dependency fetch failed for ${iss.id}: ${String(err)}`);
      }
    }
    return dependencies;
  }

  /** Reconcile writes the manifest directly, so requestTransition's abort hook never
   *  fires for it — free the planning slot of anything it moved out of planning (#307). */
  function cancelPlanningRunsFor(outcome: ReconcileOutcome): void {
    for (const t of outcome.transitions) {
      if (t.from === "planning") deps.cancelPlanningRun(t.itemId);
    }
  }

  async function pollAccount(account: Account, ignoreBackoff: boolean): Promise<void> {
    if (!cursors) return;
    const source = issueSourceForAuthProvider(account.provider);
    if (!source) return;
    // The account key is the identity: item maps, accountsState, cursors and the
    // manifest's accountId are all keyed by it (#101).
    const accountId = account.key;
    const existing = accountsState[accountId];
    if (shouldSkipPoll(existing, now(), ignoreBackoff)) return;

    const { cursor } = selectPollCursor({
      now: now(),
      lastFullWalkAt: lastFullWalkAt.get(accountId) ?? 0,
      storedCursor: cursors.platforms[source.id]?.[accountId],
      fullWalkEveryMs: FULL_WALK_EVERY_MS,
    });

    patchAccount(accountId, { status: "polling" });
    try {
      const m = await deps.ensureManifest();
      // Tracked PRs (#11): reviews/CI don't bump updated_at, so deltas alone
      // would never surface them — hydrate them unconditionally each poll.
      const deepHydrate = Object.values(m.items)
        .filter(
          (i) =>
            codeHostAccountIdFor(i) === accountId &&
            i.pr &&
            (i.state === "pr-open" || i.state === "in-review" || i.state === "changes-requested"),
        )
        .map((i) => ({ owner: i.repo.owner, name: i.repo.name, number: i.pr!.number }));

      const result = await source.poll({
        accountId,
        getToken: (force) => deps.getToken(accountId, force),
        baseUrl: account.baseUrl,
        cloudId: account.cloudId,
        authMethod: account.authMethod,
        cursor,
        deepHydrate,
      });

      let map = items.get(accountId);
      if (result.mode === "full" || !map) {
        map = new Map();
        items.set(accountId, map);
        lastFullWalkAt.set(accountId, now());
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

      await deps.ensureRepoLinks();

      // Fill repo-less tracker issues from the project→repo mapping (#79) and
      // refresh the unmapped-projects warning surface before reconcile.
      const resolvedIssues = resolveAccountIssues(accountId, result.issues, m);

      const dependencies = await collectDependencies(accountId, account, source, resolvedIssues, m);

      const outcome = reconcile(
        m,
        accountId,
        {
          mode: result.mode,
          issues: resolvedIssues,
          pullRequests: result.pullRequests,
          dependencies,
          codeHostAccountId: codeHostAccountIdFor,
        },
        admissionPolicy(m),
      );
      for (const conflict of outcome.conflicts) {
        console.warn(`[orchestrator] conflict on ${conflict.itemId}: ${conflict.detail}`);
      }
      cancelPlanningRunsFor(outcome);
      await deps.saveManifest(m);

      (cursors.platforms[source.id] ??= {})[accountId] = result.cursor;
      await deps.saveCursors(cursors);

      patchAccount(accountId, {
        status: "idle",
        lastSyncAt: now(),
        nextPollAt: undefined,
        error: undefined,
        ...deriveArrays(accountId),
      });
    } catch (err) {
      patchAccount(accountId, pollFailurePatch(err, now()));
    }
  }

  async function pollNow(ignoreBackoff = false): Promise<void> {
    if (polling) return;
    polling = true;
    status = "polling";
    deps.broadcast();
    try {
      if (!cursors) cursors = await deps.loadCursors();
      await deps.ensureManifest();

      const accounts = deps.getAccounts();
      const known = new Set(accounts.map((a) => a.key));

      // Accounts signed out since the last tick: prune poll state + cursors.
      // Manifest items survive sign-out so lifecycle state outlives re-login.
      let pruned = false;
      for (const accountId of Object.keys(accountsState)) {
        if (!known.has(accountId)) {
          const { [accountId]: _gone, ...rest } = accountsState;
          accountsState = rest;
          items.delete(accountId);
          unmappedProjects.delete(accountId);
          for (const perPlatform of Object.values(cursors.platforms)) {
            delete perPlatform?.[accountId];
          }
          pruned = true;
        }
      }
      if (pruned) {
        await deps.saveCursors(cursors);
        deps.broadcast();
      }

      for (const account of accounts) {
        await pollAccount(account, ignoreBackoff);
      }
    } finally {
      polling = false;
      status = "idle";
      deps.broadcast();
      deps.pokeDrivers();
      deps.sweepStaleness();
    }
  }

  /**
   * Re-runs reconcile from the cached per-account item maps — used after a repo
   * link/clone so already-seen issues admit retroactively without waiting for
   * the next delta poll (which would not re-send unchanged items). Delta mode:
   * the absence walk must never fire on a partial cache.
   */
  async function reconcileFromCache(): Promise<void> {
    const m = await deps.ensureManifest();
    await deps.ensureRepoLinks();
    let changed = false;
    for (const accountId of items.keys()) {
      const account = deps.getAccounts().find((a) => a.key === accountId);
      const source = account ? issueSourceForAuthProvider(account.provider) : undefined;
      if (!account || !source) continue;
      const { issues, pullRequests } = deriveArrays(accountId);
      const resolvedIssues = resolveAccountIssues(accountId, issues, m);
      const dependencies = await collectDependencies(accountId, account, source, resolvedIssues, m);
      const outcome = reconcile(
        m,
        accountId,
        {
          mode: "delta",
          issues: resolvedIssues,
          pullRequests,
          dependencies,
          codeHostAccountId: codeHostAccountIdFor,
        },
        admissionPolicy(m),
      );
      cancelPlanningRunsFor(outcome);
      // Evidence can land without a transition (a dep on an untracked ref writes
      // blockedBy and parks nothing) — that write must be persisted too.
      if (
        outcome.admitted.length > 0 ||
        outcome.transitions.length > 0 ||
        Object.keys(dependencies ?? {}).length > 0
      ) {
        changed = true;
      }
    }
    if (changed) {
      await deps.saveManifest(m);
    }
    deps.broadcast();
    deps.pokeDrivers();
  }

  return {
    pollNow,
    reconcileFromCache,
    async resetForFullWalk(): Promise<void> {
      if (!cursors) cursors = await deps.loadCursors();
      cursors.platforms = {};
      lastFullWalkAt.clear();
      await deps.saveCursors(cursors);
    },
    status: () => status,
    accountsState: () => accountsState,
    unmappedProjects: () => [...unmappedProjects.values()].flat(),
    getCached: (accountId, itemId) => items.get(accountId)?.get(itemId),
    cachedByAccount: () => items,
    cachedFor: (accountId) => items.get(accountId),
    allCached: function* () {
      for (const map of items.values()) yield* map.values();
    },
    dropCached(accountId, itemId) {
      items.get(accountId)?.delete(itemId);
      patchAccount(accountId, deriveArrays(accountId));
    },
    markCachedIssueClosed(accountId, itemId) {
      const cached = items.get(accountId)?.get(itemId);
      if (cached?.kind !== "issue") return;
      cached.state = "closed";
      cached.updatedAt = new Date().toISOString();
      patchAccount(accountId, deriveArrays(accountId));
    },
  };
}
