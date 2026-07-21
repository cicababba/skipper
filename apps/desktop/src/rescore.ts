import {
  AgentAbortError,
  computeConfidence as realComputeConfidence,
  createProvider,
  type IssueComment,
  type LLMProviderInterface,
  type OrchestratorSettings,
} from "@skipper/core";
import type {
  CodingEvent,
  ConfidenceReport,
  Issue,
  LlmSettings,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { modelForRole, providerCacheKey } from "./llm-settings";
import { readStoredPlan, writeStoredPlan } from "./plan-store";

// Re-score confidence after a plan-chat Apply (#164): Apply re-emits the plan
// from the discussion, but the confidence report still describes the plan the
// user just rewrote. This runs the scoring pipeline (groundedness + critic +
// clarity; convergence skipped — it measured the original generation) on the
// post-apply plan in a detached run, then persists the fresh report and updates
// the manifest composite. Never re-resolves the gate. Leaving plan-gate, an
// inline edit, or a second Apply abort a live run; stale completions are refused.

export interface RescoreDeps {
  getItem: (itemId: string) => TrackedItem | undefined;
  getIssue: (item: TrackedItem) => Issue | undefined;
  /** Fresh issue comments (#144), best-effort — mirrors planner so critic/clarity match. */
  fetchIssueComments?: (item: TrackedItem) => Promise<IssueComment[]>;
  getRepoPath: (repo: RepoRef) => string | undefined;
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  getSettings: () => OrchestratorSettings;
  getLlmSettings: () => Promise<LlmSettings>;
  emitEvent: (itemId: string, event: CodingEvent) => void;
  plansDir: string;
  /** Marks the item rescoring (badge/spinner) without a transition. */
  setPlanRescoring: (itemId: string) => Promise<void>;
  /** Clears the flag; sets plan.confidence only when composite is defined. */
  completeRescore: (itemId: string, composite?: number) => Promise<void>;
  /** Test seam — the scoring pipeline. */
  computeConfidence?: typeof realComputeConfidence;
}

let deps: RescoreDeps | null = null;
let llm: LLMProviderInterface | null = null;
let llmKey: string | null = null;
const inFlight = new Map<string, AbortController>();

export function initRescore(rescoreDeps: RescoreDeps): void {
  deps = rescoreDeps;
  llm = null;
  llmKey = null;
  inFlight.clear();
}

/** Provider resolution mirrors the planner (role = plannerModel). */
async function resolveProvider(roleModel: string): Promise<LLMProviderInterface> {
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
  return llm;
}

/** Abort a live rescore (inline edit, leaving plan-gate, untrack). */
export function cancelRescore(itemId: string): void {
  inFlight.get(itemId)?.abort();
}

/** Quit teardown — kill every live rescore. */
export function killAllRescores(): void {
  for (const controller of inFlight.values()) controller.abort();
}

/** Fire-and-forget: aborts any previous rescore for the item, then runs detached. */
export function startRescore(itemId: string, applied: StoredPlan): void {
  if (!deps) return;
  inFlight.get(itemId)?.abort();
  const controller = new AbortController();
  inFlight.set(itemId, controller);
  void run(itemId, applied, controller);
}

async function run(itemId: string, applied: StoredPlan, controller: AbortController): Promise<void> {
  const d = deps!;
  const compute = d.computeConfidence ?? realComputeConfidence;
  let landed = false;
  try {
    const item = d.getItem(itemId);
    if (!item) return;
    await d.setPlanRescoring(itemId);
    d.emitEvent(itemId, { kind: "status", phase: "scoring" });

    const cwd = item.worktree?.path ?? d.getRepoPath(item.repo);
    if (!cwd) return;
    const provider = await resolveProvider(d.getRepoSettings(item.repo).plannerModel);

    let comments: IssueComment[] = [];
    if (d.fetchIssueComments) {
      try {
        comments = await d.fetchIssueComments(item);
      } catch {
        /* best-effort, mirrors the planner */
      }
    }
    const cached = d.getIssue(item);
    const issue = {
      key: item.key,
      title: item.title,
      url: item.url,
      labels: cached?.labels ?? [],
      body: cached?.body,
      ...(comments.length > 0 ? { comments } : {}),
    };
    const settings = d.getSettings();
    let report: ConfidenceReport | undefined = await compute({
      plan: applied.plan,
      issue,
      repoPath: cwd,
      llm: provider,
      thresholds: { high: settings.confidence.high, low: settings.confidence.low },
      autoCoding: d.getRepoSettings(item.repo).autoCoding,
      signal: controller.signal,
      skipConvergence: {
        reason: "rescore",
        detail: "plan revised via chat — convergence measured the original generation",
      },
    });
    if (report && Object.keys(report.signals).length === 0) report = undefined;

    // Liveness: still the owning run, not aborted, still at the gate, and the
    // stored plan is the exact revision we scored (editedAt is the write token).
    if (controller.signal.aborted || inFlight.get(itemId) !== controller) return;
    const after = d.getItem(itemId);
    if (after?.state !== "plan-gate") return;
    const ref = after.plan?.ref;
    if (!ref) return;
    const current = await readStoredPlan(d.plansDir, ref);
    if (
      !current ||
      current.editedAt !== applied.editedAt ||
      current.generatedAt !== applied.generatedAt
    ) {
      return;
    }
    // Re-check after the read: an inline edit that landed during it fires
    // cancelRescore in the same continuation as its write, so this closes the
    // read-then-write window that would clobber the edit with `current`.
    if (controller.signal.aborted || inFlight.get(itemId) !== controller) return;
    if (report) {
      await writeStoredPlan(d.plansDir, ref, { ...current, confidence: report });
    }
    await d.completeRescore(itemId, report?.composite);
    landed = true;
  } catch (err) {
    if (err instanceof AgentAbortError || controller.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    d.emitEvent(itemId, { kind: "error", message: message.slice(0, 500) });
  } finally {
    const stillOwner = inFlight.get(itemId) === controller;
    if (stillOwner) inFlight.delete(itemId);
    // Every non-landing exit clears the flag — but only while we still own the
    // run, so a superseding rescore's freshly-set flag is never cleared here.
    if (!landed && stillOwner) await d.completeRescore(itemId, undefined);
  }
}
