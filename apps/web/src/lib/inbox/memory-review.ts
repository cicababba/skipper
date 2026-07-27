// Memory review queue (#256): which records are worth a human's attention as
// prune candidates. Pure predicate — every destructive decision stays manual, so
// this only ever proposes. Thresholds are hardcoded on purpose: a knob per
// signal would be four settings nobody can calibrate.

import type { SolutionRecord } from "@skipper/shared";

const DAY_MS = 86_400_000;
/** Below this many votes, a negative balance is one bad day, not a verdict. */
const MIN_FEEDBACK_VOLUME = 3;
/** More than half the record's files gone at the base ref. */
const STALE_THRESHOLD = 0.5;
const UNUSED_MS = 180 * DAY_MS;
/** The repo has to be retrieving memories at all for "unused" to mean anything. */
const ACTIVE_RETRIEVAL_MS = 30 * DAY_MS;
/** "Keep" hides a record from the queue for this long. */
const REVIEW_DISMISS_MS = 90 * DAY_MS;

export type PruneReason = "negative-feedback" | "unused" | "stale";

export interface PruneCandidate {
  record: SolutionRecord;
  reasons: PruneReason[];
}

export function isStale(record: SolutionRecord): boolean {
  return record.staleness !== undefined && record.staleness > STALE_THRESHOLD;
}

function parse(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? undefined : at;
}

function dismissed(record: SolutionRecord, now: number): boolean {
  const at = parse(record.reviewDismissedAt);
  return at !== undefined && now - at < REVIEW_DISMISS_MS;
}

function negativeFeedback(record: SolutionRecord): boolean {
  const up = record.feedback?.up ?? 0;
  const down = record.feedback?.down ?? 0;
  return down > up && up + down >= MIN_FEEDBACK_VOLUME;
}

/**
 * Prune candidates for one repo's records, with the reasons that flagged them.
 *
 * The "unused" rule is rollout-safe by construction: usage tracking started at
 * some point, and nothing on disk says when. The earliest offer stamp across the
 * repo stands in for that moment, so a record with no offer of its own is only
 * old-and-unused once the tracking itself is six months old — on day one nothing
 * flags. Capture time counts too, so a record younger than six months never
 * flags however old the baseline is. A repo that hasn't offered a memory in a
 * month isn't retrieving at all, and silence there says nothing about any
 * single record.
 */
export function pruneCandidates(records: SolutionRecord[], now: number): PruneCandidate[] {
  const offers = records
    .map((r) => parse(r.lastOfferedAt))
    .filter((at): at is number => at !== undefined);
  const activeRetrieval =
    offers.length > 0 && now - Math.max(...offers) < ACTIVE_RETRIEVAL_MS;
  const baseline = offers.length > 0 ? Math.min(...offers) : undefined;

  const candidates: PruneCandidate[] = [];
  for (const record of records) {
    if (dismissed(record, now)) continue;
    const reasons: PruneReason[] = [];
    if (negativeFeedback(record)) reasons.push("negative-feedback");
    if (activeRetrieval && baseline !== undefined) {
      const lastSeen = Math.max(
        parse(record.lastOfferedAt) ?? baseline,
        parse(record.capturedAt) ?? 0,
      );
      if (now - lastSeen > UNUSED_MS) reasons.push("unused");
    }
    if (isStale(record)) reasons.push("stale");
    if (reasons.length > 0) candidates.push({ record, reasons });
  }
  return candidates;
}
