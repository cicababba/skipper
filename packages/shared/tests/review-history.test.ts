import { describe, it, expect } from "vitest";
import {
  appendReviewHistory,
  toReviewRound,
  type AgentReview,
  type CriticObjection,
} from "../src/orchestrator";

const objection = (detail: string, blocking = false): CriticObjection => ({
  kind: "risk",
  detail,
  blocking,
});

const round1: AgentReview = {
  rounds: 1,
  outcome: "reject",
  reason: "blocked",
  objections: [objection("first", true)],
  pendingObjections: [objection("first", true)],
  sessionId: "sess-1",
  at: "2026-07-13T01:00:00.000Z",
};

describe("toReviewRound", () => {
  it("strips pendingObjections, sessionId and history", () => {
    const snapshot = toReviewRound({
      ...round1,
      resolvedObjections: [objection("fixed")],
      history: [{ round: 0, outcome: "unavailable", at: "2026-07-13T00:00:00.000Z" }],
    });
    expect(snapshot).toEqual({
      round: 1,
      outcome: "reject",
      reason: "blocked",
      objections: [objection("first", true)],
      resolvedObjections: [objection("fixed")],
      at: "2026-07-13T01:00:00.000Z",
    });
    expect("pendingObjections" in snapshot).toBe(false);
    expect("sessionId" in snapshot).toBe(false);
    expect("history" in snapshot).toBe(false);
  });
});

describe("appendReviewHistory", () => {
  it("passes the next review through untouched when there is no prior", () => {
    const next: AgentReview = { rounds: 1, outcome: "approve", at: "2026-07-13T02:00:00.000Z" };
    expect(appendReviewHistory(undefined, next)).toEqual(next);
    expect(appendReviewHistory(undefined, next).history).toBeUndefined();
  });

  it("snapshots the prior record onto history (oldest first)", () => {
    const next: AgentReview = { rounds: 2, outcome: "approve", at: "2026-07-13T02:00:00.000Z" };
    const merged = appendReviewHistory(round1, next);
    expect(merged.rounds).toBe(2);
    expect(merged.outcome).toBe("approve");
    expect(merged.history).toEqual([toReviewRound(round1)]);
    // The snapshot never carries the transient fields.
    expect(merged.history![0]).not.toHaveProperty("pendingObjections");
    expect(merged.history![0]).not.toHaveProperty("sessionId");
  });

  it("stacks two completions oldest-first without nesting history", () => {
    const round2: AgentReview = {
      rounds: 2,
      outcome: "concerns",
      objections: [objection("second")],
      at: "2026-07-13T02:00:00.000Z",
    };
    const afterFirst = appendReviewHistory(round1, round2);
    const round3: AgentReview = { rounds: 3, outcome: "approve", at: "2026-07-13T03:00:00.000Z" };
    const afterSecond = appendReviewHistory(afterFirst, round3);
    expect(afterSecond.history?.map((r) => r.round)).toEqual([1, 2]);
    expect(afterSecond.history?.map((r) => r.outcome)).toEqual(["reject", "concerns"]);
    // History entries are flat snapshots — no history-of-history.
    expect(afterSecond.history!.every((r) => !("history" in r))).toBe(true);
  });
});
