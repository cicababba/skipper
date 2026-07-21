import { ipcMain, type BrowserWindow } from "electron";
import {
  issueSourceForAuthProvider,
  reconcile,
  remapProjectItems,
  resolveProjectRepos,
  applyTransition,
  loadOrCreateOrchestratorManifest,
  saveOrchestratorManifest,
  ApiError,
  AuthError,
  listUserInstallationRepos,
  listMembershipProjects,
  listJiraProjects,
  codeHosts,
  codeHostFor,
  codeHostForProvider,
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
  type IssueComment,
  type OrchestratorManifest,
  type OrchestratorSettings,
} from "@skipper/core";
import {
  formatRepoMappingValue,
  issueBranchFor,
  latestPlanningTransitionAt,
  mappingHost,
  parseProjectMappingKey,
  parseRepoMappingValue,
  projectMappingKey,
  repoKey,
  resolveRepoIntakeSettings,
  resolveRepoOrchestratorSettings,
} from "@skipper/shared";
import type {
  Account,
  AgentReview,
  AuthProviderId,
  CodeHostId,
  CodingEvent,
  CodingEventEnvelope,
  ConfidenceReport,
  FollowCandidate,
  FollowCandidatesResult,
  Issue,
  LifecycleState,
  ListRepoBranchesResult,
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
  SourceRef,
  TrackedItem,
  TrackerProjectsResult,
  TransitionActor,
  UnmappedProject,
  ArchiveItemResult,
  UntrackItemResult,
} from "@skipper/shared";
import { loadCursors, saveCursors, type InboxCursorFile } from "./inbox-cursor-store";
import { runGit } from "./git";
import {
  cloneRepo,
  listRemoteHeads,
  loadRepoLinks,
  saveRepoLinks,
  validateRepoOrigin,
  type RepoLinksFile,
} from "./repo-links";
import { resolveBaseChangeActions, type WorktreeProbe } from "./base-change";
import { readLlmSettings, readLlmSettingsSync } from "./llm-settings";
import { archiveStoredPlan, readStoredPlan, updateStoredPlan } from "./plan-store";
import { readStoredCoderReport } from "./report-store";
import { deletePlanChat } from "./plan-chat-store";
import {
  initPlanChat,
  sendPlanChatMessage,
  applyPlanChatUpdate,
  getPlanChatHistory,
  cancelPlanChat,
} from "./plan-chat";
import {
  initRescore,
  startRescore,
  cancelRescore,
  killAllRescores,
} from "./rescore";
import { initPlanner, pokePlanner, cancelPlanningRun, killAllPlanningRuns } from "./planner";
import { initCoder, pokeCoder, cancelCodingRun, killAllCodingRuns } from "./coder";
import { initReviewer, pokeReviewer } from "./reviewer";
import { initShepherd, pokeShepherd, openOrPushPr } from "./shepherd";
import {
  captureWorktreeDiff,
  discardWorktree,
  ensureWorktree,
  fetchOrigin,
  listWorktreeChanges,
  parseRemoteBranches,
  readWorktreeFileVersions,
  refreshWorktreeBase,
  resolveBaseRef,
  worktreeDirFor,
  worktreeDirtyFiles,
  worktreeStatus,
  writeWorktreeFile,
} from "./worktrees";

export { killAllCodingRuns, killAllPlanningRuns, killAllRescores };

// Orchestrator loop (issue #6): absorbs the issue-#5 inbox poller. Keeps
// per-account snapshots of assigned issues + authored PRs fresh via the core
// GitHub adapter, reconciles every poll into the lifecycle manifest, and
// pushes state to the renderer.

export type { OrchestratorAccountState, OrchestratorState } from "@skipper/shared";

export interface OrchestratorDeps {
  getAccounts: () => Account[];
  /** Token for the account with this key (Account.key), refreshed if needed. */
  getToken: (accountKey: string, forceRefresh?: boolean) => Promise<string | null>;
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
// Per-poll ceiling on dependency fetches (#85): one API call per target, so cap
// the fan-out. Admission candidates are fetched before tracked items.
const DEP_FETCH_CAP = 30;

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
// accountId → tracker projects with open, still-repo-less issues (#79). In-memory
// only (stale across restarts otherwise); recomputed from the full derived cache.
const unmappedProjects = new Map<string, UnmappedProject[]>();

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
    projectMappings: manifest?.projectMappings ?? {},
    unmappedProjects: [...unmappedProjects.values()]
      .flat()
      .sort((a, b) => `${a.host}:${a.projectKey}`.localeCompare(`${b.host}:${b.projectKey}`)),
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

// Reviewer console stream (#113): same machinery, own channel pair. The
// reviewer runs no tools, so there is no memory-use bookkeeping here.
const reviewEvents = new Map<string, CodingEventEnvelope[]>();
const reviewEventSeq = new Map<string, number>();

function emitReviewEvent(itemId: string, event: CodingEvent): void {
  // Every review round opens with a fetching status: reset so replay never
  // mixes rounds (mirrors the coding buffer-reset heuristic).
  if (event.kind === "status" && event.phase === "fetching") {
    reviewEvents.set(itemId, []);
    reviewEventSeq.set(itemId, 0);
  }
  const seq = reviewEventSeq.get(itemId) ?? 0;
  reviewEventSeq.set(itemId, seq + 1);
  const envelope: CodingEventEnvelope = { itemId, seq, at: new Date().toISOString(), event };
  const buffer = reviewEvents.get(itemId) ?? [];
  buffer.push(envelope);
  if (buffer.length > CODING_EVENT_BUFFER_MAX) buffer.shift();
  reviewEvents.set(itemId, buffer);
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(`skipper:review:event:${itemId}`, envelope);
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
    // Pass known accounts so persisted bare-id accountIds resolve to keys (#101);
    // an empty list (no accounts yet) skips resolution rather than mass-dropping.
    manifest = await loadOrCreateOrchestratorManifest(
      deps.manifestFilePath,
      deps.getAccounts().map((a) => ({ id: a.id, key: a.key })),
      (msg) => console.warn(`[orchestrator] ${msg}`),
    );
    // Crash safety (#164): a rescore run never survives a restart, so a persisted
    // rescoring flag is always stale. Clear it before anything reads the manifest.
    for (const item of Object.values(manifest.items)) {
      if (item.plan?.rescoring) delete item.plan.rescoring;
    }
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
  plannerMaxTurns: clampInt(10, 200),
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
    deps ? readLlmSettingsSync(deps.dataDir).claudeModel : undefined,
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

/** The connected account that authenticates a code host: prefer the one whose key
 *  matches preferKey (the item's tracker account, when it is also a code-host
 *  account), else the first account of the host's auth provider. */
function codeHostAccountFor(codeHost: CodeHostId, preferKey?: string): Account | undefined {
  const provider = codeHostFor(codeHost).authProvider;
  const accounts = (deps?.getAccounts() ?? []).filter((a) => a.provider === provider);
  if (preferKey) {
    const preferred = accounts.find((a) => a.key === preferKey);
    if (preferred) return preferred;
  }
  return accounts[0];
}

/** Comments for the item's issue, fetched fresh at plan/code time (#144). Best-effort
 *  is the caller's job: adapter errors propagate so the planner/coder loop emits its
 *  warning event (mirrors the fetchDependencies split). [] when the source has no
 *  comment capability or the poll cache lacks the issue. */
function fetchIssueCommentsFor(item: TrackedItem): Promise<IssueComment[]> {
  const account = deps?.getAccounts().find((a) => a.key === item.accountId);
  const source = account ? issueSourceForAuthProvider(account.provider) : undefined;
  const cached = items.get(item.accountId)?.get(item.id);
  if (!account || !source?.fetchComments || cached?.kind !== "issue") return Promise.resolve([]);
  return source.fetchComments(
    cached,
    (force) => deps!.getToken(account.key, force),
    account.baseUrl,
    account.cloudId,
  );
}

/** Account for cloning: explicit account key, else the code-host account behind the
 *  item that sees the repo, else the first issue account. Carries provider + baseUrl. */
function accountForRepo(owner: string, name: string, accountKey?: string): Account | undefined {
  if (!deps) return undefined;
  if (accountKey) {
    return deps.getAccounts().find((a) => a.key === accountKey);
  }
  const key = repoKey({ owner, name });
  for (const [acctKey, map] of items) {
    for (const item of map.values()) {
      if (item.repo && repoKey(item.repo) === key) {
        return codeHostAccountFor(item.codeHost, acctKey);
      }
    }
  }
  return issueAccounts()[0];
}

/** Confirms localPath is a clone of owner/name on some registered code host, trying
 *  each host's cloud default and its accounts' self-hosted baseUrls. Throws the last
 *  origin-mismatch error when nothing matches. */
async function detectHostForLocalPath(
  owner: string,
  name: string,
  localPath: string,
): Promise<void> {
  const repo = { owner, name };
  const accounts = deps?.getAccounts() ?? [];
  let lastErr: unknown;
  for (const host of Object.values(codeHosts)) {
    const urls = accounts
      .filter((a) => a.provider === host.authProvider)
      .map((a) => a.baseUrl)
      .filter((u): u is string => u !== undefined);
    // undefined (the host's cloud/fixed default) stays first; self-hosted baseUrls follow.
    for (const baseUrl of [undefined, ...new Set(urls)]) {
      try {
        await validateRepoOrigin(localPath, repo, host, baseUrl);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Branch list + default branch of a local clone's origin, shared by the branch-listing
 *  and link-inspect IPC handlers. */
async function branchesForLocalClone(localPath: string): Promise<ListRepoBranchesResult> {
  const refs = await runGit(localPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin",
  ]);
  if (refs.code !== 0) {
    return { ok: false, error: refs.stderr.trim() || `git exit ${refs.code}` };
  }
  const branches = parseRemoteBranches(refs.stdout);
  const defaultBranch = await resolveBaseRef(localPath, undefined)
    .then((ref) => ref.replace(/^origin\//, ""))
    .catch(() => undefined);
  return { ok: true, branches, defaultBranch };
}

// Planner concurrency (2) and the coder can hit the same clone at once; git
// fetch + worktree add on a shared clone are not concurrency-safe, so serialize
// per repo. The map is bounded by the linked-repo count.
const repoGitLocks = new Map<string, Promise<unknown>>();

function withRepoGitLock<T>(repo: RepoRef, fn: () => Promise<T>): Promise<T> {
  const key = repoKey(repo);
  const prev = repoGitLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoGitLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Sets up the worktree that every phase (plan → coding → review) shares (#110):
 * fetch origin, resolve the base ref, ensure the branch's worktree. Coding
 * passes `refreshBase` so a reused, possibly-stale worktree resets to the fresh
 * base when it has no work of its own. Serialized per repo.
 */
function prepareWorktreeFor(
  item: TrackedItem,
  opts: { refreshBase?: boolean } = {},
): Promise<{ path: string; branch: string }> {
  return withRepoGitLock(item.repo, async () => {
    const link = repoLinks?.repos[repoKey(item.repo)];
    if (!link) throw new Error(`repo ${item.repo.owner}/${item.repo.name} is not linked`);
    const account = codeHostAccountFor(item.codeHost, item.accountId);
    const token = account ? await deps!.getToken(account.key) : null;
    await fetchOrigin(
      link.localPath,
      token ? codeHostFor(item.codeHost).pushCredentials(token) : undefined,
    );
    const baseRef = await resolveBaseRef(link.localPath, link.baseBranch);
    const wt = await ensureWorktree({
      repoPath: link.localPath,
      worktreePath: worktreeDirFor(deps!.worktreesDir, item.repo, item.key),
      branch: issueBranchFor(item.key),
      baseRef,
    });
    // created:true = just cut from the fresh baseRef, nothing to refresh.
    if (opts.refreshBase && !wt.created) {
      await refreshWorktreeBase(wt.path, baseRef).catch((err) =>
        console.warn(`base refresh skipped for ${wt.path}: ${err}`),
      );
    }
    return wt;
  });
}

function admissionPolicy(m: OrchestratorManifest): {
  intakePaused: boolean;
  shouldAdmit: (issue: Issue) => boolean;
} {
  return {
    intakePaused: m.settings.intakePaused,
    // Follow list (#15): default-all — an absent record means followed. Ignored
    // repos' issues stay in the raw inbox arrays; linking still gates planning.
    // A repo-less issue (unmapped project, #79) is never followed.
    shouldAdmit: (issue) =>
      issue.repo !== undefined &&
      resolveRepoIntakeSettings(m.repoSettings[repoKey(issue.repo)]).followed,
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
  const account = deps?.getAccounts().find((a) => a.key === accountId);
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

async function pollAccount(account: Account, ignoreBackoff: boolean): Promise<void> {
  if (!deps || !cursors) return;
  const source = issueSourceForAuthProvider(account.provider);
  if (!source) return;
  // The account key is the identity: item maps, accountsState, cursors and the
  // manifest's accountId are all keyed by it (#101).
  const accountId = account.key;
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
      cloudId: account.cloudId,
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

    // Fill repo-less tracker issues from the project→repo mapping (#79) and
    // refresh the unmapped-projects warning surface before reconcile.
    const resolvedIssues = resolveAccountIssues(accountId, result.issues, m);

    // Dependency evidence (#85): fetch "blocked by" for admission candidates and
    // resting/blocked tracked items, so reconcile can park/release in this round.
    // Candidates first; per-target failure leaves the key absent (stored stands).
    let dependencies: Record<string, SourceRef[]> | undefined;
    if (source.fetchDependencies) {
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
      dependencies = {};
      for (const iss of candidates.slice(0, DEP_FETCH_CAP)) {
        try {
          dependencies[iss.id] = await source.fetchDependencies(
            iss,
            (force) => deps!.getToken(accountId, force),
            account.baseUrl,
          );
        } catch (err) {
          console.warn(`[orchestrator] dependency fetch failed for ${iss.id}: ${String(err)}`);
        }
      }
    }

    const outcome = reconcile(
      m,
      accountId,
      {
        mode: result.mode,
        issues: resolvedIssues,
        pullRequests: result.pullRequests,
        dependencies,
      },
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
    const resolvedIssues = resolveAccountIssues(accountId, issues, m);
    const outcome = reconcile(
      m,
      accountId,
      { mode: "delta", issues: resolvedIssues, pullRequests },
      admissionPolicy(m),
    );
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
  expectedPlanningAt?: string,
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  // Refuse a stale run's result (#159): the item left planning, or a newer
  // planning transition superseded this run's token. Return silently — a throw
  // would bounce into the planner's catch and park the fresh lifecycle.
  if (item.state !== "planning" || latestPlanningTransitionAt(item) !== expectedPlanningAt) {
    console.warn(`stale plan completion refused for ${itemId}`);
    return;
  }
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
  const { rescoring: _drop, ...planRest } = item.plan ?? {};
  const withRef = { ...item, plan: { ...planRest, ref, confidence: confidence?.composite } };
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
 * Sets coderReport.ref + the agent-review transition in a single manifest write
 * (#146). A degraded run (no parseable report) passes reportRef undefined —
 * the field is deleted so a stale report never shows against a new diff.
 */
async function completeCoding(
  itemId: string,
  reportRef: string | undefined,
  reason: string,
): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  const { coderReport: _drop, ...rest } = item;
  const withReport = reportRef ? { ...rest, coderReport: { ref: reportRef } } : rest;
  m.items[itemId] = applyTransition(withReport, "agent-review", "coder", reason);
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  pokeReviewer();
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
  let plan = item.plan;
  if (plan?.ref) {
    const archivedRef = await archiveStoredPlan(deps.plansDir, plan.ref).catch(() => null);
    if (archivedRef) plan = { ...plan, ref: archivedRef };
  }
  void deletePlanChat(deps.plansDir, itemId).catch(() => {});
  m.items[itemId] = {
    ...item,
    worktree: undefined,
    plan,
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

/** Records the plan run's Claude session id without a transition (#111). Overwritten
 *  each plan run; cwd-scoped to worktree.path. completePlan preserves it via spread. */
async function setPlanSessionId(itemId: string, sessionId: string): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  m.items[itemId] = {
    ...item,
    plan: { ...item.plan, sessionId },
    updatedAt: new Date().toISOString(),
  };
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
}

/** Marks an item as rescoring confidence (#164) without a transition — drives the
 *  badge spinner while the detached rescore runs. */
async function setPlanRescoring(itemId: string): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) return;
  m.items[itemId] = {
    ...item,
    plan: { ...item.plan, rescoring: true },
    updatedAt: new Date().toISOString(),
  };
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
}

/** Clears the rescoring flag (#164). When a fresh composite is provided AND the item
 *  is still at the gate, it also updates plan.confidence — never a transition, so a
 *  score jump can't auto-queue coding while a human reviews. */
async function completeRescore(itemId: string, composite?: number): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) return;
  const { rescoring: _drop, ...plan } = item.plan ?? {};
  const setComposite = composite !== undefined && item.state === "plan-gate";
  m.items[itemId] = {
    ...item,
    plan: setComposite ? { ...plan, confidence: composite } : plan,
    updatedAt: new Date().toISOString(),
  };
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
}

/** Records the critic round's Claude session id without a transition (#111). On
 *  round 1 (no review yet) it seeds a stub review the reviewer/UI already handle;
 *  completeReview replaces it wholesale. The chained-round check reads only
 *  pendingObjections (absent here, preserved by spread) — unaffected. */
async function setReviewSessionId(itemId: string, sessionId: string): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  const item = m.items[itemId];
  if (!item) throw new Error(`unknown item ${itemId}`);
  const review: AgentReview = item.review
    ? { ...item.review, sessionId }
    : {
        rounds: 0,
        outcome: "unavailable",
        reason: "review in progress",
        sessionId,
        at: new Date().toISOString(),
      };
  m.items[itemId] = { ...item, review, updatedAt: new Date().toISOString() };
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
  // #110: an explicit user park from plan-gate discards the planning worktree.
  // needs-input is ALSO the coder/planner failure state — never fire on those.
  const parkedWorktree =
    actor === "user" && prevState === "plan-gate" && to === "needs-input"
      ? item.worktree
      : undefined;
  m.items[itemId] = parkedWorktree ? { ...next, worktree: undefined } : next;
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  if (parkedWorktree?.path) {
    const link = repoLinks?.repos[repoKey(item.repo)];
    if (link) {
      const worktreePath = parkedWorktree.path;
      const branch = parkedWorktree.branch;
      // Serialize with prepareWorktreeFor: a park's prune/branch-delete must not
      // race a concurrent fetch/worktree-add for another item on the same clone.
      void withRepoGitLock(item.repo, async () => {
        const baseRef = await resolveBaseRef(link.localPath, link.baseBranch).catch(() => undefined);
        await discardWorktree({ repoPath: link.localPath, worktreePath, branch, baseRef });
      }).catch((err) => console.warn(`park cleanup failed for ${worktreePath}: ${err}`));
    }
  }
  if (actor !== "planner") {
    // Someone else moved a live planning item — abort its run (#159). Guarding on
    // actor !== "planner" keeps the planner's own needs-input failure transition
    // from self-aborting.
    if (prevState === "planning") cancelPlanningRun(itemId);
    pokePlanner();
  }
  // Leaving plan-gate (approve/replan/park) aborts any live plan-review chat (#145)
  // and any in-flight confidence rescore (#164).
  if (prevState === "plan-gate") {
    cancelPlanChat(itemId);
    cancelRescore(itemId);
  }
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
  // full = force a real refetch (#120): clear the delta cursors and full-walk
  // timers so the next poll walks everything. Persisting the cleared cursor file
  // makes the reset crash-safe. If a poll is already running pollNow no-ops; the
  // next one runs full anyway since lastFullWalkAt is cleared.
  ipcMain.handle("skipper:orchestrator:refresh", async (_e, full?: boolean) => {
    if (full) {
      if (!cursors) cursors = await loadCursors(deps!.cursorFilePath);
      cursors.platforms = {};
      lastFullWalkAt.clear();
      await saveCursors(deps!.cursorFilePath, cursors);
    }
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
        // #125: explicit undefined clears a per-role model back to inherit llm.claudeModel.
        if ((patch as Record<string, unknown>)[key] === undefined) {
          if (key === "plannerModel" || key === "coderModel" || key === "reviewerModel")
            delete (m.settings as unknown as Record<string, unknown>)[key];
          continue;
        }
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
      for (const item of map.values()) if (item.repo) put(repoKey(item.repo), item.repo);
    }
    for (const item of Object.values(m.items)) {
      put(repoKey(item.repo), item.repo);
    }
    for (const key of [...Object.keys(links.repos), ...Object.keys(m.repoSettings)]) {
      const [owner, name] = key.split("/");
      if (owner && name) put(key, { owner, name });
    }
    const defaultModel = readLlmSettingsSync(deps!.dataDir).claudeModel;
    return [...repos.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, repo]) => ({
        key,
        repo,
        linked: Boolean(links.repos[key]),
        localPath: links.repos[key]?.localPath,
        settings: m.repoSettings[key] ?? {},
        resolved: resolveRepoOrchestratorSettings(m.repoSettings[key], m.settings, defaultModel),
      }));
  });
  ipcMain.handle(
    "skipper:orchestrator:listFollowCandidates",
    async (_e, accountId?: string, providerId?: AuthProviderId): Promise<FollowCandidatesResult> => {
      try {
        const account = accountId
          ? issueAccounts().find(
              (a) => a.key === accountId && (!providerId || a.provider === providerId),
            )
          : issueAccounts()[0];
        if (!account) return { ok: false, error: "no issue-source account connected" };
        const m = await ensureManifest();
        const links = await ensureRepoLinks();

        const candidates = new Map<string, FollowCandidate>();
        const describe = (key: string): Omit<FollowCandidate, "repo" | "source"> => ({
          followed: resolveRepoIntakeSettings(m.repoSettings[key]).followed,
          linked: Boolean(links.repos[key]),
        });

        let installationCount: number | undefined;
        let installUrl: string | undefined;

        if (account.provider === "github") {
          const result = await listUserInstallationRepos((force) =>
            deps!.getToken(account.key, force),
          );
          for (const repo of result.repos) {
            const key = repoKey(repo);
            candidates.set(key, {
              repo: { owner: repo.owner, name: repo.name },
              private: repo.private,
              source: "installation",
              ...describe(key),
            });
          }
          installationCount = result.installationCount;
          installUrl = result.appSlug
            ? `https://github.com/apps/${result.appSlug}/installations/new`
            : "https://github.com/settings/installations";
        } else if (account.provider === "gitlab") {
          const projects = await listMembershipProjects(
            (force) => deps!.getToken(account.key, force),
            account.baseUrl,
          );
          for (const project of projects) {
            const key = repoKey(project.repo);
            candidates.set(key, {
              repo: project.repo,
              private: project.private,
              source: "membership",
              ...describe(key),
            });
          }
        }

        // Public repos assigned via general visibility never show in the
        // installation/membership lists — merge what this account's poller saw.
        const polled = items.get(account.key);
        if (polled) {
          for (const item of polled.values()) {
            if (!item.repo) continue;
            const key = repoKey(item.repo);
            if (candidates.has(key)) continue;
            candidates.set(key, {
              repo: item.repo,
              source: "polled",
              ...describe(key),
            });
          }
        }

        return {
          ok: true,
          installationCount,
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
  // Project→repo mapping writer (#79). Validate the key via parseProjectMappingKey
  // (invalid → no-op, never coerce), rebuild the canonical key, then reconcile so a
  // fresh mapping admits cached repo-less issues and an unmapping blocks new ones.
  ipcMain.handle(
    "skipper:orchestrator:setProjectMapping",
    async (_e, mappingKey: string, repo: string | null) => {
      const m = await ensureManifest();
      const parts = parseProjectMappingKey(mappingKey);
      if (!parts) return snapshot();
      const key = projectMappingKey(parts.source, parts.host, parts.projectKey);
      if (repo) {
        const parsed = parseRepoMappingValue(repo);
        if (!parsed) return snapshot();
        m.projectMappings[key] = formatRepoMappingValue(parsed.codeHost, parsed.repo);
        // #120: migrate/flag already-tracked items pinned to the old repo.
        remapProjectItems(m, key, { repo: parsed.repo, codeHost: parsed.codeHost }, (accountId) => {
          const account = deps!.getAccounts().find((a) => a.key === accountId);
          return account ? mappingHost(account.baseUrl) : undefined;
        });
      } else {
        delete m.projectMappings[key];
      }
      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      await reconcileFromCache();
      return snapshot();
    },
  );
  // Live project listing for the mapping editor (#79). Use getAccounts directly —
  // issueAccounts() filters through the issue-source registry, which has no jira
  // entry until #78; this handler is the only path to a Jira account's projects.
  ipcMain.handle(
    "skipper:orchestrator:listTrackerProjects",
    async (_e, accountId: string): Promise<TrackerProjectsResult> => {
      const account = deps?.getAccounts().find((a) => a.key === accountId);
      if (!account) return { ok: false, error: "unknown account" };
      if (account.provider !== "jira") {
        return { ok: false, error: "account is not a Jira account" };
      }
      try {
        const projects = await listJiraProjects((force) => deps!.getToken(account.key, force), {
          cloudId: account.cloudId,
          baseUrl: account.baseUrl,
        });
        return { ok: true, source: "jira", host: mappingHost(account.baseUrl), projects };
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
    async (_e, owner: string, name: string, localPath: string, baseBranch?: string) => {
      try {
        await detectHostForLocalPath(owner, name, localPath);
        const trimmed = baseBranch?.trim();
        if (trimmed) {
          const onOrigin = async (): Promise<boolean> =>
            (await runGit(localPath, ["rev-parse", "--verify", "--quiet", `origin/${trimmed}`]))
              .code === 0;
          if (!(await onOrigin())) {
            await fetchOrigin(localPath).catch(() => {});
            if (!(await onOrigin())) {
              return { ok: false as const, error: `branch '${trimmed}' not found on origin` };
            }
          }
        }
        const links = await ensureRepoLinks();
        links.repos[repoKey({ owner, name })] = {
          localPath,
          linkedAt: new Date().toISOString(),
          ...(trimmed ? { baseBranch: trimmed } : {}),
        };
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
    async (
      _e,
      owner: string,
      name: string,
      destParent: string,
      accountId?: string,
      baseBranch?: string,
    ) => {
      try {
        const account = accountForRepo(owner, name, accountId);
        const token = account ? await deps!.getToken(account.key) : null;
        if (!token) throw new Error("no account token available for this repo");
        const hostId = account ? (codeHostForProvider(account.provider) ?? "github") : "github";
        const host = codeHostFor(hostId);
        const localPath = await cloneRepo(
          host,
          { owner, name },
          destParent,
          host.pushCredentials(token),
          account?.baseUrl,
        );
        // Fresh full clone carries every remote branch — one rev-parse settles it.
        const trimmed = baseBranch?.trim();
        if (trimmed) {
          const onOrigin =
            (await runGit(localPath, ["rev-parse", "--verify", "--quiet", `origin/${trimmed}`]))
              .code === 0;
          if (!onOrigin) {
            return { ok: false as const, error: `branch '${trimmed}' not found on origin` };
          }
        }
        const links = await ensureRepoLinks();
        links.repos[repoKey({ owner, name })] = {
          localPath,
          linkedAt: new Date().toISOString(),
          ...(trimmed ? { baseBranch: trimmed } : {}),
        };
        await saveRepoLinks(deps!.repoLinksFilePath, links);
        await reconcileFromCache();
        return { ok: true as const, localPath };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:inspectLinkTarget",
    async (
      _e,
      owner: string,
      name: string,
      localPath: string,
    ): Promise<ListRepoBranchesResult> => {
      try {
        await detectHostForLocalPath(owner, name, localPath);
        // Best-effort authed fetch so the branch list + default are current; a
        // fetch failure never fails the inspect (offline link still works).
        const account = accountForRepo(owner, name);
        const token = account ? await deps!.getToken(account.key) : null;
        const creds =
          token && account
            ? codeHostFor(codeHostForProvider(account.provider) ?? "github").pushCredentials(token)
            : undefined;
        await fetchOrigin(localPath, creds, 60_000).catch(() => {});
        return await branchesForLocalClone(localPath);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:listRemoteBranches",
    async (
      _e,
      owner: string,
      name: string,
      accountId?: string,
    ): Promise<ListRepoBranchesResult> => {
      try {
        const account = accountForRepo(owner, name, accountId);
        const token = account ? await deps!.getToken(account.key) : null;
        if (!token || !account) {
          return { ok: false, error: "no account token available for this repo" };
        }
        const host = codeHostFor(codeHostForProvider(account.provider) ?? "github");
        const { branches, defaultBranch } = await listRemoteHeads(
          host,
          { owner, name },
          host.pushCredentials(token),
          account.baseUrl,
        );
        return { ok: true, branches, defaultBranch };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
  ipcMain.handle(
    "skipper:orchestrator:setRepoBaseBranch",
    async (_e, owner: string, name: string, baseBranch: string | null) => {
      try {
        const links = await ensureRepoLinks();
        const key = repoKey({ owner, name });
        const link = links.repos[key];
        if (!link) return { ok: false as const, error: "repo not linked" };
        const repo = { owner, name };

        const oldBase = link.baseBranch;
        const trimmed = baseBranch?.trim() ?? "";
        const newBase = trimmed === "" ? undefined : trimmed;

        if (newBase) {
          const onOrigin = async (): Promise<boolean> =>
            (await runGit(link.localPath, ["rev-parse", "--verify", "--quiet", `origin/${newBase}`]))
              .code === 0;
          if (!(await onOrigin())) {
            await fetchOrigin(link.localPath).catch(() => {});
            if (!(await onOrigin())) {
              return { ok: false as const, error: `branch '${newBase}' not found on origin` };
            }
          }
        }

        // Effective-change check: only the resolved ref matters (setting the
        // override to what origin/HEAD already points at is a no-op). A throw on
        // either side is treated as a change so the reaction still runs.
        const resolveEff = (ref?: string): Promise<string | null> =>
          resolveBaseRef(link.localPath, ref).catch(() => null);
        const [oldEff, newEff] = await Promise.all([resolveEff(oldBase), resolveEff(newBase)]);
        const changed = oldEff === null || newEff === null || oldEff !== newEff;

        // Persist first so any planning that starts now already cuts from the new base.
        if (newBase) link.baseBranch = newBase;
        else delete link.baseBranch;
        await saveRepoLinks(deps!.repoLinksFilePath, links);
        if (!changed) return { ok: true as const };

        const m = await ensureManifest();
        // Probe + discard under one repo git lock (nesting requestTransition here
        // would self-deadlock via the planner's prepareWorktreeFor).
        const actions = await withRepoGitLock(repo, async () => {
          const oldBaseRef = await resolveBaseRef(link.localPath, oldBase).catch(() => null);
          const probes = new Map<string, WorktreeProbe>();
          for (const item of Object.values(m.items)) {
            if (repoKey(item.repo) !== key || !item.worktree) continue;
            const dirtyFiles = await worktreeDirtyFiles(item.worktree.path);
            const dirty = dirtyFiles === null ? null : dirtyFiles.length > 0;
            let aheadOfOldBase: number | null = null;
            if (oldBaseRef) {
              const rl = await runGit(link.localPath, [
                "rev-list",
                "--count",
                `${oldBaseRef}..refs/heads/${item.worktree.branch}`,
              ]);
              aheadOfOldBase = rl.code === 0 ? parseInt(rl.stdout.trim(), 10) : null;
            }
            probes.set(item.id, { dirty, aheadOfOldBase });
          }
          const resolved = resolveBaseChangeActions(Object.values(m.items), key, probes);
          for (const d of resolved.discard) {
            await discardWorktree({
              repoPath: link.localPath,
              worktreePath: d.worktree.path,
              branch: d.worktree.branch,
              baseRef: oldBaseRef ?? undefined,
            }).catch((err) =>
              console.warn(`base-change discard failed for ${d.worktree.path}: ${err}`),
            );
          }
          return resolved;
        });

        // Clear the worktree record on discarded items in one manifest pass.
        if (actions.discard.length > 0) {
          for (const d of actions.discard) {
            const item = m.items[d.id];
            if (item) m.items[d.id] = { ...item, worktree: undefined, updatedAt: new Date().toISOString() };
          }
          await saveOrchestratorManifest(deps!.manifestFilePath, m);
          broadcast();
        }

        // Transitions AFTER the lock (requestTransition pokes the planner, which
        // takes the same lock). Each poke re-enqueues the item on the new base.
        const replanned: string[] = [];
        const skipped = [...actions.skipped];
        for (const id of actions.replan) {
          const item = m.items[id];
          if (!item) continue;
          try {
            await requestTransition(id, "planning", "user", "base branch changed");
            replanned.push(id);
          } catch {
            skipped.push({ id, key: item.key, reason: "illegal-transition" });
          }
        }
        return { ok: true as const, replan: { replanned, skipped } };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:listRepoBranches",
    async (_e, owner: string, name: string): Promise<ListRepoBranchesResult> => {
      try {
        const links = await ensureRepoLinks();
        const link = links.repos[repoKey({ owner, name })];
        if (!link) return { ok: false, error: "repo not linked" };
        return await branchesForLocalClone(link.localPath);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle("skipper:orchestrator:listRepos", async () => {
    const links = await ensureRepoLinks();
    const seen = new Map<string, RepoRef>();
    for (const map of items.values()) {
      for (const item of map.values()) {
        if (item.repo) seen.set(repoKey(item.repo), item.repo);
      }
    }
    const linked = Object.entries(links.repos).map(([key, link]) => ({
      key,
      localPath: link.localPath,
      linkedAt: link.linkedAt,
      baseBranch: link.baseBranch,
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
  ipcMain.handle("skipper:orchestrator:getCoderReport", async (_e, itemId: string) => {
    const m = await ensureManifest();
    const ref = m.items[itemId]?.coderReport?.ref;
    if (!ref) return null;
    return readStoredCoderReport(deps!.plansDir, ref);
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
    const stored = await updateStoredPlan(deps!.plansDir, ref, parsed.data, "inline-edit");
    if (!stored) return { ok: false as const, error: "stored plan not found" };
    // An inline edit supersedes the plan an in-flight rescore was scoring (#164):
    // cancel it so the stale score stands rather than landing on the edited plan.
    cancelRescore(itemId);
    return { ok: true as const, stored };
  });
  // Conversational plan review (#145): chat with the planning session at the
  // gate. Guards (state, plan, busy) live in plan-chat.ts.
  ipcMain.handle("skipper:planChat:send", (_e, itemId: string, text: string) =>
    sendPlanChatMessage(itemId, text),
  );
  ipcMain.handle("skipper:planChat:apply", async (_e, itemId: string) => {
    const res = await applyPlanChatUpdate(itemId);
    // Apply re-emitted the plan — re-score it in a detached run (#164). The old
    // confidence report described the plan the discussion just rewrote.
    if (res.ok) startRescore(itemId, res.stored);
    return res;
  });
  ipcMain.handle("skipper:planChat:getHistory", (_e, itemId: string) =>
    getPlanChatHistory(itemId),
  );
  // Replay for renderers that mount mid-run; live events ride the per-item channel.
  ipcMain.handle("skipper:coding:getEvents", (_e, itemId: string) => {
    return codingEvents.get(itemId) ?? [];
  });
  ipcMain.handle("skipper:planning:getEvents", (_e, itemId: string) => {
    return planningEvents.get(itemId) ?? [];
  });
  ipcMain.handle("skipper:review:getEvents", (_e, itemId: string) => {
    return reviewEvents.get(itemId) ?? [];
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
  // Worktree diff viewer (#114). The renderer may read and save any worktree
  // that exists on disk, in any lifecycle state — the user owns the worktree.
  async function usableWorktree(
    itemId: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const m = await ensureManifest();
    const item = m.items[itemId];
    if (!item) return { ok: false, error: `unknown item ${itemId}` };
    const st = await worktreeStatus(item.worktree);
    if (!st.ok) return st;
    if (!st.present) return { ok: false, error: "worktree folder is missing on disk" };
    return { ok: true, path: st.path };
  }

  ipcMain.handle("skipper:orchestrator:getWorktreeChanges", async (_e, itemId: string) => {
    const wt = await usableWorktree(itemId);
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
      const wt = await usableWorktree(itemId);
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
      const wt = await usableWorktree(itemId);
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
  // Manual end-of-flow cleanup (#115): archive a closed item — discard its
  // worktree (conservative branch delete) and archive the plan. The dirty gate
  // needs the caller's confirmation before destroying uncommitted work.
  ipcMain.handle(
    "skipper:orchestrator:archiveItem",
    async (_e, itemId: string, force?: boolean): Promise<ArchiveItemResult> => {
      const m = await ensureManifest();
      await ensureRepoLinks();
      const item = m.items[itemId];
      if (!item) return { ok: false, error: `unknown item ${itemId}` };
      if (item.state !== "closed") {
        return { ok: false, error: "only closed items can be archived" };
      }

      if (item.worktree) {
        const dirty = await worktreeDirtyFiles(item.worktree.path);
        if (dirty && dirty.length > 0 && !force) {
          return { ok: false, needsConfirm: true, dirtyFiles: dirty.length };
        }
        const link = repoLinks?.repos[repoKey(item.repo)];
        if (link) {
          const worktreePath = item.worktree.path;
          const branch = item.worktree.branch;
          try {
            await withRepoGitLock(item.repo, async () => {
              const baseRef = await resolveBaseRef(link.localPath, link.baseBranch).catch(
                () => undefined,
              );
              await discardWorktree({ repoPath: link.localPath, worktreePath, branch, baseRef });
            });
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      let plan = item.plan;
      if (plan?.ref) {
        const archivedRef = await archiveStoredPlan(deps!.plansDir, plan.ref).catch(() => null);
        if (archivedRef) plan = { ...plan, ref: archivedRef };
      }
      void deletePlanChat(deps!.plansDir, itemId).catch(() => {});

      // Re-read after the slow git ops so a concurrent update is not clobbered.
      const current = m.items[itemId] ?? item;
      const archived: TrackedItem = {
        ...current,
        worktree: undefined,
        plan,
        updatedAt: new Date().toISOString(),
      };
      m.items[itemId] = archived;
      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      broadcast();
      return { ok: true, item: archived };
    },
  );
  // Manifest cleanup (#120): untrack an item — drop it from the manifest and the
  // raw cache (so reconcileFromCache can't instantly resurrect it) and prune its
  // worktree. A later real poll/full-walk may re-admit it (no ignore list). The
  // worktree/PR gate needs confirmation before destroying uncommitted work.
  ipcMain.handle(
    "skipper:orchestrator:untrackItem",
    async (_e, itemId: string, force?: boolean): Promise<UntrackItemResult> => {
      const m = await ensureManifest();
      await ensureRepoLinks();
      const item = m.items[itemId];
      if (!item) return { ok: false, error: `unknown item ${itemId}` };

      if ((item.worktree || item.pr) && !force) {
        const dirty = item.worktree ? await worktreeDirtyFiles(item.worktree.path) : null;
        return {
          ok: false,
          needsConfirm: true,
          hasWorktree: !!item.worktree,
          dirtyFiles: dirty?.length ?? 0,
          hasPr: !!item.pr,
        };
      }

      if (item.state === "coding") cancelCodingRun(itemId);
      if (item.state === "planning") cancelPlanningRun(itemId);
      cancelRescore(itemId);

      if (item.worktree) {
        const link = repoLinks?.repos[repoKey(item.repo)];
        if (link) {
          const worktreePath = item.worktree.path;
          const branch = item.worktree.branch;
          try {
            await withRepoGitLock(item.repo, async () => {
              const baseRef = await resolveBaseRef(link.localPath, link.baseBranch).catch(
                () => undefined,
              );
              await discardWorktree({ repoPath: link.localPath, worktreePath, branch, baseRef });
            });
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      if (item.plan?.ref) {
        await archiveStoredPlan(deps!.plansDir, item.plan.ref).catch(() => null);
      }
      void deletePlanChat(deps!.plansDir, itemId).catch(() => {});

      delete m.items[itemId];
      delete m.parked[itemId];
      if (m.resumeRite) {
        m.resumeRite.itemIds = m.resumeRite.itemIds.filter((id) => id !== itemId);
        if (m.resumeRite.itemIds.length === 0) delete m.resumeRite;
      }

      // Drop from the raw cache so reconcileFromCache (mapping change, link/clone,
      // re-follow) doesn't instantly re-admit it.
      items.get(item.accountId)?.delete(itemId);
      patchAccount(item.accountId, deriveArrays(item.accountId));

      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      broadcast();
      return { ok: true };
    },
  );

  initPlanner({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = items.get(item.accountId)?.get(item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    fetchIssueComments: fetchIssueCommentsFor,
    getRepoPath: repoPathFor,
    getRepoSettings: repoOrch,
    requestTransition,
    completePlan,
    prepareWorktree: (item) => prepareWorktreeFor(item),
    setWorktree,
    setPlanSessionId,
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    emitEvent: emitPlanningEvent,
    plansDir: orchestratorDeps.plansDir,
    getMemoryMcp: (item) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo: item.repo }
        : undefined,
  });

  initPlanChat({
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = items.get(item.accountId)?.get(item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    getRepoPath: repoPathFor,
    getRepoSettings: repoOrch,
    getStoredPlan: async (item) => {
      const ref = item.plan?.ref;
      return ref ? readStoredPlan(orchestratorDeps.plansDir, ref) : null;
    },
    updatePlan: (item, plan) =>
      updateStoredPlan(orchestratorDeps.plansDir, item.plan!.ref!, plan, "chat-apply"),
    setPlanSessionId,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    emitEvent: emitPlanningEvent,
    plansDir: orchestratorDeps.plansDir,
    getMemoryMcp: (item) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo: item.repo }
        : undefined,
  });

  initRescore({
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = items.get(item.accountId)?.get(item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    fetchIssueComments: fetchIssueCommentsFor,
    getRepoPath: repoPathFor,
    getRepoSettings: repoOrch,
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    emitEvent: emitPlanningEvent,
    plansDir: orchestratorDeps.plansDir,
    setPlanRescoring,
    completeRescore,
  });

  initCoder({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = items.get(item.accountId)?.get(item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    fetchIssueComments: fetchIssueCommentsFor,
    getPlan: async (item) => {
      const ref = item.plan?.ref;
      return ref ? readStoredPlan(orchestratorDeps.plansDir, ref) : null;
    },
    requestTransition,
    completeCoding,
    setWorktree,
    prepareWorktree: (item) => prepareWorktreeFor(item, { refreshBase: true }),
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getRepoPriority: (repo) => repoOrch(repo).priority,
    getRepoWipLimit: (repo) => repoOrch(repo).wipLimit,
    getRepoSettings: repoOrch,
    emitEvent: emitCodingEvent,
    getMemoryMcp: (item) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo: item.repo }
        : undefined,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    plansDir: orchestratorDeps.plansDir,
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
    setReviewSessionId,
    getCoderReport: (item) =>
      item.coderReport?.ref
        ? readStoredCoderReport(orchestratorDeps.plansDir, item.coderReport.ref)
        : Promise.resolve(null),
    emitEvent: emitReviewEvent,
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getRepoSettings: repoOrch,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
  });

  initShepherd({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getTokenProvider: (item) => (force) => {
      const account = codeHostAccountFor(item.codeHost, item.accountId);
      return account ? deps!.getToken(account.key, force) : Promise.resolve(null);
    },
    getBaseUrl: (item) => codeHostAccountFor(item.codeHost, item.accountId)?.baseUrl,
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
