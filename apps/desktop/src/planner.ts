import {
  computeConfidence,
  createProvider,
  generatePlan,
  type LLMProviderInterface,
  type MemoryMcp,
  type OrchestratorSettings,
} from "@skipper/core";
import type {
  CodingEvent,
  ConfidenceReport,
  Issue,
  LifecycleState,
  LlmSettings,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredPlan,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import { modelForRole, providerCacheKey } from "./llm-settings";
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
  getRepoPath: (repo: RepoRef) => string | undefined;
  /** Per-repo settings (#15, #62) — gates auto-plan on admission; carries autoCoding. */
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
    resumeTo?: LifecycleState,
  ) => Promise<TrackedItem>;
  /** Sets plan.ref + the confidence-gated transition in one manifest write (#8). */
  completePlan: (itemId: string, ref: string, confidence?: ConfidenceReport) => Promise<void>;
  /** Sets up the shared worktree so planning runs where coding will (#110). */
  prepareWorktree: (item: TrackedItem) => Promise<{ path: string; branch: string }>;
  /** Persists the worktree record without a transition (#110). */
  setWorktree: (itemId: string, worktree: { path: string; branch: string }) => Promise<void>;
  /** Live orchestrator settings — planner model + confidence knobs. */
  getSettings: () => OrchestratorSettings;
  /** settings.json llm block (#59) — which provider the planner runs on. */
  getLlmSettings: () => Promise<LlmSettings>;
  /** Planner console stream (#32): per-item envelopes over skipper:planning:*. */
  emitEvent: (itemId: string, event: CodingEvent) => void;
  plansDir: string;
  /** skipper-memory MCP for this item's repo (#45); undefined = no CLI bundle. */
  getMemoryMcp?: (item: TrackedItem) => MemoryMcp | undefined;
}

const PLANNING_CONCURRENCY = 2;

let deps: PlannerDeps | null = null;
let llm: LLMProviderInterface | null = null;
let llmKey: string | null = null;
let llmInjected = false;
const queue: string[] = [];
const queued = new Set<string>();
const inFlight = new Set<string>();
let active = 0;
let scanScheduled = false;

export function initPlanner(plannerDeps: PlannerDeps, provider?: LLMProviderInterface): void {
  deps = plannerDeps;
  llmInjected = provider !== undefined;
  llm = provider ?? null;
  llmKey = null;
}

/**
 * Injected provider (tests) wins; otherwise the provider picked in Settings (#59),
 * cached per provider+model. The role model only applies to claude-cli — the other
 * providers carry their own model in settings.json.
 */
async function resolveProvider(roleModel: string): Promise<{ llm: LLMProviderInterface; model: string }> {
  if (llmInjected && llm) return { llm, model: roleModel };
  const settings = await deps!.getLlmSettings();
  const model = modelForRole(settings, roleModel);
  const key = providerCacheKey(settings, model);
  if (!llm || llmKey !== key) {
    llm = createProvider({
      provider: settings.provider,
      model,
      maxTurns: 5,
      apiKey: settings.provider === "openai" ? settings.openaiApiKey : undefined,
    });
    llmKey = key;
  }
  return { llm, model };
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
  inFlight.add(itemId);
  active++;
  try {
    const item = deps.getItem(itemId);
    if (!item || item.state !== "planning") return;
    const repoPath = deps.getRepoPath(item.repo);
    if (!repoPath) {
      await deps.requestTransition(itemId, "needs-input", "planner", "repo not linked", "planning");
      return;
    }
    // #110: plan in the shared worktree so every phase has one cwd. Setup failure
    // degrades to the shared clone — never blocks planning with needs-input.
    let cwd = repoPath;
    deps.emitEvent(itemId, { kind: "status", phase: "fetching" });
    try {
      const wt = await deps.prepareWorktree(item);
      cwd = wt.path;
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
    if (deps.getItem(itemId)?.state !== "planning") return;
    const settings = deps.getSettings();
    const { llm: provider, model } = await resolveProvider(
      deps.getRepoSettings(item.repo).plannerModel,
    );
    const cached = deps.getIssue(item);
    const issue = {
      key: item.key,
      title: item.title,
      url: item.url,
      labels: cached?.labels ?? [],
      body: cached?.body,
    };
    // agent-start marks a fresh run — it also resets the replay buffer upstream.
    deps.emitEvent(itemId, { kind: "status", phase: "agent-start" });
    const memory = deps.getMemoryMcp?.(item);
    const plan = await generatePlan({
      issue,
      repoPath: cwd,
      llm: provider,
      onEvent: (event) => deps?.emitEvent(itemId, event),
      ...(memory ? { memory } : {}),
    });
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
    // Persist before the expensive scoring so the plan survives a crash mid-score.
    await writeStoredPlan(deps.plansDir, ref, stored);
    // Cooperative cancel: the item may have been closed/moved mid-generation.
    if (deps.getItem(itemId)?.state !== "planning") return;
    // Scoring failure is never fatal (#8): no report → conservative plan-gate.
    deps.emitEvent(itemId, { kind: "status", phase: "scoring" });
    let report: ConfidenceReport | undefined;
    try {
      report = await computeConfidence({
        plan,
        issue,
        repoPath: cwd,
        llm: provider,
        extraPlanRuns: settings.confidence.extraPlanRuns,
        thresholds: { high: settings.confidence.high, low: settings.confidence.low },
        // #62: score for the gate that will actually run — under on/off the
        // queued/plan-gate choice is pinned, so the extra runs often can't move it.
        autoCoding: deps.getRepoSettings(item.repo).autoCoding,
      });
      if (Object.keys(report.signals).length === 0) report = undefined;
    } catch {
      report = undefined;
    }
    if (report) {
      await writeStoredPlan(deps.plansDir, ref, { ...stored, confidence: report });
    }
    if (deps.getItem(itemId)?.state === "planning") {
      await deps.completePlan(itemId, ref, report);
    }
  } catch (err) {
    if (deps.getItem(itemId)?.state === "planning") {
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
    pump();
  }
}
