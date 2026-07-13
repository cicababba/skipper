import { randomUUID } from "node:crypto";
import {
  runCodingAgent,
  buildCoderPrompt,
  buildFixPrompt,
  buildPrFixPrompt,
  buildResumePrompt,
  CODER_SYSTEM_PROMPT,
  CodingAbortError,
  compareQueueCandidates,
  type OrchestratorSettings,
  type QueueCandidate,
} from "@nestbrain/core";
import type {
  CodingEvent,
  Issue,
  LifecycleState,
  RepoPriority,
  RepoRef,
  StoredPlan,
  TrackedItem,
  TransitionActor,
} from "@nestbrain/shared";

// Coding runner loop (issue #9): consumes "queued" items — the approval gate's
// output — one at a time per repo. Creates/reuses an isolated git worktree,
// runs a write-capable claude agent on the stored plan, streams progress via
// emitEvent, and lands the item on agent-review (success), failed (agent
// error) or needs-input (environment problem). The uncommitted worktree diff
// is the deliverable for #10/#13/#14. Mirrors planner.ts: coalesced poke,
// cooperative cancellation, crash recovery for items stuck in "coding".

export interface CoderDeps {
  listItems: () => TrackedItem[];
  getItem: (itemId: string) => TrackedItem | undefined;
  /** Cached inbox issue for the item (labels + body), best-effort. */
  getIssue: (item: TrackedItem) => Issue | undefined;
  getPlan: (item: TrackedItem) => Promise<StoredPlan | null>;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
  ) => Promise<TrackedItem>;
  /** Persists item.worktree (path/branch/sessionId) without a transition. */
  setWorktree: (
    itemId: string,
    worktree: { path: string; branch: string; sessionId?: string },
  ) => Promise<void>;
  /** Fetch + resolve base + ensure worktree; composed in orchestrator.ts. */
  prepareWorktree: (item: TrackedItem) => Promise<{ path: string; branch: string }>;
  getSettings: () => OrchestratorSettings;
  /** Per-repo intake priority (#15) — feeds the queue ordering. */
  getRepoPriority: (repo: RepoRef) => RepoPriority;
  /** Buffer + forward one progress event (orchestrator owns the IPC channel). */
  emitEvent: (itemId: string, event: CodingEvent) => void;
}

let deps: CoderDeps | null = null;
let runner: typeof runCodingAgent = runCodingAgent;
const inFlight = new Map<string, AbortController>();
const activeRepos = new Map<string, number>();
let scanScheduled = false;

export function initCoder(coderDeps: CoderDeps, runnerImpl?: typeof runCodingAgent): void {
  deps = coderDeps;
  runner = runnerImpl ?? runCodingAgent;
  inFlight.clear();
  activeRepos.clear();
}

/** Coalesced re-scan — fired after polls, transitions and completed runs. */
export function pokeCoder(): void {
  if (!deps || scanScheduled) return;
  scanScheduled = true;
  setImmediate(() => {
    scanScheduled = false;
    void scan().catch(() => {
      /* per-item errors already handled in run() */
    });
  });
}

/** Abort a live run (user moved the item out of "coding"). */
export function cancelCodingRun(itemId: string): void {
  inFlight.get(itemId)?.abort();
}

/** Quit teardown — kill every live coding agent. */
export function killAllCodingRuns(): void {
  for (const controller of inFlight.values()) controller.abort();
}

function repoKeyOf(item: TrackedItem): string {
  return `${item.repo.owner.toLowerCase()}/${item.repo.name.toLowerCase()}`;
}

function queuedAt(item: TrackedItem): string {
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    if (item.transitions[i].to === "queued") return item.transitions[i].at;
  }
  return item.createdAt;
}

function toCandidate(item: TrackedItem): QueueCandidate {
  return {
    pinned: item.pinned === true,
    priority: deps!.getRepoPriority(item.repo),
    confidence: item.plan?.confidence,
    queuedAt: queuedAt(item),
  };
}

async function scan(): Promise<void> {
  if (!deps) return;
  const limit = Math.max(1, deps.getSettings().codingWipPerRepo ?? 1);
  const idle = deps.listItems().filter((item) => !inFlight.has(item.id));

  // Pass 1 — items already in "coding" (PR re-entries + crash recovery) always
  // resume first: they skip the queue but consume the repo's WIP limit. When
  // the repo is at limit they wait for release(), which pokes a rescan.
  const resumes = idle
    .filter((item) => item.state === "coding")
    .sort((a, b) => queuedAt(a).localeCompare(queuedAt(b)));
  for (const item of resumes) {
    const repoKey = repoKeyOf(item);
    if ((activeRepos.get(repoKey) ?? 0) >= limit) continue;
    activeRepos.set(repoKey, (activeRepos.get(repoKey) ?? 0) + 1);
    void run(item.id, repoKey);
  }

  // Pass 2 — the queue proper, in #15 order (pin > priority > confidence > age).
  const queuedItems = idle
    .filter((item) => item.state === "queued")
    .sort((a, b) => compareQueueCandidates(toCandidate(a), toCandidate(b)));
  for (const item of queuedItems) {
    const repoKey = repoKeyOf(item);
    if ((activeRepos.get(repoKey) ?? 0) >= limit) continue;
    try {
      await deps.requestTransition(item.id, "coding", "coder", "coding started");
    } catch {
      continue;
    }
    activeRepos.set(repoKey, (activeRepos.get(repoKey) ?? 0) + 1);
    void run(item.id, repoKey);
  }
}

async function run(itemId: string, repoKey: string): Promise<void> {
  if (!deps || inFlight.has(itemId)) {
    release(repoKey);
    return;
  }
  const controller = new AbortController();
  inFlight.set(itemId, controller);
  try {
    const item = deps.getItem(itemId);
    if (!item || item.state !== "coding") return;

    const stored = await deps.getPlan(item);
    if (!stored) {
      await fail(itemId, "needs-input", "no stored plan — replan required");
      return;
    }

    deps.emitEvent(itemId, { kind: "status", phase: "fetching" });
    let worktree: { path: string; branch: string };
    try {
      worktree = await deps.prepareWorktree(item);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await fail(itemId, "needs-input", `worktree setup failed: ${message.slice(0, 500)}`);
      return;
    }
    deps.emitEvent(itemId, { kind: "status", phase: "worktree", detail: worktree.path });

    const resume =
      item.worktree?.sessionId !== undefined && item.worktree.path === worktree.path
        ? item.worktree.sessionId
        : undefined;
    const sessionId = resume ?? randomUUID();
    // Persist before the long run — crash recovery resumes from this record.
    await deps.setWorktree(itemId, { ...worktree, sessionId });

    const cached = deps.getIssue(item);
    const issue = {
      number: item.number,
      title: item.title,
      url: item.url,
      labels: cached?.labels ?? [],
      body: cached?.body,
    };
    const settings = deps.getSettings();
    deps.emitEvent(itemId, { kind: "status", phase: resume ? "resuming" : "agent-start" });

    // Shepherd-driven PR fix round (#11) outranks reviewer objections (it is
    // the later stage); then reviewer-driven fix round (#10). Neither field is
    // cleared mid-run — pendingReviewComments clears on push (completePrOpen),
    // pendingObjections is replaced wholesale by the next completeReview — so a
    // crashed fix run re-delivers its fix prompt idempotently.
    const prComments = item.shepherd?.pendingReviewComments;
    const prFixMode = (prComments?.length ?? 0) > 0;
    const pending = item.review?.pendingObjections;
    const fixMode = !prFixMode && (pending?.length ?? 0) > 0;
    const freshPrompt = prFixMode
      ? buildPrFixPrompt(issue, prComments!)
      : fixMode
        ? buildFixPrompt(issue, pending!)
        : buildCoderPrompt(issue, stored.plan);
    const resumePrompt = prFixMode
      ? buildPrFixPrompt(issue, prComments!)
      : fixMode
        ? buildFixPrompt(issue, pending!)
        : buildResumePrompt(issue);

    const baseOptions = {
      systemPrompt: CODER_SYSTEM_PROMPT,
      cwd: worktree.path,
      model: settings.coderModel,
      maxTurns: settings.coderMaxTurns,
      onEvent: (event: CodingEvent) => deps?.emitEvent(itemId, event),
      signal: controller.signal,
    };

    let result;
    let sawEvent = false;
    const trackFirstEvent = (event: CodingEvent) => {
      sawEvent = true;
      baseOptions.onEvent(event);
    };
    try {
      result = await runner({
        ...baseOptions,
        onEvent: trackFirstEvent,
        ...(resume
          ? { resumeSessionId: resume, prompt: resumePrompt }
          : { sessionId, prompt: freshPrompt }),
      });
    } catch (err) {
      // A dead --resume (session gone from disk) fails fast without events:
      // retry once as a fresh session.
      if (!resume || sawEvent || err instanceof CodingAbortError) throw err;
      const freshId = randomUUID();
      await deps.setWorktree(itemId, { ...worktree, sessionId: freshId });
      result = await runner({
        ...baseOptions,
        sessionId: freshId,
        prompt: freshPrompt,
      });
    }

    // Cooperative cancel: the item may have been closed/moved mid-run.
    if (deps.getItem(itemId)?.state !== "coding") return;
    if (result.sessionId && result.sessionId !== sessionId) {
      await deps.setWorktree(itemId, { ...worktree, sessionId: result.sessionId });
    }
    if (result.ok) {
      await deps.requestTransition(
        itemId,
        "agent-review",
        "coder",
        result.summary.slice(0, 200) || "coding run completed",
      );
    } else {
      await fail(itemId, "failed", `coding run failed: ${(result.summary || "no result").slice(0, 500)}`);
    }
  } catch (err) {
    if (!(err instanceof CodingAbortError) && deps?.getItem(itemId)?.state === "coding") {
      const message = err instanceof Error ? err.message : String(err);
      await fail(itemId, "failed", `coding run failed: ${message.slice(0, 500)}`);
    }
  } finally {
    inFlight.delete(itemId);
    release(repoKey);
    pokeCoder();
  }
}

function release(repoKey: string): void {
  const count = activeRepos.get(repoKey) ?? 0;
  if (count <= 1) activeRepos.delete(repoKey);
  else activeRepos.set(repoKey, count - 1);
}

async function fail(itemId: string, to: LifecycleState, reason: string): Promise<void> {
  await deps
    ?.requestTransition(itemId, to, "coder", reason)
    .catch(() => {
      /* item moved concurrently — nothing to do */
    });
}
