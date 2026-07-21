import type {
  LifecycleState,
  PlanChatMessage,
  PlanRevisionSource,
  StoredPlan,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";

// Overview timeline (#169): a flat, chronological log built from the item's
// transitions, interleaved with synthetic plan-revision entries. Each role's
// latest run embeds its live console; superseded runs collapse to a placeholder
// or a round pointer.

const LIVE_STATES: readonly LifecycleState[] = ["planning", "coding", "agent-review"];

export type TimelineArtifact =
  | { kind: "planner-console"; latestRun: boolean; model?: string; confidencePct?: number }
  | {
      kind: "plan-revision";
      source: PlanRevisionSource;
      messageCount?: number;
      beforePct?: number;
      afterPct?: number;
    }
  | { kind: "coder-console"; latestRun: boolean }
  | { kind: "reviewer-console"; latestRun: boolean }
  | { kind: "review-round"; round: number; failed: boolean };

export interface TimelineEntry {
  /** Stable React key. */
  id: string;
  at: string;
  /** Absent for synthetic plan-revision entries. */
  state?: LifecycleState;
  actor?: TransitionActor;
  reason?: string;
  /** true only for the admission transition (from === null) — rendered as "Tracked". */
  tracked: boolean;
  /** next.at − at; last entry: now − at; clamped ≥ 0. */
  durationMs: number | null;
  /** ◉ only on the last entry. */
  current: boolean;
  /** Running-role console, expanded by default. */
  live: boolean;
  artifact?: TimelineArtifact;
}

interface Draft {
  at: string;
  order: number; // transition = 0, revision = 1 — ties keep the transition first
  state?: LifecycleState;
  actor?: TransitionActor;
  reason?: string;
  tracked: boolean;
  artifact?: TimelineArtifact;
}

export function buildTimeline(
  item: TrackedItem,
  storedPlan: StoredPlan | null,
  chatMessages: PlanChatMessage[],
  now: number,
): TimelineEntry[] {
  const transitions = item.transitions;
  const lastIndexTo = (to: LifecycleState): number => {
    for (let i = transitions.length - 1; i >= 0; i--) if (transitions[i].to === to) return i;
    return -1;
  };
  const lastPlanning = lastIndexTo("planning");
  const lastCoding = lastIndexTo("coding");
  const lastAgentReview = lastIndexTo("agent-review");

  const genConfidence = storedPlan?.revisions?.[0]?.confidence?.composite ?? storedPlan?.confidence?.composite;

  const drafts: Draft[] = [];
  let reviewRound = 0;
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    let artifact: TimelineArtifact | undefined;
    if (t.to === "planning") {
      const latestRun = i === lastPlanning;
      artifact = latestRun
        ? { kind: "planner-console", latestRun, model: storedPlan?.model, confidencePct: genConfidence }
        : { kind: "planner-console", latestRun };
    } else if (t.to === "coding") {
      artifact = { kind: "coder-console", latestRun: i === lastCoding };
    } else if (t.to === "agent-review") {
      reviewRound++;
      if (i === lastAgentReview) {
        artifact = { kind: "reviewer-console", latestRun: true };
      } else {
        artifact = {
          kind: "review-round",
          round: reviewRound,
          failed: transitions[i + 1]?.to === "coding",
        };
      }
    }
    drafts.push({
      at: t.at,
      order: 0,
      state: t.to,
      actor: t.actor,
      reason: t.reason,
      tracked: t.from === null,
      artifact,
    });
  }

  const revisions = storedPlan?.revisions ?? [];
  let consumedChat = 0;
  for (let j = 0; j < revisions.length; j++) {
    const rev = revisions[j];
    let messageCount: number | undefined;
    if (rev.source === "chat-apply") {
      const throughRevision = chatMessages.filter((m) => m.at <= rev.at).length;
      messageCount = Math.max(0, throughRevision - consumedChat);
      consumedChat = throughRevision;
    }
    const beforePct = rev.confidence?.composite;
    const afterPct = revisions[j + 1]?.confidence?.composite ?? storedPlan?.confidence?.composite;
    drafts.push({
      at: rev.at,
      order: 1,
      tracked: false,
      artifact: { kind: "plan-revision", source: rev.source, messageCount, beforePct, afterPct },
    });
  }

  drafts.sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? -1 : 1));

  return drafts.map((d, i) => {
    const nextAt = drafts[i + 1]?.at;
    const startMs = Date.parse(d.at);
    const endMs = nextAt ? Date.parse(nextAt) : now;
    const durationMs = Number.isNaN(startMs) ? null : Math.max(0, endMs - startMs);
    const last = i === drafts.length - 1;
    return {
      id: `${d.at}:${d.state ?? d.artifact?.kind ?? "e"}:${i}`,
      at: d.at,
      state: d.state,
      actor: d.actor,
      reason: d.reason,
      tracked: d.tracked,
      durationMs,
      current: last,
      live: last && d.state != null && LIVE_STATES.includes(d.state),
      artifact: d.artifact,
    };
  });
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const m = totalMinutes % 60;
    return m === 0 ? `${totalHours}h` : `${totalHours}h ${m}m`;
  }
  const days = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h === 0 ? `${days}d` : `${days}d ${h}h`;
}
