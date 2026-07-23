import { describe, expect, it } from "vitest";
import type { AgentReview, CriticObjection, ReviewRound } from "@skipper/shared";
import { buildReviewChangelog, hasReviewChangelog } from "./review-changelog";

const obj = (detail: string, status?: "new" | "persisting", blocking = false): CriticObjection => ({
  kind: "risk",
  detail,
  blocking,
  ...(status ? { status } : {}),
});

function review(over: Partial<AgentReview> = {}): AgentReview {
  return { rounds: 1, outcome: "approve", at: "2026-07-13T02:00:00.000Z", ...over };
}

describe("hasReviewChangelog", () => {
  it("is false for a single legacy verdict with no classification", () => {
    expect(hasReviewChangelog(review({ outcome: "approve", objections: [obj("x")] }))).toBe(false);
  });

  it("is true when more than one verdict record exists", () => {
    const history: ReviewRound[] = [{ round: 1, outcome: "reject", at: "t1" }];
    expect(hasReviewChangelog(review({ rounds: 2, outcome: "approve", history }))).toBe(true);
  });

  it("is true for a lone record that carries status or resolvedObjections", () => {
    expect(
      hasReviewChangelog(review({ outcome: "reject", objections: [obj("x", "persisting", true)] })),
    ).toBe(true);
    expect(
      hasReviewChangelog(review({ outcome: "approve", resolvedObjections: [obj("fixed")] })),
    ).toBe(true);
  });
});

describe("buildReviewChangelog", () => {
  it("splits objections into resolved / persisting / added, treating missing status as added", () => {
    const r = review({
      outcome: "reject",
      objections: [obj("still here", "persisting", true), obj("brand new", "new"), obj("no status")],
      resolvedObjections: [obj("was fixed")],
    });
    const entries = buildReviewChangelog(r);
    expect(entries).toHaveLength(1);
    expect(entries[0].resolved.map((o) => o.detail)).toEqual(["was fixed"]);
    expect(entries[0].persisting.map((o) => o.detail)).toEqual(["still here"]);
    expect(entries[0].added.map((o) => o.detail)).toEqual(["brand new", "no status"]);
  });

  it("hides skipped/unavailable records and numbers ordinals over verdict records only", () => {
    const history: ReviewRound[] = [
      { round: 0, outcome: "unavailable", at: "t0" },
      { round: 1, outcome: "reject", at: "t1", objections: [obj("r1", "new")] },
      { round: 0, outcome: "skipped", at: "t1b" },
      { round: 1, outcome: "reject", at: "t2", objections: [obj("r2", "persisting", true)] },
    ];
    const r = review({ rounds: 2, outcome: "approve", history });
    const entries = buildReviewChangelog(r);
    // 2 hidden non-verdict records dropped; ordinals stay contiguous across the reset.
    expect(entries.map((e) => e.ordinal)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.outcome)).toEqual(["reject", "reject", "approve"]);
    expect(entries[1].round).toBe(1); // chain-local round reset survives on the record
  });
});
