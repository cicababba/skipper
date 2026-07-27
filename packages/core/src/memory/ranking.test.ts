import { describe, expect, it } from "vitest";
import { applyFeedbackVote, feedbackWeight, stalenessWeight } from "./ranking";

describe("applyFeedbackVote (#46)", () => {
  it("adds a fresh vote from no feedback", () => {
    expect(applyFeedbackVote(undefined, undefined, "up")).toEqual({ up: 1, down: 0 });
    expect(applyFeedbackVote(undefined, undefined, "down")).toEqual({ up: 0, down: 1 });
  });

  it("clears a vote when toggled off", () => {
    expect(applyFeedbackVote({ up: 1, down: 0 }, "up", null)).toEqual({ up: 0, down: 0 });
  });

  it("flips up → down as a single net move", () => {
    expect(applyFeedbackVote({ up: 3, down: 1 }, "up", "down")).toEqual({ up: 2, down: 2 });
  });

  it("is a no-op when the vote is unchanged", () => {
    expect(applyFeedbackVote({ up: 2, down: 0 }, "up", "up")).toEqual({ up: 2, down: 0 });
  });

  it("never drops a counter below zero", () => {
    expect(applyFeedbackVote({ up: 0, down: 0 }, "up", null)).toEqual({ up: 0, down: 0 });
  });

  it("keeps the resulting counters consistent with feedbackWeight", () => {
    const after = applyFeedbackVote({ up: 0, down: 0 }, undefined, "up");
    expect(feedbackWeight(after)).toBeGreaterThan(1);
  });
});

describe("stalenessWeight (#256)", () => {
  it.each([
    [undefined, 1],
    [0, 1],
    [0.25, 0.875],
    [0.5, 0.75],
    [1, 0.5],
  ] as const)("weighs staleness %p as %p", (staleness, expected) => {
    expect(stalenessWeight(staleness)).toBeCloseTo(expected, 10);
  });

  // A fully-stale record keeps half its score: the reasoning outlives the code,
  // so staleness weighs a memory down and never buries it (RECENCY_FLOOR's logic).
  it("never falls below half, however stale", () => {
    expect(stalenessWeight(1)).toBe(0.5);
    expect(stalenessWeight(5)).toBe(0.5);
  });

  it("clamps a negative fraction back to no penalty", () => {
    expect(stalenessWeight(-1)).toBe(1);
  });

  it("treats a never-measured record exactly like a pristine one", () => {
    expect(stalenessWeight(undefined)).toBe(stalenessWeight(0));
  });
});
