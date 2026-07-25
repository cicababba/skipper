import {
  AgentAbortError,
  computeConfidence,
  generatePlan,
  type GraphifyContext,
  type IssueComment,
  type LLMProviderInterface,
  type MemoryMcp,
  type OrchestratorSettings,
  type RunConfinement,
} from "@skipper/core";
import { checkoutEscapeReason, newDirtyPaths } from "./worktrees";
import {
  latestPlanningTransitionAt,
  type AgentRuntimeId,
  type CodingEvent,
  type ConfidenceReport,
  type Issue,
  type LifecycleState,
  type LlmSettings,
  type RepoRef,
  type ResolvedRepoOrchestratorSettings,
  type StoredPlan,
  type TrackedItem,
  type TransitionActor,
} from "@skipper/shared";
import { randomUUID } from "node:crypto";
import { buildLlm, injectedBundle, modelForRole, providerCacheKey, type LlmBundle } from "./llm-settings";
import { planFileName, writeStoredPlan } from "./plan-store";

// Eager planner loop (issue #7): watches the orchestrator manifest for triage
// items whose repo is linked, moves them to planning, runs the core plan
// generator in the repo checkout, scores confidence (#8), and lands them on
// the confidence-gated target (queued / plan-gate / needs-input). Background,
// bounded concurrency, cooperative cancellation (re-checks state before
// applying results).

export interface PlannerDeps {
  listItems: () => TrackedItem[];
  getItem: (itemId: string) => TrackedItem | undefined;
  /** Cached inbox issue for the item (labels + body), best-effort. */
  getIssue: (item: TrackedItem) => Issue | undefined;
  /** Fresh issue comments fetched at plan time (#144); may reject — the loop degrades. */
  fetchIssueComments?: (item: TrackedItem) => Promise<IssueComment[]>;
  getRepoPath: (repo: RepoRef) => string | undefined;
  /** Uncommitted paths in the checkout (git status --porcelain); null if git fails (#196). */
  checkoutDirtyPaths: (repoPath: string) => Promise<string[] | null>;
  /** Per-repo settings (#15, #62) — gates auto-plan on admission; carries autoCoding. */
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  /** A repo-instructions generation is in flight for this repo (#227) — auto-plan
   *  waits for it so the plan runs under the repo's conventions. */
  instructionsPending: (repo: RepoRef) => boolean;
  /** The repo's ready agent-instructions doc content (#227), or undefined. */
  getRepoInstructions: (repo: RepoRef) => Promise<string | undefined>;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
    resumeTo?: LifecycleState,
  ) => Promise<TrackedItem>;
  /** Sets plan.ref + the confidence-gated transition in one manifest write (#8).
   *  expectedPlanningAt is the run's token (#159) — a stale run is refused. */
  completePlan: (
    itemId: string,
    ref: string,
    confidence?: ConfidenceReport,
    expectedPlanningAt?: string,
  ) => Promise<void>;
  /** Sets up the shared worktree so planning runs where coding will (#110). */
  prepareWorktree: (item: TrackedItem) => Promise<{ path: string; branch: string }>;
  /** Persists the worktree record without a transition (#110). */
  setWorktree: (itemId: string, worktree: { path: string; branch: string }) => Promise<void>;
  /** Records the plan run's Claude session id + the runtime that minted it (#111/#238). */
  setPlanSessionId: (itemId: string, sessionId: string, sessionRuntime?: AgentRuntimeId) => Promise<void>;
  /** Live orchestrator settings — planner model + confidence knobs. */
  getSettings: () => OrchestratorSettings;
  /** settings.json llm block (#59) — which provider the planner runs on. */
  getLlmSettings: () => Promise<LlmSettings>;
  /** Planner console stream (#32): per-item envelopes over skipper:planning:*. */
  emitEvent: (itemId: string, event: CodingEvent) => void;
  plansDir: string;
  /** skipper-memory MCP for this item's repo (#45); undefined = no CLI bundle. */
  getMemoryMcp?: (item: TrackedItem) => MemoryMcp | undefined;
  /** The repo's Graphify knowledge-graph context (#233); undefined = toggle off,
   *  unlinked, or no graph yet. May reject — the run degrades to no graph. */
  getGraphify?: (item: TrackedItem) => Promise<GraphifyContext | undefined> | undefined;
}

const PLANNING_CONCURRENCY = 2;

let deps: PlannerDeps | null = null;
let injected = false;
let injectedProvider: LLMProviderInterface | null = null;
let bundle: LlmBundle | null = null;
let bundleKey: string | null = null;
const queue: string[] = [];
const queued = new Set<string>();
const inFlight = new Map<string, AbortController>();
let active = 0;
let scanScheduled = false;

export function initPlanner(plannerDeps: PlannerDeps, provider?: LLMProviderInterface): void {
  deps = plannerDeps;
  injected = provider !== undefined;
  injectedProvider = provider ?? null;
  bundle = null;
  bundleKey = null;
  // Fresh init (tests / re-init) starts with a clean queue. `active` is left
  // alone — it self-balances via the finally block of any in-flight run.
  inFlight.clear();
  queued.clear();
  queue.length = 0;
}

/** Abort a live planning run (user untracked / moved the item out of "planning"). */
export function cancelPlanningRun(itemId: string): void {
  queued.delete(itemId);
  inFlight.get(itemId)?.abort();
}

/** Quit teardown — kill every live planning run. */
export function killAllPlanningRuns(): void {
  for (const controller of inFlight.values()) controller.abort();
}

/**
 * Injected provider (tests) wins; otherwise the bundle (provider + runtime) built
 * from Settings (#59/#238), cached per provider+model. The role model only applies
 * to claude-cli — openai carries its own model in settings.json.
 */
async function resolveBundle(roleModel: string, roleRuntime: AgentRuntimeId): Promise<LlmBundle> {
  if (injected && injectedProvider) return injectedBundle(injectedProvider, roleModel, roleRuntime);
  const settings = await deps!.getLlmSettings();
  const model = modelForRole(settings, roleModel);
  const key = providerCacheKey(settings, model, roleRuntime);
  if (!bundle || bundleKey !== key) {
    bundle = buildLlm(settings, roleModel, 5, roleRuntime);
    bundleKey = key;
  }
  return bundle;
}

/** Coalesced re-scan — fired after polls and transitions. */
export function pokePlanner(): void {
  if (!deps || scanScheduled) return;
  scanScheduled = true;
  setImmediate(() => {
    scanScheduled = false;
    void scan().catch(() => {
      /* per-item errors already handled in run() */
    });
  });
}

async function scan(): Promise<void> {
  if (!deps) return;
  for (const item of deps.listItems()) {
    if (inFlight.has(item.id) || queued.has(item.id)) continue;
    if (item.state === "triage") {
      if (item.holdAutoPlan) continue; // resume rite (#15): wait for the user
      // #62 master switch. Gates auto-plan only — the "planning" branch below still
      // has to run, or crash recovery and the user's manual Pianifica would strand.
      if (deps.getSettings().autoPlanPaused) continue;
      if (!deps.getRepoPath(item.repo)) continue;
      // Wait out an in-flight instructions generation (#227) — the coalesced
      // rescan on onSettled retries this item once the doc lands.
      if (deps.instructionsPending(item.repo)) continue;
      const rs = deps.getRepoSettings(item.repo);
      if (rs.autoPlan === "off") continue;
      if (rs.autoPlan === "label") {
        // Labels live in the poll cache only — after a restart, label-gated
        // repos wait one poll cycle for the cache to refill.
        const labels = deps.getIssue(item)?.labels ?? [];
        if (!labels.includes(rs.autoPlanLabel)) continue;
      }
      try {
        await deps.requestTransition(item.id, "planning", "planner", "auto-plan on admission");
      } catch {
        continue;
      }
      enqueue(item.id);
    } else if (item.state === "planning") {
      // user "Pianifica", needs-input resume, replan, crash recovery
      enqueue(item.id);
    }
  }
  pump();
}

function enqueue(itemId: string): void {
  queued.add(itemId);
  queue.push(itemId);
}

function pump(): void {
  while (active < PLANNING_CONCURRENCY && queue.length > 0) {
    const itemId = queue.shift()!;
    queued.delete(itemId);
    void run(itemId);
  }
}

async function run(itemId: string): Promise<void> {
  if (!deps || inFlight.has(itemId)) return;
  const controller = new AbortController();
  inFlight.set(itemId, controller);
  active++;
  // Run token (#159): the timestamp of this entry into planning. A cancel, or an
  // untrack → re-admit that mints a newer planning transition, makes every
  // write/transition below (and the catch guard) detectably stale so a zombie
  // can't land results on the fresh lifecycle.
  let planningAt: string | undefined;
  const live = (): boolean => {
    const cur = deps?.getItem(itemId);
    return (
      !controller.signal.aborted &&
      cur?.state === "planning" &&
      latestPlanningTransitionAt(cur) === planningAt
    );
  };
  try {
    const item = deps.getItem(itemId);
    if (!item || item.state !== "planning") return;
    planningAt = latestPlanningTransitionAt(item);
    const repoPath = deps.getRepoPath(item.repo);
    if (!repoPath) {
      await deps.requestTransition(itemId, "needs-input", "planner", "repo not linked", "planning");
      return;
    }
    // Confinement tripwire baseline (#196): the checkout's dirty set before the
    // run, so a post-run diff attributes only NEW dirt to this run.
    const checkoutBefore = await deps.checkoutDirtyPaths(repoPath);
    const tripwire = async (): Promise<string[] | null> => {
      if (!deps || checkoutBefore === null) return null;
      const after = await deps.checkoutDirtyPaths(repoPath);
      if (after === null) return null;
      const escaped = newDirtyPaths(checkoutBefore, after);
      return escaped.length > 0 ? escaped : null;
    };
    const failEscape = async (escaped: string[]): Promise<void> => {
      const reason = checkoutEscapeReason(escaped);
      deps!.emitEvent(itemId, { kind: "error", message: reason });
      await deps!
        .requestTransition(itemId, "needs-input", "planner", reason, "planning")
        .catch(() => {});
    };
    // #110: plan in the shared worktree so every phase has one cwd. Setup failure
    // degrades to the shared clone — never blocks planning with needs-input.
    let cwd = repoPath;
    let inWorktree = false;
    deps.emitEvent(itemId, { kind: "status", phase: "fetching" });
    try {
      const wt = await deps.prepareWorktree(item);
      cwd = wt.path;
      inWorktree = true;
      deps.emitEvent(itemId, { kind: "status", phase: "worktree", detail: wt.path });
      if (item.worktree?.path !== wt.path || item.worktree.branch !== wt.branch) {
        await deps.setWorktree(itemId, { path: wt.path, branch: wt.branch });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.emitEvent(itemId, {
        kind: "status",
        phase: "worktree",
        detail: `setup failed — planning in the shared clone: ${msg.slice(0, 200)}`,
      });
    }
    // fetch can be slow — re-check the item wasn't cancelled/moved meanwhile.
    if (!live()) return;
    const settings = deps.getSettings();
    const repoSettings = deps.getRepoSettings(item.repo);
    const { llm: provider, runtime, model } = await resolveBundle(
      repoSettings.plannerModel,
      repoSettings.plannerRuntime,
    );
    // No agent runtime (openai, #238) — planning cannot explore the repo. Park it
    // where the old generatePlan throw used to, so the user can switch providers.
    if (!runtime) {
      const reason = 'planning needs an agent runtime (claude-cli) — the selected provider has none. Pick one in Settings.';
      deps.emitEvent(itemId, { kind: "error", message: reason });
      await deps
        .requestTransition(itemId, "needs-input", "planner", reason, "planning")
        .catch(() => {});
      return;
    }
    // Persist a session only when the runtime can resume AND planning ran in the
    // worktree — a session recorded against the shared clone would violate the
    // cwd-scoped invalidation rule (#111). Persist-before-run so a crashed run
    // still leaves a resumable pointer.
    const planSessionId =
      runtime.capabilities.resume && inWorktree ? randomUUID() : undefined;
    if (planSessionId) await deps.setPlanSessionId(itemId, planSessionId, runtime.id);
    const cached = deps.getIssue(item);
    let comments: IssueComment[] = [];
    if (deps.fetchIssueComments) {
      try {
        comments = await deps.fetchIssueComments(item);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.emitEvent(itemId, {
          kind: "status",
          phase: "fetching",
          detail: `comment fetch failed — planning without comments: ${msg.slice(0, 200)}`,
        });
      }
    }
    const issue = {
      key: item.key,
      title: item.title,
      url: item.url,
      labels: cached?.labels ?? [],
      body: cached?.body,
      ...(comments.length > 0 ? { comments } : {}),
    };
    // agent-start marks a fresh run — it also resets the replay buffer upstream.
    deps.emitEvent(itemId, { kind: "status", phase: "agent-start" });
    const memory = deps.getMemoryMcp?.(item);
    // #202: surface the worktree's pre-existing uncommitted changes (leftover work
    // from a failed coding attempt) so the plan accounts for them. Only from the
    // worktree cwd — the shared clone's dirt is the user's own in-flight work.
    // null (git failure) is treated as absent, never blocks planning.
    const preexisting = inWorktree ? await deps.checkoutDirtyPaths(cwd) : null;
    // Confinement (#196): only when planning runs IN the worktree — when it
    // degraded to the checkout, the checkout is the legit cwd and no Bash
    // confinement is possible (prompts + tripwire guard it there).
    const confinement: RunConfinement | undefined = inWorktree
      ? {
          runRoot: cwd,
          denyRoots: [repoPath],
          ...(memory?.cliBundlePath ? { cliBundlePath: memory.cliBundlePath } : {}),
        }
      : undefined;
    // #227: the repo's conventions doc, injected into the planner + convergence
    // system prompts. Best-effort — a read failure never blocks planning.
    const repoInstructions = await deps.getRepoInstructions(item.repo).catch(() => undefined);
    // #233: the repo's knowledge-graph context — attaches the graphify MCP server
    // and a prompt section. Best-effort; a reject/absence just runs without it.
    const graphify = await deps.getGraphify?.(item)?.catch(() => undefined);
    if (graphify) {
      const shas = `graph @ ${graphify.indexedSha.slice(0, 7)}`;
      const detail =
        graphify.currentBaseSha && graphify.currentBaseSha !== graphify.indexedSha
          ? `${shas} (stale, base @ ${graphify.currentBaseSha.slice(0, 7)})`
          : shas;
      deps.emitEvent(itemId, { kind: "status", phase: "graphify", detail });
    }
    const plan = await generatePlan({
      issue,
      repoPath: cwd,
      llm: provider,
      runtime,
      hardTimeoutMs: settings.plannerTimeBudgetMin * 60_000,
      ...(repoInstructions ? { repoInstructions } : {}),
      ...(graphify ? { graphify } : {}),
      onEvent: (event) => {
        // The minted id is authoritative; if the CLI reports a different session
        // in its init line, reconcile to the real on-disk id (#111).
        if (event.kind === "agent-init" && planSessionId && event.sessionId !== planSessionId) {
          void deps?.setPlanSessionId(itemId, event.sessionId, runtime.id).catch(() => {});
        }
        deps?.emitEvent(itemId, event);
      },
      ...(memory ? { memory } : {}),
      ...(confinement ? { confinement } : {}),
      ...(preexisting?.length ? { preexistingChanges: preexisting } : {}),
      ...(planSessionId ? { sessionId: planSessionId } : {}),
      signal: controller.signal,
    });
    // Tripwire after generation — bail to needs-input if the run touched the checkout.
    const escapedAfterGen = await tripwire();
    if (escapedAfterGen) {
      if (live()) await failEscape(escapedAfterGen);
      return;
    }
    const ref = planFileName(itemId);
    const stored: StoredPlan = {
      version: 2,
      itemId,
      repo: item.repo,
      issueKey: item.key,
      issueNumber: item.number,
      generatedAt: new Date().toISOString(),
      model,
      plan,
    };
    // planFileName is deterministic — a zombie write would clobber the fresh
    // lifecycle's plan file, so gate the write on the run being live (#159).
    if (!live()) return;
    // Persist before the expensive scoring so the plan survives a crash mid-score.
    await writeStoredPlan(deps.plansDir, ref, stored);
    // Cooperative cancel: the item may have been closed/moved mid-generation.
    if (!live()) return;
    // Scoring failure is never fatal (#8): no report → conservative plan-gate.
    deps.emitEvent(itemId, { kind: "status", phase: "scoring" });
    let report: ConfidenceReport | undefined;
    try {
      report = await computeConfidence({
        plan,
        issue,
        repoPath: cwd,
        llm: provider,
        runtime,
        extraPlanRuns: settings.confidence.extraPlanRuns,
        thresholds: { high: settings.confidence.high, low: settings.confidence.low },
        // #62: score for the gate that will actually run — under on/off the
        // queued/plan-gate choice is pinned, so the extra runs often can't move it.
        autoCoding: deps.getRepoSettings(item.repo).autoCoding,
        signal: controller.signal,
        ...(confinement ? { confinement } : {}),
        ...(repoInstructions ? { repoInstructions } : {}),
        ...(graphify ? { graphify } : {}),
      });
      if (Object.keys(report.signals).length === 0) report = undefined;
    } catch {
      report = undefined;
    }
    // Tripwire after scoring (its extra plan runs also explore the repo).
    const escapedAfterScore = await tripwire();
    if (escapedAfterScore) {
      if (live()) await failEscape(escapedAfterScore);
      return;
    }
    if (report && live()) {
      await writeStoredPlan(deps.plansDir, ref, { ...stored, confidence: report });
    }
    if (live()) {
      await deps.completePlan(itemId, ref, report, planningAt);
    }
  } catch (err) {
    // A cancelled/superseded run dies silently — never park the (possibly fresh)
    // lifecycle on a zombie's failure (#159).
    if (err instanceof AgentAbortError || controller.signal.aborted) return;
    if (live()) {
      const message = err instanceof Error ? err.message : String(err);
      deps.emitEvent(itemId, { kind: "error", message: message.slice(0, 500) });
      await deps
        .requestTransition(
          itemId,
          "needs-input",
          "planner",
          `plan generation failed: ${message.slice(0, 500)}`,
          "planning",
        )
        .catch(() => {
          /* item moved concurrently — nothing to do */
        });
    }
  } finally {
    inFlight.delete(itemId);
    active--;
    // Coalesced rescan re-enqueues a re-admitted planning item that scan()
    // skipped while this run held the inFlight slot (#159).
    pokePlanner();
  }
}
