import {
  computeConfidence,
  generatePlan,
  ClaudeCLIProvider,
  type LLMProviderInterface,
  type OrchestratorSettings,
} from "@nestbrain/core";
import type {
  ConfidenceReport,
  Issue,
  LifecycleState,
  RepoRef,
  StoredPlan,
  TrackedItem,
  TransitionActor,
} from "@nestbrain/shared";
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
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
  ) => Promise<TrackedItem>;
  /** Sets plan.ref + the confidence-gated transition in one manifest write (#8). */
  completePlan: (itemId: string, ref: string, confidence?: ConfidenceReport) => Promise<void>;
  /** Live orchestrator settings — planner model + confidence knobs. */
  getSettings: () => OrchestratorSettings;
  plansDir: string;
}

const PLANNING_CONCURRENCY = 2;

let deps: PlannerDeps | null = null;
let llm: LLMProviderInterface | null = null;
let llmModel: string | null = null;
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
  llmModel = null;
}

/** Injected provider (tests) wins; otherwise a CLI provider cached per model. */
function resolveProvider(model: string): { llm: LLMProviderInterface; model: string } {
  if (llmInjected && llm) return { llm, model };
  if (!llm || llmModel !== model) {
    llm = new ClaudeCLIProvider(model);
    llmModel = model;
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
      if (!deps.getRepoPath(item.repo)) continue;
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
      await deps.requestTransition(itemId, "needs-input", "planner", "repo not linked");
      return;
    }
    const settings = deps.getSettings();
    const { llm: provider, model } = resolveProvider(settings.plannerModel);
    const cached = deps.getIssue(item);
    const issue = {
      number: item.number,
      title: item.title,
      url: item.url,
      labels: cached?.labels ?? [],
      body: cached?.body,
    };
    const plan = await generatePlan({ issue, repoPath, llm: provider });
    const ref = planFileName(itemId);
    const stored: StoredPlan = {
      version: 2,
      itemId,
      repo: item.repo,
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
    let report: ConfidenceReport | undefined;
    try {
      report = await computeConfidence({
        plan,
        issue,
        repoPath,
        llm: provider,
        extraPlanRuns: settings.confidence.extraPlanRuns,
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
      await deps
        .requestTransition(
          itemId,
          "needs-input",
          "planner",
          `plan generation failed: ${message.slice(0, 500)}`,
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
