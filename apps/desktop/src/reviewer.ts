import {
  createProvider,
  critiqueDiff,
  resolveReviewMode,
  type LLMProviderInterface,
  type OrchestratorSettings,
} from "@skipper/core";
import type {
  AgentReview,
  Issue,
  LifecycleState,
  LlmSettings,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { modelForRole, providerCacheKey } from "./llm-settings";
import type { WorktreeDiff } from "./worktrees";

// Agent review loop (issue #10): consumes "agent-review" items (the #9 coder's
// output) with fresh context — the critic never sees the coder's session, only
// the diff and the issue's acceptance criteria. reviewMaxRounds per fix chain (#62),
// then needs-input: non-convergence is a confidence signal, not an error.
//
// Unlike the coder there is no abort path: askStructured has no signal param,
// so a mid-review move just wastes one CLI call — results are discarded by
// re-checking the item state after every await. No emitEvent either: a review
// is one fast structured call, and the coding event channel's buffer-reset
// heuristic must not see reviewer traffic.

export interface ReviewerDeps {
  listItems: () => TrackedItem[];
  getItem: (itemId: string) => TrackedItem | undefined;
  /** Cached inbox issue for the item (labels + body), best-effort. */
  getIssue: (item: TrackedItem) => Issue | undefined;
  /** Acceptance criteria source. */
  getPlan: (item: TrackedItem) => Promise<StoredPlan | null>;
  getDiff: (item: TrackedItem) => Promise<WorktreeDiff>;
  /** Sets item.review + the transition in ONE manifest write (mirrors completePlan). */
  completeReview: (
    itemId: string,
    review: AgentReview,
    to: LifecycleState,
    reason: string,
  ) => Promise<void>;
  getSettings: () => OrchestratorSettings;
  /** Per-repo overrides (#62): review mode + reviewMaxRounds. */
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  /** settings.json llm block (#59) — which provider the reviewer runs on. */
  getLlmSettings: () => Promise<LlmSettings>;
}

const REVIEW_CONCURRENCY = 2;

let deps: ReviewerDeps | null = null;
let critic: typeof critiqueDiff = critiqueDiff;
let llm: LLMProviderInterface | null = null;
let llmKey: string | null = null;
const queue: string[] = [];
const queued = new Set<string>();
const inFlight = new Set<string>();
let active = 0;
let scanScheduled = false;

export function initReviewer(reviewerDeps: ReviewerDeps, criticImpl?: typeof critiqueDiff): void {
  deps = reviewerDeps;
  critic = criticImpl ?? critiqueDiff;
  llm = null;
  llmKey = null;
  queue.length = 0;
  queued.clear();
  inFlight.clear();
  active = 0;
}

/** The provider picked in Settings (#59), cached per provider+model. The role model
 *  only applies to claude-cli — see modelForRole. */
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

/** Coalesced re-scan — fired after polls and transitions. */
export function pokeReviewer(): void {
  if (!deps || scanScheduled) return;
  scanScheduled = true;
  setImmediate(() => {
    scanScheduled = false;
    scan();
  });
}

function scan(): void {
  if (!deps) return;
  for (const item of deps.listItems()) {
    if (item.state !== "agent-review") continue;
    if (inFlight.has(item.id) || queued.has(item.id)) continue;
    queued.add(item.id);
    queue.push(item.id);
  }
  pump();
}

function pump(): void {
  while (active < REVIEW_CONCURRENCY && queue.length > 0) {
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
    if (!item || item.state !== "agent-review") return;

    // Rounds chain only through reviewer-driven fix cycles (pendingObjections
    // set). Approve/skip records carry none, so a human bounce or replan
    // restarts at 1. Note: a needs-input → coding user resume re-enters as a
    // chained round — one more rejection re-exits; correct, non-convergence
    // is a signal.
    const chained = (item.review?.pendingObjections?.length ?? 0) > 0;
    const round = chained ? item.review!.rounds + 1 : 1;
    const now = () => new Date().toISOString();

    let diff: WorktreeDiff;
    try {
      diff = await deps.getDiff(item);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await complete(
        itemId,
        { rounds: round - 1 || 0, outcome: "unavailable", reason: message, at: now() },
        "needs-input",
        `cannot capture worktree diff: ${message.slice(0, 500)}`,
      );
      return;
    }
    if (deps.getItem(itemId)?.state !== "agent-review") return;

    if (diff.stats.filesChanged === 0) {
      await complete(
        itemId,
        { rounds: round - 1 || 0, outcome: "unavailable", reason: "empty diff", at: now() },
        "needs-input",
        "coding produced no changes — nothing to review",
      );
      return;
    }

    const settings = deps.getSettings();
    const repoSettings = deps.getRepoSettings(item.repo);
    // Mode gate only on the first round: a fix round is always re-reviewed,
    // otherwise the loop is pointless.
    if (!chained) {
      const decision = resolveReviewMode({
        mode: repoSettings.review,
        stats: diff.stats,
        planConfidence: item.plan?.confidence,
        highThreshold: settings.confidence.high,
      });
      if (!decision.review) {
        await complete(
          itemId,
          { rounds: 0, outcome: "skipped", reason: decision.reason, at: now() },
          "human-review",
          decision.reason,
        );
        return;
      }
    }

    const stored = await deps.getPlan(item);
    if (deps.getItem(itemId)?.state !== "agent-review") return;
    const cached = deps.getIssue(item);
    const issue = {
      number: item.number,
      title: item.title,
      url: item.url,
      labels: cached?.labels ?? [],
      body: cached?.body,
    };

    let signal;
    try {
      signal = await critic(
        { diff: diff.diff, issue, acceptance: stored?.plan.acceptance ?? [] },
        await resolveProvider(repoSettings.reviewerModel),
      );
    } catch (err) {
      if (deps.getItem(itemId)?.state !== "agent-review") return;
      const message = err instanceof Error ? err.message : String(err);
      // Advisory gate down must not park the pipeline: the human reviews next
      // anyway. Contrast: a missing deliverable (getDiff) goes to needs-input.
      await complete(
        itemId,
        { rounds: round - 1 || 0, outcome: "unavailable", reason: message, at: now() },
        "human-review",
        `agent review unavailable: ${message.slice(0, 200)}`,
      );
      return;
    }
    if (deps.getItem(itemId)?.state !== "agent-review") return;

    const needsFix = signal.verdict === "reject" || signal.objections.some((o) => o.blocking);
    if (!needsFix) {
      const note = signal.objections[0]?.detail;
      await complete(
        itemId,
        { rounds: round, outcome: signal.verdict, objections: signal.objections, at: now() },
        "human-review",
        `agent review round ${round}: ${signal.verdict}${note ? ` — ${note}` : ""}`.slice(0, 200),
      );
    } else if (round >= repoSettings.reviewMaxRounds) {
      const blocking = signal.objections
        .filter((o) => o.blocking)
        .map((o) => o.detail)
        .join("; ");
      await complete(
        itemId,
        { rounds: round, outcome: signal.verdict, objections: signal.objections, at: now() },
        "needs-input",
        `review did not converge after ${repoSettings.reviewMaxRounds} rounds: ${blocking || signal.verdict}`.slice(
          0,
          500,
        ),
      );
    } else {
      await complete(
        itemId,
        {
          rounds: round,
          outcome: signal.verdict,
          objections: signal.objections,
          pendingObjections: signal.objections,
          at: now(),
        },
        "coding",
        `review round ${round}: ${signal.verdict} — sending back for fixes`,
      );
    }
  } finally {
    inFlight.delete(itemId);
    active--;
    pump();
  }
}

async function complete(
  itemId: string,
  review: AgentReview,
  to: LifecycleState,
  reason: string,
): Promise<void> {
  await deps?.completeReview(itemId, review, to, reason).catch(() => {
    /* item moved concurrently — nothing to do */
  });
}
