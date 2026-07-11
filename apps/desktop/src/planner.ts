import {
  generatePlan,
  ClaudeCLIProvider,
  type LLMProviderInterface,
} from "@nestbrain/core";
import type {
  Issue,
  LifecycleState,
  RepoRef,
  TrackedItem,
  TransitionActor,
} from "@nestbrain/shared";
import { planFileName, writeStoredPlan } from "./plan-store";

// Eager planner loop (issue #7): watches the orchestrator manifest for triage
// items whose repo is linked, moves them to planning, runs the core plan
// generator in the repo checkout, and lands them on plan-gate. Background,
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
  /** Sets plan.ref + transition to plan-gate in one manifest write. */
  completePlan: (itemId: string, ref: string) => Promise<void>;
  plansDir: string;
}

const PLANNING_CONCURRENCY = 2;
const PLANNER_MODEL = "sonnet";

let deps: PlannerDeps | null = null;
let llm: LLMProviderInterface | null = null;
const queue: string[] = [];
const queued = new Set<string>();
const inFlight = new Set<string>();
let active = 0;
let scanScheduled = false;

export function initPlanner(plannerDeps: PlannerDeps, provider?: LLMProviderInterface): void {
  deps = plannerDeps;
  llm = provider ?? new ClaudeCLIProvider(PLANNER_MODEL);
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
  if (!deps || !llm || inFlight.has(itemId)) return;
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
    const cached = deps.getIssue(item);
    const plan = await generatePlan({
      issue: {
        number: item.number,
        title: item.title,
        url: item.url,
        labels: cached?.labels ?? [],
        body: cached?.body,
      },
      repoPath,
      llm,
    });
    const ref = planFileName(itemId);
    await writeStoredPlan(deps.plansDir, ref, {
      version: 1,
      itemId,
      repo: item.repo,
      issueNumber: item.number,
      generatedAt: new Date().toISOString(),
      model: PLANNER_MODEL,
      plan,
    });
    // Cooperative cancel: the item may have been closed/moved mid-generation.
    if (deps.getItem(itemId)?.state === "planning") {
      await deps.completePlan(itemId, ref);
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
