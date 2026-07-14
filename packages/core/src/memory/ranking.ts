// Retrieval ranking weights — the one tunable place (#44).
// Final score = cosine similarity × recency × feedback, applied post-search
// at query time so a 👍 never requires reindexing.

import type { SolutionRecord } from "@skipper/shared";

const HALF_LIFE_DAYS = 180;
const RECENCY_FLOOR = 0.3;

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
