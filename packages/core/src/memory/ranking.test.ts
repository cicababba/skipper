import { describe, expect, it } from "vitest";
import { applyFeedbackVote, feedbackWeight } from "./ranking";

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
