import type { RepoPriority } from "@nestbrain/shared";

export interface QueueCandidate {
  pinned: boolean;
  priority: RepoPriority;
  /** Absent = unscored plan → sorts below all scored candidates. */
  confidence?: number;
  queuedAt: string; // ISO 8601
}

const PRIORITY_RANK: Record<RepoPriority, number> = { high: 0, normal: 1, low: 2 };

/** #15 queue ordering: pin > repo priority > confidence desc > age (older first). */
export function compareQueueCandidates(a: QueueCandidate, b: QueueCandidate): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) return priority;
  const confidenceA = a.confidence ?? -1;
  const confidenceB = b.confidence ?? -1;
  if (confidenceA !== confidenceB) return confidenceB - confidenceA;
  return a.queuedAt.localeCompare(b.queuedAt);
}
