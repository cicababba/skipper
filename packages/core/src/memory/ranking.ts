// Retrieval ranking weights — the one tunable place (#44).
// Final score = cosine similarity × recency × feedback × staleness, applied
// post-search at query time so a 👍 never requires reindexing.

import type { SolutionRecord } from "@skipper/shared";

const HALF_LIFE_DAYS = 180;
const RECENCY_FLOOR = 0.3;
const STALENESS_PENALTY = 0.5;

/** Half-life decay with a floor so old solutions never vanish entirely. */
export function recencyWeight(capturedAt: string, now: number = Date.now()): number {
  const captured = Date.parse(capturedAt);
  if (Number.isNaN(captured)) return RECENCY_FLOOR;
  const ageDays = Math.max(0, (now - captured) / 86_400_000);
  return Math.max(RECENCY_FLOOR, 0.5 ** (ageDays / HALF_LIFE_DAYS));
}

/** Laplace-smoothed: no feedback → 1, all-👍 → 2, all-👎 → 0. */
export function feedbackWeight(feedback: SolutionRecord["feedback"]): number {
  if (!feedback) return 1;
  const { up, down } = feedback;
  return (2 * (up + 1)) / (up + down + 2);
}

/**
 * Files gone at the base ref weigh a memory down without burying it (#256): a
 * fully-stale record still scores half, because the reasoning can outlive the
 * code it was written against. Never measured (undefined) = no penalty.
 */
export function stalenessWeight(staleness: number | undefined): number {
  if (staleness == null) return 1;
  return 1 - STALENESS_PENALTY * Math.min(1, Math.max(0, staleness));
}

/**
 * Move the aggregate 👍/👎 counters by the delta between a user's old and new
 * vote (#46). Three-state: null clears. Idempotent — same vote is a no-op — and
 * never drops a counter below zero.
 */
export function applyFeedbackVote(
  feedback: SolutionRecord["feedback"],
  oldVote: "up" | "down" | undefined,
  newVote: "up" | "down" | null,
): { up: number; down: number } {
  const next = { up: feedback?.up ?? 0, down: feedback?.down ?? 0 };
  if (oldVote === (newVote ?? undefined)) return next;
  if (oldVote === "up") next.up = Math.max(0, next.up - 1);
  if (oldVote === "down") next.down = Math.max(0, next.down - 1);
  if (newVote === "up") next.up += 1;
  if (newVote === "down") next.down += 1;
  return next;
}
