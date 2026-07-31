import { dirname, join } from "node:path";
import { ipcMain, type BrowserWindow } from "electron";
import {
  issueSourceForAuthProvider,
  issueSourceFor,
  issueSources,
  remapProjectItems,
  applyTransition,
  loadOrCreateOrchestratorManifest,
  saveOrchestratorManifest,
  listUserInstallationRepos,
  listMembershipProjects,
  listJiraProjects,
  listOpenProjectProjects,
  codeHostFor,
  codeHostForProvider,
  resolveGate,
  reconcileMemoryIndex,
  generateRepoInstructions,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  IssuePlanSchema,
  type IssueComment,
  type OrchestratorManifest,
  type OrchestratorSettings,
} from "@skipper/core";
import {
  formatRepoMappingValue,
  issueBranchFor,
  latestCodingTransitionAt,
  latestPlanningTransitionAt,
  mappingHost,
  parseProjectMappingKey,
  parseRepoMappingValue,
  parseRepoPath,
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
  ConfidenceReport,
  FollowCandidate,
  FollowCandidatesResult,
  Issue,
  LifecycleState,
  ListRepoBranchesResult,
  MemoryPhase,
  OrchestratorState,
  PrReviewComment,
  RepoInstructionsDoc,
  GetRepoInstructionsResult,
  SetRepoInstructionsResult,
  RegenerateRepoInstructionsResult,
  GetRepoGraphifyResult,
  ReindexRepoGraphifyResult,
  RepoIntakeSettings,
  RepoRef,
  RepoSettingsRow,
  ResolvedRepoIntakeSettings,
  ResolvedRepoOrchestratorSettings,
  ResumeRiteAction,
  TrackedItem,
  TrackerProjectsResult,
  TransitionActor,
  ArchiveItemResult,
  UntrackItemResult,
  CloseItemOnTrackerResult,
  CleanWorktreeResult,
  IssueSourceCapabilities,
  IssueSourceId,
} from "@skipper/shared";
import { loadCursors, saveCursors } from "./inbox-cursor-store";
import { runGit } from "./git";
import {
  branchesForLocalClone,
  cloneRepo,
  detectHostForLocalPath,
  listRemoteHeads,
  loadRepoLinks,
  saveRepoLinks,
  type RepoLinksFile,
} from "./repo-links";
import { resolveBaseChangeActions, type WorktreeProbe } from "./base-change";
import { makeEventStream } from "./event-stream";
import { discardItemWorktreeUnderLock, archivePlanAndDeleteChats } from "./item-teardown";
import { makeRepoGitLock } from "./git-lock";
import { applySettingsPatch, applyRepoSettingsPatch } from "./settings-validators";
import { makePoller } from "./poll";
import { makeManifestWriters } from "./manifest-writers";
import {
  activeItemsForRepo,
  guardFollowedPatch,
  markRepoFollowed,
} from "./repo-follow";
import { registerRepoFollowHandlers } from "./repo-follow-ipc";
import { registerMemoryHandlers } from "./memory-ipc";
import { registerCreateIssueHandlers } from "./create-issue-ipc";
import { registerComposerHandlers } from "./composer-ipc";
import { registerDraftsHandlers } from "./drafts-ipc";
import { registerEmbedderHost } from "./embedder-host";
import { registerWorktreeDiffHandlers } from "./worktree-diff-ipc";
import { readLlmSettings, readLlmSettingsSync, buildLlm } from "./llm-settings";
import {
  isInstructionsGenerating,
  loadRepoInstructions,
  markStaleGenerations,
  readReadyInstructions,
  saveRepoInstructions,
  seedRepoInstructions,
} from "./repo-instructions";
import {
  isGraphifyRunning,
  loadGraphifyDoc,
  markStaleGraphifyRuns,
} from "./graphify-store";
import { ensureGraphIndexed, graphifyForPlanning, type GraphifyDeps } from "./graphify";
import { readStoredPlan, updateStoredPlan } from "./plan-store";
import { readStoredCoderReport } from "./report-store";
import {
  initPlanChat,
  sendPlanChatMessage,
  applyPlanChatUpdate,
  getPlanChatHistory,
  cancelPlanChat,
} from "./plan-chat";
import {
  initAgentChat,
  sendAgentChatMessage,
  getAgentChatHistory,
  prepareCoderChatApply,
  confirmCoderChatApply,
  cancelAgentChat,
} from "./agent-chat";
import { flushUnfinishedComposerChats, initComposerChat } from "./composer-chat";
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
import { initDistiller, distillForRecord } from "./distiller";
import { initStalenessSweep, sweepStaleness } from "./memory-staleness";
import {
  captureWorktreeDiff,
  discardWorktree,
  ensureWorktree,
  fetchOrigin,
  forceCleanWorktree,
  refreshWorktreeBase,
  resolveBaseRef,
  worktreeDirFor,
  worktreeDirtyFiles,
} from "./worktrees";

export { killAllCodingRuns, killAllPlanningRuns, killAllRescores, flushUnfinishedComposerChats };

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
  /** Per-repo agent-instructions docs (#227), one JSON per linked repo. */
  repoInstructionsDir: string;
  /** Saved composer drafts (#138), one JSON per draft. */
  draftsDir: string;
  /** Composer chat attachments (#281), one dir per chat. */
  composerAttachmentsDir: string;
  /** Per-repo Graphify index state + graphs (#233), one dir per linked repo. */
  graphsDir: string;
  /** uv-managed runtime root for the Graphify install (#233). */
  toolsDir: string;
  /** uv binary — "uv" from PATH in dev, an absolute packaged path in production (#233). */
  uvBin: string;
  /** userData root — settings.json lives here (#59: planner/reviewer provider). */
  dataDir: string;
  /** Absolute path to the CLI bundle for the skipper-memory MCP server (#45),
   * or null when it isn't shipped (dev before a CLI build). */
  cliBundlePath: string | null;
}

const FIRST_POLL_DELAY_MS = 10_000;
const POLL_EVERY_MS = 3 * 60_000;
const POKE_DEBOUNCE_MS = 1500;

let deps: OrchestratorDeps | null = null;
let getWindow: () => BrowserWindow | null = () => null;
let manifest: OrchestratorManifest | null = null;
let repoLinks: RepoLinksFile | null = null;

// Per-source capability flags (#132), derived once from the adapter registry —
// truthful because it reads the actual method presence on each source.
const SOURCE_CAPABILITIES = Object.fromEntries(
  (Object.keys(issueSources) as IssueSourceId[]).map((id) => [
    id,
    {
      closeIssue: typeof issueSourceFor(id).closeIssue === "function",
      createIssue: typeof issueSourceFor(id).createIssue === "function",
    },
  ]),
) as Record<IssueSourceId, IssueSourceCapabilities>;

const poller = makePoller({
  getAccounts: () => issueAccounts(),
  getToken: (key, force) => deps!.getToken(key, force),
  loadCursors: () => loadCursors(deps!.cursorFilePath),
  saveCursors: (c) => saveCursors(deps!.cursorFilePath, c),
  ensureManifest,
  saveManifest: (m) => saveOrchestratorManifest(deps!.manifestFilePath, m),
  ensureRepoLinks,
  broadcast: () => broadcast(),
  pokeDrivers: () => {
    pokePlanner();
    pokeCoder();
    pokeReviewer();
    pokeShepherd();
  },
  sweepStaleness: () => void sweepStaleness(),
});

function snapshot(): OrchestratorState {
  const tracked = Object.values(manifest?.items ?? {});
  return {
    status: poller.status(),
    intakePaused: manifest?.settings.intakePaused ?? false,
    parkedCount: Object.keys(manifest?.parked ?? {}).length,
    queue: {
      coding: tracked.filter((i) => i.state === "coding").length,
      queued: tracked.filter((i) => i.state === "queued").length,
      wipLimitPerRepo: manifest?.settings.codingWipPerRepo ?? 1,
    },
    items: tracked,
    accounts: poller.accountsState(),
    repoSettings: manifest?.repoSettings ?? {},
    projectMappings: manifest?.projectMappings ?? {},
    unmappedProjects: poller
      .unmappedProjects()
      .sort((a, b) => `${a.host}:${a.projectKey}`.localeCompare(`${b.host}:${b.projectKey}`)),
    resumeRite: manifest?.resumeRite ? { itemIds: [...manifest.resumeRite.itemIds] } : null,
    settings: manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    sourceCapabilities: SOURCE_CAPABILITIES,
  };
}

function broadcast(): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("skipper:orchestrator:stateChanged", snapshot());
  }
}

// Saved drafts (#138) live outside the manifest, so they get their own ping:
// the sidebar badge and the /drafts list refetch on it.
function broadcastDraftsChanged(): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("skipper:drafts:changed");
  }
}

// Fine-grained agent progress (#9): replay buffer + per-item channel. Coarse
// state changes ride the broadcast above. getWindow is a module let reassigned
// in initOrchestrator, so the streams take the thunk (a bare reference would
// capture the pre-init value and silently kill every live send).
const codingStream = makeEventStream({
  channel: "coding",
  resetPhase: "fetching",
  getWindow: () => getWindow(),
  // A new run restarts the stream: reset the buffer so replay never mixes runs.
  onReset: (itemId) => void resetMemoryUse(itemId, "coding"),
  onEvent: (itemId, event) => {
    if (isMemoryGet(event)) void recordMemoryUse(itemId, "coding", event.detail);
  },
});

// Planner console stream (#32): own channel pair so a coding run's buffer reset
// never wipes planner history. Every planner run opens with agent-start.
const planningStream = makeEventStream({
  channel: "planning",
  resetPhase: "agent-start",
  getWindow: () => getWindow(),
  onReset: (itemId) => void resetMemoryUse(itemId, "planning"),
  onEvent: (itemId, event) => {
    if (isMemoryGet(event)) void recordMemoryUse(itemId, "planning", event.detail);
  },
});

// Reviewer console stream (#113): own channel pair, reset on the fetching status
// that opens every round. The reviewer runs no tools, so no memory bookkeeping.
const reviewStream = makeEventStream({
  channel: "review",
  resetPhase: "fetching",
  getWindow: () => getWindow(),
});

// Chat composer stream (#136): own channel pair, keyed `${repoKey}:${chatId}`
// (the envelope calls that field itemId — the composer has no item). Only
// startComposerChat emits `fetching`, so a new chat is the buffer's only reset.
const composerStream = makeEventStream({
  channel: "composer",
  resetPhase: "fetching",
  getWindow: () => getWindow(),
});

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

/**
 * Seed (or regenerate, force=true) a repo's agent-instructions doc (#227). Only
 * the synchronous part is awaited (seed-file copy or the "generating"
 * placeholder); agentic generation runs in the background and pokes the planner
 * when it settles so a gated auto-plan resumes. Never throws.
 */
async function seedInstructions(repo: RepoRef, localPath: string, force = false): Promise<void> {
  if (!deps) return;
  await seedRepoInstructions({
    dir: deps.repoInstructionsDir,
    repoKey: repoKey(repo),
    repoPath: localPath,
    generate: async () => {
      const settings = await readLlmSettings(deps!.dataDir);
      const orch = repoOrch(repo);
      const { runtime } = buildLlm(settings, orch.plannerModel, 16, orch.plannerRuntime);
      // The old generateRepoInstructions threw on a runtime-less provider (#238) —
      // that guard moved here so the seam takes an already-checked runtime.
      if (!runtime) {
        throw new Error(
          "generating repository conventions needs an agent runtime (claude-cli) — the selected provider has none",
        );
      }
      return generateRepoInstructions({ repoPath: localPath, runtime, hardTimeoutMs: 10 * 60_000 });
    },
    onSettled: () => {
      broadcast();
      pokePlanner();
    },
    force,
  });
}

/** Graphify driver deps for a repo (#233), or undefined when it isn't linked
 *  (extract needs a local checkout). */
function graphifyDepsFor(repo: RepoRef): GraphifyDeps | undefined {
  if (!deps) return undefined;
  const link = repoLinks?.repos[repoKey(repo)];
  if (!link?.localPath) return undefined;
  return {
    graphsDir: deps.graphsDir,
    runtime: { uvBin: deps.uvBin, toolsDir: deps.toolsDir },
    repo,
    repoPath: link.localPath,
    ...(link.baseBranch ? { baseBranch: link.baseBranch } : {}),
    withRepoGitLock,
    onStatus: broadcast,
  };
}

/** Fire-and-forget a Graphify index run for a repo, if it is linked (#233). */
function kickGraphify(repo: RepoRef): void {
  const d = graphifyDepsFor(repo);
  if (d) void ensureGraphIndexed(d);
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
  const cached = poller.getCached(item.accountId, item.id);
  if (!account || !source?.fetchComments || cached?.kind !== "issue") return Promise.resolve([]);
  return source.fetchComments(
    cached,
    (force) => deps!.getToken(account.key, force),
    account.baseUrl,
    account.cloudId,
    account.authMethod,
  );
}

/** Minimal Issue rebuilt from a TrackedItem for a close call when the raw poll
 *  cache lacks it (#132) — carries every field closeGitHubIssue/closeGitLabIssue
 *  read; required-unused fields get inert defaults. */
function synthesizeIssue(item: TrackedItem): Issue {
  return {
    kind: "issue",
    id: item.id,
    source: item.source,
    sourceRef: item.sourceRef,
    codeHost: item.codeHost,
    accountId: item.accountId,
    repo: item.repo,
    key: item.key,
    number: item.number,
    title: item.title,
    body: item.body,
    labels: [],
    assignees: [],
    url: item.url,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    state: "open",
  };
}

/** Account for cloning: explicit account key, else the code-host account behind the
 *  item that sees the repo, else the first issue account. Carries provider + baseUrl. */
function accountForRepo(owner: string, name: string, accountKey?: string): Account | undefined {
  if (!deps) return undefined;
  if (accountKey) {
    return deps.getAccounts().find((a) => a.key === accountKey);
  }
  const key = repoKey({ owner, name });
  for (const [acctKey, map] of poller.cachedByAccount()) {
    for (const item of map.values()) {
      if (item.repo && repoKey(item.repo) === key) {
        return codeHostAccountFor(item.codeHost, acctKey);
      }
    }
  }
  return issueAccounts()[0];
}

// Serialize per-repo git ops on a shared clone (fetch + worktree add are not
// concurrency-safe). One module instance; the factory keeps tests isolated.
const withRepoGitLock = makeRepoGitLock();

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

const writers = makeManifestWriters({
  ensureManifest,
  saveManifest: (m) => saveOrchestratorManifest(deps!.manifestFilePath, m),
  broadcast,
  pokePlanner,
  pokeCoder,
  pokeReviewer,
  pokeShepherd,
  getRepoAutoCoding: (repo) => repoOrch(repo).autoCoding,
  archivePlan: (itemId, plan) => archivePlanAndDeleteChats(deps!.plansDir, itemId, plan),
  cancelPlanningRun,
  cancelCodingRun,
  cancelPlanChat,
  cancelRescore,
  cancelAgentChat,
  discardParkedWorktree: (item, worktree) => {
    const link = repoLinks?.repos[repoKey(item.repo)];
    if (!link) return;
    const worktreePath = worktree.path;
    const branch = worktree.branch;
    // Serialize with prepareWorktreeFor: a park's prune/branch-delete must not
    // race a concurrent fetch/worktree-add for another item on the same clone.
    void withRepoGitLock(item.repo, async () => {
      const baseRef = await resolveBaseRef(link.localPath, link.baseBranch).catch(() => undefined);
      await discardWorktree({ repoPath: link.localPath, worktreePath, branch, baseRef });
    }).catch((err) => console.warn(`park cleanup failed for ${worktreePath}: ${err}`));
  },
});
const {
  completePlan,
  completeCoding,
  completeReview,
  completePrOpen,
  completeReentry,
  completeMergedCleanup,
  setWorktree,
  setPlanSessionId,
  setPlanRescoring,
  completeRescore,
  setReviewSessionId,
} = writers;
export const requestTransition = writers.requestTransition;

export async function setIntakePaused(paused: boolean): Promise<void> {
  if (!deps) throw new Error("orchestrator not initialized");
  const m = await ensureManifest();
  m.settings.intakePaused = paused;
  await saveOrchestratorManifest(deps.manifestFilePath, m);
  broadcast();
  if (!paused) {
    // Resume (#15): drain cached parked issues now (they admit held from
    // auto-plan and surface the rite prompt); a poll picks up the rest.
    await poller.reconcileFromCache();
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
    void poller.pollNow().catch(() => {
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

  // Must happen here, not in main.ts: @skipper/core is bundled into
  // orchestrator.cjs, so a registration from outside this bundle would land on
  // a different module copy and leave the embedder unregistered (#255).
  registerEmbedderHost({
    cliBundlePath: orchestratorDeps.cliBundlePath,
    hfCacheDir: join(dirname(orchestratorDeps.memoryDir), "hf-cache"),
  });
  // Strictly after the embedder registration (#256): records captured or deleted
  // while the app was closed leave the vector index out of line with the files.
  void reconcileMemoryIndex(orchestratorDeps.memoryDir).catch((err) =>
    console.warn(`[memory] startup reconcile failed: ${String(err)}`),
  );

  // Crash safety (#227): the in-flight generation set never survives a restart,
  // so any doc left "generating" by a crash would gate planning forever. Flip
  // them to "failed" before anything reads a doc.
  void markStaleGenerations(orchestratorDeps.repoInstructionsDir);
  // Same crash safety for Graphify (#233): a doc left installing/indexing gates a repo.
  void markStaleGraphifyRuns(orchestratorDeps.graphsDir);

  ipcMain.handle("skipper:orchestrator:getState", async () => {
    await ensureManifest();
    return snapshot();
  });
  // full = force a real refetch (#120): clear the delta cursors and full-walk
  // timers so the next poll walks everything. Persisting the cleared cursor file
  // makes the reset crash-safe. If a poll is already running pollNow no-ops; the
  // next one runs full anyway since lastFullWalkAt is cleared.
  ipcMain.handle("skipper:orchestrator:refresh", async (_e, full?: boolean) => {
    if (full) await poller.resetForFullWalk();
    await poller.pollNow(true);
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
      applySettingsPatch(m.settings, patch);
      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      broadcast();
      pokePlanner(); // autoPlanPaused — without this the topbar toggle reads as dead
      pokeCoder(); // codingWipPerRepo, autoCoding
      pokeReviewer(); // review, reviewMaxRounds
      // The model and runtime keys need no poke: each run reads both at start
      // (#58, #240).
      return snapshot();
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:setRepoSettings",
    async (_e, owner: string, name: string, patch: Partial<RepoIntakeSettings>) => {
      const m = await ensureManifest();
      const key = repoKey({ owner, name });
      const followedBefore = resolveRepoIntakeSettings(m.repoSettings[key]).followed;
      const graphifyBefore = resolveRepoIntakeSettings(m.repoSettings[key]).graphify;
      // Generic patch endpoint — it must not become a way around the unfollow
      // guard; the user-facing refusal belongs to setRepoFollowed.
      const merged = guardFollowedPatch(m, key, applyRepoSettingsPatch(m.repoSettings[key], patch));
      if (Object.keys(merged).length === 0) delete m.repoSettings[key];
      else m.repoSettings[key] = merged;
      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      // Turned on: kick a first index so the graph is ready before the next plan (#233).
      if (!graphifyBefore && resolveRepoIntakeSettings(m.repoSettings[key]).graphify) {
        kickGraphify({ owner, name });
      }
      if (!followedBefore && resolveRepoIntakeSettings(m.repoSettings[key]).followed) {
        // Re-followed: cached issues admit retroactively, like a fresh repo link.
        await poller.reconcileFromCache();
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
    for (const item of poller.allCached()) {
      if (item.repo) put(repoKey(item.repo), item.repo);
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
          activeItems: activeItemsForRepo(m, key).length,
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
        const polled = poller.cachedFor(account.key);
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
      await poller.reconcileFromCache();
      return snapshot();
    },
  );
  // Live project listing for the mapping editor (#79). Use getAccounts directly —
  // needs-project-mapping trackers (Jira, OpenProject) carry no inherent repo, so
  // this handler is the path to an account's projects for the mapping UI.
  ipcMain.handle(
    "skipper:orchestrator:listTrackerProjects",
    async (_e, accountId: string): Promise<TrackerProjectsResult> => {
      const account = deps?.getAccounts().find((a) => a.key === accountId);
      if (!account) return { ok: false, error: "unknown account" };
      try {
        if (account.provider === "jira") {
          const projects = await listJiraProjects((force) => deps!.getToken(account.key, force), {
            cloudId: account.cloudId,
            baseUrl: account.baseUrl,
          });
          return { ok: true, source: "jira", host: mappingHost(account.baseUrl), projects };
        }
        if (account.provider === "openproject") {
          if (!account.baseUrl) return { ok: false, error: "account has no instance URL" };
          const projects = await listOpenProjectProjects(
            (force) => deps!.getToken(account.key, force),
            account.baseUrl,
            account.authMethod,
          );
          return { ok: true, source: "openproject", host: mappingHost(account.baseUrl), projects };
        }
        return { ok: false, error: "account does not support project mapping" };
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
        await detectHostForLocalPath(deps!.getAccounts(), owner, name, localPath);
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
        // Linking is a stronger act of intent than ticking the follow box (#15) —
        // persist it before the reconcile so the cached issues admit in that pass.
        const m = await ensureManifest();
        markRepoFollowed(m, { owner, name });
        await saveOrchestratorManifest(deps!.manifestFilePath, m);
        // Seed before reconcile so an admitted triage item hits the gate while a
        // generation is in flight (#227); seeding failure never fails the link.
        await seedInstructions({ owner, name }, localPath).catch(() => {});
        await poller.reconcileFromCache();
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
        // Linking is a stronger act of intent than ticking the follow box (#15) —
        // persist it before the reconcile so the cached issues admit in that pass.
        const m = await ensureManifest();
        markRepoFollowed(m, { owner, name });
        await saveOrchestratorManifest(deps!.manifestFilePath, m);
        // Seed before reconcile so an admitted triage item hits the gate while a
        // generation is in flight (#227); seeding failure never fails the clone.
        await seedInstructions({ owner, name }, localPath).catch(() => {});
        await poller.reconcileFromCache();
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
        await detectHostForLocalPath(deps!.getAccounts(), owner, name, localPath);
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
      // Keep the instructions doc (#227): user edits survive unlink→relink, and a
      // ready doc makes relink skip reseeding.
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
    "skipper:orchestrator:getRepoInstructions",
    async (_e, owner: string, name: string): Promise<GetRepoInstructionsResult> => {
      try {
        const doc = await loadRepoInstructions(deps!.repoInstructionsDir, repoKey({ owner, name }));
        return { ok: true, doc };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:setRepoInstructions",
    async (_e, owner: string, name: string, content: string): Promise<SetRepoInstructionsResult> => {
      try {
        if (typeof content !== "string") return { ok: false, error: "content must be a string" };
        const doc: RepoInstructionsDoc = {
          version: 1,
          content: content.slice(0, 100_000),
          updatedAt: new Date().toISOString(),
          source: "edited",
          status: "ready",
        };
        await saveRepoInstructions(deps!.repoInstructionsDir, repoKey({ owner, name }), doc);
        broadcast();
        pokePlanner();
        return { ok: true, doc };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:regenerateRepoInstructions",
    async (_e, owner: string, name: string): Promise<RegenerateRepoInstructionsResult> => {
      try {
        const links = await ensureRepoLinks();
        const link = links.repos[repoKey({ owner, name })];
        if (!link) return { ok: false, error: "repo not linked" };
        if (isInstructionsGenerating(repoKey({ owner, name }))) {
          return { ok: false, error: "generation already running" };
        }
        void seedInstructions({ owner, name }, link.localPath, true);
        broadcast();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:getRepoGraphify",
    async (_e, owner: string, name: string): Promise<GetRepoGraphifyResult> => {
      try {
        const doc = await loadGraphifyDoc(deps!.graphsDir, repoKey({ owner, name }));
        return { ok: true, doc };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:reindexRepoGraphify",
    async (_e, owner: string, name: string): Promise<ReindexRepoGraphifyResult> => {
      try {
        const key = repoKey({ owner, name });
        const links = await ensureRepoLinks();
        if (!links.repos[key]?.localPath) return { ok: false, error: "repo not linked" };
        const m = await ensureManifest();
        if (!resolveRepoIntakeSettings(m.repoSettings[key]).graphify) {
          return { ok: false, error: "Graphify is off for this repo" };
        }
        if (isGraphifyRunning(key)) return { ok: false, error: "indexing already running" };
        kickGraphify({ owner, name });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    const m = await ensureManifest();
    const seen = new Map<string, RepoRef>();
    for (const item of poller.allCached()) {
      if (item.repo) seen.set(repoKey(item.repo), item.repo);
    }
    // A followed repo the poller never saw (manual owner/name add, tracker-first
    // setups) still needs a row here — this is the only place linking happens.
    for (const [key, settings] of Object.entries(m.repoSettings)) {
      if (seen.has(key) || !resolveRepoIntakeSettings(settings).followed) continue;
      const repo = parseRepoPath(key);
      if (repo) seen.set(key, repo);
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
  ipcMain.handle("skipper:planChat:cancel", (_e, itemId: string) => {
    cancelPlanChat(itemId);
  });
  // Per-tab agent chat (#170): interrogate the coder / reviewer at their tabs.
  // Guards (availability, binding, busy) live in agent-chat.ts.
  ipcMain.handle(
    "skipper:agentChat:send",
    (_e, kind: unknown, itemId: string, text: string, ctx?: { selectedFile?: string }) => {
      if (kind !== "coder" && kind !== "reviewer") {
        return { ok: false as const, error: `invalid chat kind ${String(kind)}` };
      }
      return sendAgentChatMessage(kind, itemId, text, ctx);
    },
  );
  ipcMain.handle("skipper:agentChat:getHistory", (_e, kind: unknown, itemId: string) => {
    if (kind !== "coder" && kind !== "reviewer") return [];
    return getAgentChatHistory(kind, itemId);
  });
  ipcMain.handle("skipper:agentChat:cancel", (_e, kind: unknown, itemId: string) => {
    if (kind !== "coder" && kind !== "reviewer") return;
    cancelAgentChat(kind, itemId);
  });
  // Coder-chat Apply (#188): distill → preview, then confirm → coding re-entry.
  ipcMain.handle("skipper:agentChat:prepareApply", (_e, itemId: string) =>
    prepareCoderChatApply(itemId),
  );
  ipcMain.handle(
    "skipper:agentChat:confirmApply",
    (_e, itemId: string, instructions: PrReviewComment[]) =>
      confirmCoderChatApply(itemId, instructions),
  );
  // Replay for renderers that mount mid-run; live events ride the per-item channel.
  ipcMain.handle("skipper:coding:getEvents", (_e, itemId: string) => {
    return codingStream.getEvents(itemId);
  });
  ipcMain.handle("skipper:planning:getEvents", (_e, itemId: string) => {
    return planningStream.getEvents(itemId);
  });
  ipcMain.handle("skipper:review:getEvents", (_e, itemId: string) => {
    return reviewStream.getEvents(itemId);
  });
  ipcMain.handle("skipper:composer:getEvents", (_e, key: string) => {
    return composerStream.getEvents(key);
  });
  registerComposerHandlers({
    ipcMain,
    getAccounts: () => deps?.getAccounts() ?? [],
    getToken: (key, force) => deps!.getToken(key, force),
  });
  registerDraftsHandlers({
    ipcMain,
    draftsDir: orchestratorDeps.draftsDir,
    attachmentsDir: orchestratorDeps.composerAttachmentsDir,
    notifyChanged: broadcastDraftsChanged,
  });
  registerMemoryHandlers({
    ipcMain,
    memoryDir: orchestratorDeps.memoryDir,
    manifestFilePath: orchestratorDeps.manifestFilePath,
    ensureManifest,
    broadcast,
    localPathFor: async (repo) => {
      await ensureRepoLinks();
      return repoPathFor(repo);
    },
    runGit: (cwd, args) => runGit(cwd, args),
    distillLesson: distillForRecord,
  });
  registerRepoFollowHandlers({
    ipcMain,
    ensureManifest,
    saveManifest: (m) => saveOrchestratorManifest(deps!.manifestFilePath, m),
    cachedItems: () => poller.allCached(),
    reconcileFromCache: () => poller.reconcileFromCache(),
    broadcast,
    snapshot,
  });
  registerWorktreeDiffHandlers({ ipcMain, ensureManifest });
  registerCreateIssueHandlers({
    ipcMain,
    getAccounts: () => deps?.getAccounts() ?? [],
    getToken: (key, force) => deps!.getToken(key, force),
    sourceForProvider: issueSourceForAuthProvider,
    getProjectMappings: async () => (await ensureManifest()).projectMappings,
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
          const res = await discardItemWorktreeUnderLock({
            repo: item.repo,
            localPath: link.localPath,
            baseBranch: link.baseBranch,
            worktreePath: item.worktree.path,
            branch: item.worktree.branch,
            withRepoGitLock,
          });
          if (!res.ok) return res;
        }
      }

      const plan = await archivePlanAndDeleteChats(deps!.plansDir, itemId, item.plan);

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
          const res = await discardItemWorktreeUnderLock({
            repo: item.repo,
            localPath: link.localPath,
            baseBranch: link.baseBranch,
            worktreePath: item.worktree.path,
            branch: item.worktree.branch,
            withRepoGitLock,
          });
          if (!res.ok) return res;
        }
      }

      await archivePlanAndDeleteChats(deps!.plansDir, itemId, item.plan);

      delete m.items[itemId];
      delete m.parked[itemId];
      if (m.resumeRite) {
        m.resumeRite.itemIds = m.resumeRite.itemIds.filter((id) => id !== itemId);
        if (m.resumeRite.itemIds.length === 0) delete m.resumeRite;
      }

      // Drop from the raw cache so reconcileFromCache (mapping change, link/clone,
      // re-follow) doesn't instantly re-admit it.
      poller.dropCached(item.accountId, itemId);

      await saveOrchestratorManifest(deps!.manifestFilePath, m);
      broadcast();
      return { ok: true };
    },
  );
  // Dirty-worktree cleanup (#204): reset the item's worktree to its base ref and
  // clean untracked files — discards leftover uncommitted work AND local commits;
  // worktree + branch survive. Never automatic: the renderer confirms with the
  // file list first. Refuses while an agent run holds the worktree.
  ipcMain.handle(
    "skipper:orchestrator:cleanWorktree",
    async (_e, itemId: string): Promise<CleanWorktreeResult> => {
      const m = await ensureManifest();
      await ensureRepoLinks();
      const item = m.items[itemId];
      if (!item) return { ok: false, error: `unknown item ${itemId}` };
      if (!item.worktree) return { ok: false, error: "no worktree recorded for item" };
      if (item.state === "coding" || item.state === "planning") {
        return { ok: false, error: "a run is active in this worktree" };
      }
      const link = repoLinks?.repos[repoKey(item.repo)];
      if (!link) {
        return { ok: false, error: `repo ${item.repo.owner}/${item.repo.name} is not linked` };
      }
      const worktree = item.worktree;
      try {
        return await withRepoGitLock(item.repo, async () => {
          const dirty = await worktreeDirtyFiles(worktree.path);
          if (dirty === null) return { ok: false, error: "worktree folder is missing on disk" };
          const account = codeHostAccountFor(item.codeHost, item.accountId);
          const token = account ? await deps!.getToken(account.key) : null;
          const creds = token ? codeHostFor(item.codeHost).pushCredentials(token) : undefined;
          await fetchOrigin(link.localPath, creds).catch(() => {});
          const baseRef = await resolveBaseRef(link.localPath, link.baseBranch);
          await forceCleanWorktree(worktree.path, baseRef);
          return { ok: true };
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  // Close-on-tracker (#132): close the issue on its tracker via the source's
  // closeIssue capability, then settle the item locally through reconcile's
  // existing "closed on GitHub" path (zero extra network). Adapter errors (e.g. a
  // 403 when the GitHub App lacks Issues: write) surface via the {ok:false} path.
  ipcMain.handle(
    "skipper:orchestrator:closeItemOnTracker",
    async (_e, itemId: string): Promise<CloseItemOnTrackerResult> => {
      const m = await ensureManifest();
      const item = m.items[itemId];
      if (!item) return { ok: false, error: `unknown item ${itemId}` };

      const account = deps?.getAccounts().find((a) => a.key === item.accountId);
      const source = account ? issueSourceForAuthProvider(account.provider) : undefined;
      if (!account || !source?.closeIssue) {
        return { ok: false, error: `closing on the tracker is not supported for ${item.source}` };
      }

      const cached = poller.getCached(item.accountId, item.id);
      const issue = cached?.kind === "issue" ? cached : synthesizeIssue(item);
      try {
        await source.closeIssue(
          issue,
          (force) => deps!.getToken(account.key, force),
          account.baseUrl,
        );
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (cached?.kind === "issue") poller.markCachedIssueClosed(item.accountId, item.id);
      await poller.reconcileFromCache();
      return { ok: true };
    },
  );

  initPlanner({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = poller.getCached(item.accountId, item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    fetchIssueComments: fetchIssueCommentsFor,
    getRepoPath: repoPathFor,
    checkoutDirtyPaths: worktreeDirtyFiles,
    getRepoSettings: repoOrch,
    instructionsPending: (repo) => isInstructionsGenerating(repoKey(repo)),
    getRepoInstructions: (repo) =>
      readReadyInstructions(orchestratorDeps.repoInstructionsDir, repoKey(repo)),
    requestTransition,
    completePlan,
    prepareWorktree: (item) => prepareWorktreeFor(item),
    setWorktree,
    setPlanSessionId,
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    emitEvent: planningStream.emit,
    plansDir: orchestratorDeps.plansDir,
    getMemoryMcp: (item) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo: item.repo }
        : undefined,
    getGraphify: (item) => {
      if (!repoOrch(item.repo).graphify) return undefined;
      const d = graphifyDepsFor(item.repo);
      return d ? graphifyForPlanning(d) : undefined;
    },
  });

  initPlanChat({
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = poller.getCached(item.accountId, item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    getRepoPath: repoPathFor,
    checkoutDirtyPaths: worktreeDirtyFiles,
    getRepoSettings: repoOrch,
    getStoredPlan: async (item) => {
      const ref = item.plan?.ref;
      return ref ? readStoredPlan(orchestratorDeps.plansDir, ref) : null;
    },
    updatePlan: (item, plan) =>
      updateStoredPlan(orchestratorDeps.plansDir, item.plan!.ref!, plan, "chat-apply"),
    setPlanSessionId,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    emitEvent: planningStream.emit,
    plansDir: orchestratorDeps.plansDir,
    getMemoryMcp: (item) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo: item.repo }
        : undefined,
  });

  initAgentChat({
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = poller.getCached(item.accountId, item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    getRepoPath: repoPathFor,
    checkoutDirtyPaths: worktreeDirtyFiles,
    getRepoSettings: repoOrch,
    getStoredPlan: async (item) => {
      const ref = item.plan?.ref;
      return ref ? readStoredPlan(orchestratorDeps.plansDir, ref) : null;
    },
    getCoderReport: (item) =>
      item.coderReport?.ref
        ? readStoredCoderReport(orchestratorDeps.plansDir, item.coderReport.ref)
        : Promise.resolve(null),
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    emitEvent: (kind, itemId, e) =>
      (kind === "coder" ? codingStream.emit : reviewStream.emit)(itemId, e),
    plansDir: orchestratorDeps.plansDir,
    getMemoryMcp: (item) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo: item.repo }
        : undefined,
    completeReentry,
  });

  initComposerChat({
    getRepoPath: repoPathFor,
    getRepoSettings: repoOrch,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    checkoutDirtyPaths: worktreeDirtyFiles,
    emitEvent: composerStream.emit,
    getMemoryMcp: (repo) =>
      orchestratorDeps.cliBundlePath
        ? { cliBundlePath: orchestratorDeps.cliBundlePath, repo }
        : undefined,
    getRepoInstructions: (repo) =>
      readReadyInstructions(orchestratorDeps.repoInstructionsDir, repoKey(repo)),
    getGraphify: (repo) => {
      if (!repoOrch(repo).graphify) return undefined;
      const d = graphifyDepsFor(repo);
      return d ? graphifyForPlanning(d) : undefined;
    },
    draftsDir: orchestratorDeps.draftsDir,
    attachmentsDir: orchestratorDeps.composerAttachmentsDir,
    onDraftsChanged: broadcastDraftsChanged,
  });

  initRescore({
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = poller.getCached(item.accountId, item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    fetchIssueComments: fetchIssueCommentsFor,
    getRepoPath: repoPathFor,
    checkoutDirtyPaths: worktreeDirtyFiles,
    getRepoSettings: repoOrch,
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
    emitEvent: planningStream.emit,
    plansDir: orchestratorDeps.plansDir,
    setPlanRescoring,
    completeRescore,
  });

  initCoder({
    listItems: () => Object.values(manifest?.items ?? {}),
    getItem: (itemId) => manifest?.items[itemId],
    getIssue: (item) => {
      const cached = poller.getCached(item.accountId, item.id);
      return cached?.kind === "issue" ? cached : undefined;
    },
    fetchIssueComments: fetchIssueCommentsFor,
    getRepoPath: repoPathFor,
    checkoutDirtyPaths: worktreeDirtyFiles,
    getPlan: async (item) => {
      const ref = item.plan?.ref;
      return ref ? readStoredPlan(orchestratorDeps.plansDir, ref) : null;
    },
    getRepoInstructions: (repo) =>
      readReadyInstructions(orchestratorDeps.repoInstructionsDir, repoKey(repo)),
    requestTransition,
    completeCoding,
    setWorktree,
    prepareWorktree: (item) => prepareWorktreeFor(item, { refreshBase: true }),
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getRepoPriority: (repo) => repoOrch(repo).priority,
    getRepoWipLimit: (repo) => repoOrch(repo).wipLimit,
    getRepoSettings: repoOrch,
    emitEvent: codingStream.emit,
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
      const cached = poller.getCached(item.accountId, item.id);
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
    emitEvent: reviewStream.emit,
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
    distillLesson: distillForRecord,
  });

  initDistiller({
    getSettings: () => manifest?.settings ?? DEFAULT_ORCHESTRATOR_SETTINGS,
    getLlmSettings: () => readLlmSettings(orchestratorDeps.dataDir),
  });

  initStalenessSweep({
    memoryDir: orchestratorDeps.memoryDir,
    getRepoLinks: async () => (await ensureRepoLinks()).repos,
    runGit: (cwd, args) => runGit(cwd, args),
    withRepoGitLock,
    resolveBaseRef,
    broadcast,
  });

  setTimeout(
    () =>
      void poller.pollNow().catch(() => {
        /* keep loop alive */
      }),
    FIRST_POLL_DELAY_MS,
  );
  setInterval(
    () =>
      void poller.pollNow().catch(() => {
        /* keep loop alive */
      }),
    POLL_EVERY_MS,
  );
}
