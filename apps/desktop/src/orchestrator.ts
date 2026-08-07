import { dirname, join } from "node:path";
import { ipcMain, type BrowserWindow } from "electron";
import {
  issueSourceForAuthProvider,
  issueSourceFor,
  issueSources,
  loadOrCreateOrchestratorManifest,
  saveOrchestratorManifest,
  codeHostFor,
  reconcileMemoryIndex,
  generateRepoInstructions,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  type IssueComment,
  type OrchestratorManifest,
  type OrchestratorSettings,
} from "@skipper/core";
import {
  issueBranchFor,
  repoKey,
  resolveRepoOrchestratorSettings,
} from "@skipper/shared";
import type {
  Account,
  AuthProviderId,
  CodeHostId,
  CodingEvent,
  MemoryPhase,
  OrchestratorState,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  TrackedItem,
  IssueSourceCapabilities,
  IssueSourceId,
} from "@skipper/shared";
import { loadCursors, saveCursors } from "./inbox-cursor-store";
import { runGit } from "./git";
import { loadRepoLinks, saveRepoLinks, type RepoLinksFile } from "./repo-links";
import { makeEventStream } from "./event-stream";
import { archivePlanAndDeleteChats } from "./item-teardown";
import { makeRepoGitLock } from "./git-lock";
import { applySettingsPatch } from "./settings-validators";
import { makePoller } from "./poll";
import { makeManifestWriters } from "./manifest-writers";
import { registerRepoFollowHandlers } from "./repo-follow-ipc";
import { registerReposHandlers } from "./repos-ipc";
import { registerRepoConfigHandlers } from "./repo-config-ipc";
import { registerChatHandlers } from "./chat-ipc";
import { registerItemHandlers } from "./item-ipc";
import { registerIntakeHandlers } from "./intake-ipc";
import { registerMemoryHandlers } from "./memory-ipc";
import { registerCreateIssueHandlers } from "./create-issue-ipc";
import { registerComposerHandlers } from "./composer-ipc";
import { registerDraftsHandlers } from "./drafts-ipc";
import { registerEmbedderHost } from "./embedder-host";
import { registerWorktreeDiffHandlers } from "./worktree-diff-ipc";
import { readLlmSettings, readLlmSettingsSync, buildLlm } from "./llm-settings";
import {
  isInstructionsGenerating,
  markStaleGenerations,
  readReadyInstructions,
  seedRepoInstructions,
} from "./repo-instructions";
import { markStaleGraphifyRuns } from "./graphify-store";
import { ensureGraphIndexed, graphifyForPlanning, type GraphifyDeps } from "./graphify";
import { readStoredPlan, updateStoredPlan } from "./plan-store";
import { readStoredCoderReport } from "./report-store";
import { initPlanChat, cancelPlanChat } from "./plan-chat";
import { initAgentChat, cancelAgentChat } from "./agent-chat";
import { flushUnfinishedComposerChats, initComposerChat } from "./composer-chat";
import { initRescore, cancelRescore, killAllRescores } from "./rescore";
import { initPlanner, pokePlanner, cancelPlanningRun, killAllPlanningRuns } from "./planner";
import { initCoder, pokeCoder, cancelCodingRun, killAllCodingRuns } from "./coder";
import { initReviewer, pokeReviewer } from "./reviewer";
import { initShepherd, pokeShepherd } from "./shepherd";
import { initDistiller, distillForRecord } from "./distiller";
import { initStalenessSweep, sweepStaleness } from "./memory-staleness";
import { initBaseAdvance, reactToMerges } from "./base-advance";
import {
  captureWorktreeDiff,
  discardWorktree,
  ensureWorktree,
  fetchOrigin,
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
  codeHostAccountFor,
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
  cancelPlanningRun,
  sweepStaleness: () => void sweepStaleness(),
  reactToMerges: (ids) => void reactToMerges(ids),
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
 * fetch origin, resolve the base ref, ensure the branch's worktree. The callers
 * pass `refreshBase` so a reused, possibly-stale worktree resets to the fresh
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
  setBaseAdvance,
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
  registerChatHandlers({
    ipcMain,
    codingStream,
    planningStream,
    reviewStream,
    composerStream,
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
  registerReposHandlers({
    ipcMain,
    ensureManifest,
    saveManifest: (m) => saveOrchestratorManifest(deps!.manifestFilePath, m),
    ensureRepoLinks,
    saveLinks: (links) => saveRepoLinks(deps!.repoLinksFilePath, links),
    getAccounts: () => deps?.getAccounts() ?? [],
    getToken: (key, force) => deps!.getToken(key, force),
    snapshot,
    broadcast,
    reconcileFromCache: () => poller.reconcileFromCache(),
    pokePlanner,
    pokeCoder,
    withRepoGitLock,
    requestTransition,
    seedInstructions,
    kickGraphify,
    accountForRepo,
    cachedRepos: function* () {
      for (const item of poller.allCached()) if (item.repo) yield item.repo;
    },
    getDefaultModel: () => readLlmSettingsSync(deps!.dataDir).claudeModel,
  });
  registerRepoConfigHandlers({
    ipcMain,
    repoInstructionsDir: orchestratorDeps.repoInstructionsDir,
    graphsDir: orchestratorDeps.graphsDir,
    ensureManifest,
    ensureRepoLinks,
    broadcast,
    pokePlanner,
    seedInstructions,
    kickGraphify,
  });
  registerItemHandlers({
    ipcMain,
    plansDir: orchestratorDeps.plansDir,
    ensureManifest,
    saveManifest: (m) => saveOrchestratorManifest(deps!.manifestFilePath, m),
    ensureRepoLinks,
    snapshot,
    broadcast,
    requestTransition,
    pokePlanner,
    pokeCoder,
    reconcileFromCache: () => poller.reconcileFromCache(),
    withRepoGitLock,
    getAccounts: () => deps?.getAccounts() ?? [],
    getToken: (key, force) => deps!.getToken(key, force),
    codeHostAccountFor,
    getCached: (accountId, itemId) => poller.getCached(accountId, itemId),
    dropCached: (accountId, itemId) => poller.dropCached(accountId, itemId),
    markCachedIssueClosed: (accountId, itemId) => poller.markCachedIssueClosed(accountId, itemId),
  });
  registerIntakeHandlers({
    ipcMain,
    ensureManifest,
    saveManifest: (m) => saveOrchestratorManifest(deps!.manifestFilePath, m),
    ensureRepoLinks,
    getAccounts: () => deps?.getAccounts() ?? [],
    issueAccounts,
    getToken: (key, force) => deps!.getToken(key, force),
    snapshot,
    reconcileFromCache: () => poller.reconcileFromCache(),
    cachedFor: (accountId) => poller.cachedFor(accountId),
  });
  registerWorktreeDiffHandlers({ ipcMain, ensureManifest });
  registerCreateIssueHandlers({
    ipcMain,
    getAccounts: () => deps?.getAccounts() ?? [],
    getToken: (key, force) => deps!.getToken(key, force),
    sourceForProvider: issueSourceForAuthProvider,
    getProjectMappings: async () => (await ensureManifest()).projectMappings,
  });

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
    prepareWorktree: (item, opts) => prepareWorktreeFor(item, opts ?? {}),
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
    prepareWorktree: (item, opts) => prepareWorktreeFor(item, opts ?? {}),
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

  initBaseAdvance({
    plansDir: orchestratorDeps.plansDir,
    worktreesDir: orchestratorDeps.worktreesDir,
    getItems: async () => Object.values((await ensureManifest()).items),
    getRepoLinks: ensureRepoLinks,
    saveRepoLinks: (links) => saveRepoLinks(orchestratorDeps.repoLinksFilePath, links),
    withRepoGitLock,
    requestTransition,
    setBaseAdvance,
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
