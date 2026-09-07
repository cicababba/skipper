import { critiqueDiff, resolveReviewMode, type OrchestratorSettings } from "@skipper/core";
import type {
  AgentReview,
  AgentRuntimeId,
  CodingEvent,
  Issue,
  LifecycleState,
  LlmSettings,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredCoderReport,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { randomUUID } from "node:crypto";
import { buildLlm, modelForRole, providerCacheKey, type LlmBundle } from "./llm-settings";
import type { WorktreeDiff } from "./worktrees";

// Agent review loop (issue #10): consumes "agent-review" items (the #9 coder's
// output) with fresh context — the critic never sees the coder's session, only
// the diff and the issue's acceptance criteria. reviewMaxRounds per fix chain (#62),
// then needs-input: non-convergence is a confidence signal, not an error.
//
// Unlike the coder there is no abort path: askStructured has no signal param,
// so a mid-review move just wastes one CLI call — results are discarded by
// re-checking the item state after every await. The review streams coarse
// lifecycle beats over its own event channel (#113) — critiqueDiff is one
// blocking structured call, so there is no critic prose to stream. A dedicated
// channel keeps this traffic off the coding buffer-reset heuristic.

export interface ReviewerDeps {
  listItems: () => TrackedItem[];
  getItem: (itemId: string) => TrackedItem | undefined;
  /** Cached inbox issue for the item (labels + body), best-effort. */
  getIssue: (item: TrackedItem) => Issue | undefined;
  /** Acceptance criteria source. */
  getPlan: (item: TrackedItem) => Promise<StoredPlan | null>;
  /** The coder's structured report (#146), threaded into the critic as context. */
  getCoderReport: (item: TrackedItem) => Promise<StoredCoderReport | null>;
  getDiff: (item: TrackedItem) => Promise<WorktreeDiff>;
  /** Sets item.review + the transition in ONE manifest write (mirrors completePlan). */
  completeReview: (
    itemId: string,
    review: AgentReview,
    to: LifecycleState,
    reason: string,
    resumeTo?: LifecycleState,
  ) => Promise<void>;
  getSettings: () => OrchestratorSettings;
  /** Per-repo overrides (#62): review mode + reviewMaxRounds. */
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  /** settings.json llm block (#59) — which provider the reviewer runs on. */
  getLlmSettings: () => Promise<LlmSettings>;
  /** Records the critic round's Claude session id + minting runtime without a transition (#111/#238). */
  setReviewSessionId: (itemId: string, sessionId: string, sessionRuntime?: AgentRuntimeId) => Promise<void>;
  /** Coarse lifecycle beats over the review console channel (#113). */
  emitEvent: (itemId: string, event: CodingEvent) => void;
}

const REVIEW_CONCURRENCY = 2;

let deps: ReviewerDeps | null = null;
let critic: typeof critiqueDiff = critiqueDiff;
let bundle: LlmBundle | null = null;
let bundleKey: string | null = null;
const queue: string[] = [];
const queued = new Set<string>();
const inFlight = new Set<string>();
let active = 0;
let scanScheduled = false;

export function initReviewer(reviewerDeps: ReviewerDeps, criticImpl?: typeof critiqueDiff): void {
  deps = reviewerDeps;
  critic = criticImpl ?? critiqueDiff;
  bundle = null;
  bundleKey = null;
  queue.length = 0;
  queued.clear();
  inFlight.clear();
  active = 0;
}

/** The bundle (provider + runtime) built from Settings (#59/#238), cached per
 *  provider+model. The role model only applies to claude-cli — see modelForRole. */
async function resolveBundle(roleModel: string, roleRuntime: AgentRuntimeId): Promise<LlmBundle> {
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
    // Priors flow whenever the last outcome was a real verdict carrying objections —
    // even on a chat-apply re-entry that reset the round counter (#205). chained tells
    // the prompt whether the coder was explicitly instructed to fix them.
    const prevReview = item.review;
    const prior =
      prevReview &&
      prevReview.outcome !== "skipped" &&
      prevReview.outcome !== "unavailable" &&
      (prevReview.objections?.length ?? 0) > 0
        ? { objections: prevReview.objections!, deliveredToCoder: chained }
        : undefined;
    const now = () => new Date().toISOString();
    const emit = deps.emitEvent;

    // The fetching beat resets the per-item review buffer — every round opens here.
    emit(itemId, {
      kind: "status",
      phase: "fetching",
      detail: chained ? `review round ${round}` : "capturing diff",
    });

    let diff: WorktreeDiff;
    try {
      diff = await deps.getDiff(item);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(itemId, { kind: "error", message });
      await complete(
        itemId,
        { rounds: round - 1 || 0, outcome: "unavailable", reason: message, at: now() },
        "needs-input",
        `cannot capture worktree diff: ${message.slice(0, 500)}`,
        "queued",
      );
      return;
    }
    if (deps.getItem(itemId)?.state !== "agent-review") return;

    if (diff.stats.filesChanged === 0) {
      emit(itemId, {
        kind: "error",
        message: "coding produced no changes — nothing to review",
      });
      await complete(
        itemId,
        { rounds: round - 1 || 0, outcome: "unavailable", reason: "empty diff", at: now() },
        "needs-input",
        "coding produced no changes — nothing to review",
        "queued",
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
        emit(itemId, { kind: "result", ok: true, summary: `review skipped: ${decision.reason}` });
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
    const storedReport = await deps.getCoderReport(item).catch(() => null);
    if (deps.getItem(itemId)?.state !== "agent-review") return;
    const cached = deps.getIssue(item);
    const issue = {
      key: item.key,
      title: item.title,
      url: item.url,
      labels: cached?.labels ?? [],
      body: cached?.body,
    };

    let signal;
    // sessionId is minted inside the try so a provider-resolution or persistence
    // failure routes to human-review "unavailable" like the critic call itself,
    // rather than escaping run() as an unhandled rejection.
    let sessionId: string | undefined;
    try {
      const { llm: provider, runtime } = await resolveBundle(
        repoSettings.reviewerModel,
        repoSettings.reviewerRuntime,
      );
      if (deps.getItem(itemId)?.state !== "agent-review") return;
      // Persist a fresh session per round so the human can resume the critic run from
      // the worktree later (#111). cwd-scoped, needs a resume-capable runtime;
      // persist-before-run. A session also unlocks the repo-inspecting critic (#226).
      const wtPath = item.worktree?.path;
      sessionId = runtime?.capabilities.resume && wtPath ? randomUUID() : undefined;
      if (sessionId) await deps.setReviewSessionId(itemId, sessionId, runtime!.id);
      emit(itemId, { kind: "status", phase: "agent-start", detail: `round ${round}` });
      if (sessionId) emit(itemId, { kind: "agent-init", sessionId });
      signal = await critic(
        {
          diff: diff.diff,
          issue,
          acceptance: stored?.plan.acceptance ?? [],
          ...(storedReport ? { report: storedReport.report } : {}),
          ...(sessionId ? { session: { id: sessionId, cwd: wtPath! } } : {}),
          ...(prior ? { prior } : {}),
          ...(stored?.plan.context?.length ? { planContext: stored.plan.context } : {}),
        },
        provider,
        runtime,
      );
    } catch (err) {
      if (deps.getItem(itemId)?.state !== "agent-review") return;
      const message = err instanceof Error ? err.message : String(err);
      emit(itemId, { kind: "error", message });
      // Advisory gate down must not park the pipeline: the human reviews next
      // anyway. Contrast: a missing deliverable (getDiff) goes to needs-input.
      await complete(
        itemId,
        {
          rounds: round - 1 || 0,
          outcome: "unavailable",
          reason: message,
          ...(sessionId ? { sessionId } : {}),
          at: now(),
        },
        "human-review",
        `agent review unavailable: ${message.slice(0, 200)}`,
      );
      return;
    }
    if (deps.getItem(itemId)?.state !== "agent-review") return;

    const needsFix = signal.verdict === "reject" || signal.objections.some((o) => o.blocking);
    const summary = `round ${round}: ${signal.verdict} — ${signal.objections.length} objection(s)`;
    if (!needsFix) {
      emit(itemId, { kind: "result", ok: true, summary });
      const note = signal.objections[0]?.detail;
      await complete(
        itemId,
        {
          rounds: round,
          outcome: signal.verdict,
          objections: signal.objections,
          ...(signal.resolved?.length ? { resolvedObjections: signal.resolved } : {}),
          ...(sessionId ? { sessionId } : {}),
          at: now(),
        },
        "human-review",
        `agent review round ${round}: ${signal.verdict}${note ? ` — ${note}` : ""}`.slice(0, 200),
      );
    } else if (round >= repoSettings.reviewMaxRounds) {
      emit(itemId, { kind: "result", ok: false, summary: `${summary} — did not converge` });
      const blocking = signal.objections
        .filter((o) => o.blocking)
        .map((o) => o.detail)
        .join("; ");
      // The diff exists and survived N rounds — resume as the human inspecting
      // it in the merge editor, not a from-scratch replan.
      await complete(
        itemId,
        {
          rounds: round,
          outcome: signal.verdict,
          objections: signal.objections,
          ...(signal.resolved?.length ? { resolvedObjections: signal.resolved } : {}),
          ...(sessionId ? { sessionId } : {}),
          at: now(),
        },
        "needs-input",
        `review did not converge after ${repoSettings.reviewMaxRounds} rounds: ${blocking || signal.verdict}`.slice(
          0,
          500,
        ),
        "human-review",
      );
    } else {
      emit(itemId, { kind: "result", ok: false, summary: `${summary} — sending back for fixes` });
      await complete(
        itemId,
        {
          rounds: round,
          outcome: signal.verdict,
          objections: signal.objections,
          pendingObjections: signal.objections,
          ...(signal.resolved?.length ? { resolvedObjections: signal.resolved } : {}),
          ...(sessionId ? { sessionId } : {}),
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
  resumeTo?: LifecycleState,
): Promise<void> {
  await deps?.completeReview(itemId, review, to, reason, resumeTo).catch(() => {
    /* item moved concurrently — nothing to do */
  });
}
