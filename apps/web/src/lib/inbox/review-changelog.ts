import {
  toReviewRound,
  type AgentReview,
  type AgentReviewOutcome,
  type CriticObjection,
  type CriticVerdict,
  type ReviewRound,
} from "@skipper/shared";

// Groups an item's review history into a per-verdict changelog (#205): each entry
// splits its objections into resolved / still-open (persisting) / new. Skipped and
// unavailable rounds stay in stored history but are hidden here (user decision); the
// ordinal counts verdict records only, so it survives a re-entry round reset.

export interface ReviewChangelogEntry {
  /** 1-based among verdict records — survives re-entries. */
  ordinal: number;
  /** Chain-local round at snapshot time. */
  round: number;
  outcome: CriticVerdict;
  at: string;
  reason?: string;
  resolved: CriticObjection[];
  persisting: CriticObjection[];
  added: CriticObjection[];
}

function isVerdict(outcome: AgentReviewOutcome): outcome is CriticVerdict {
  return outcome === "approve" || outcome === "concerns" || outcome === "reject";
}

function verdictRecords(review: AgentReview): ReviewRound[] {
  const records: ReviewRound[] = [...(review.history ?? []), toReviewRound(review)];
  return records.filter((r) => isVerdict(r.outcome));
}

export function buildReviewChangelog(review: AgentReview): ReviewChangelogEntry[] {
  return verdictRecords(review).map((r, i) => {
    const objections = r.objections ?? [];
    return {
      ordinal: i + 1,
      round: r.round,
      outcome: r.outcome as CriticVerdict,
      at: r.at,
      ...(r.reason ? { reason: r.reason } : {}),
      resolved: r.resolvedObjections ?? [],
      persisting: objections.filter((o) => o.status === "persisting"),
      added: objections.filter((o) => o.status !== "persisting"),
    };
  });
}

export function hasReviewChangelog(review: AgentReview): boolean {
  const verdicts = verdictRecords(review);
  if (verdicts.length > 1) return true;
  return verdicts.some(
    (r) => (r.resolvedObjections?.length ?? 0) > 0 || (r.objections?.some((o) => o.status) ?? false),
  );
}
