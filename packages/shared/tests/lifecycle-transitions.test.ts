import { describe, it, expect } from "vitest";
import {
  canTransition,
  TRANSITIONS,
  latestPlanningTransitionAt,
  latestCodingTransitionAt,
} from "../src/orchestrator";
import type { LifecycleState, TrackedItem, TransitionEvent } from "../src/orchestrator";

function tx(to: LifecycleState, at: string, from: LifecycleState = "triage"): TransitionEvent {
  return { at, from, to, actor: "user" };
}

function item(transitions: TransitionEvent[]): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "o/r", key: "1" },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "o", name: "r" },
    key: "1",
    number: 1,
    title: "t",
    url: "u",
    state: transitions.at(-1)?.to ?? "triage",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    transitions,
  };
}

describe("canTransition edges", () => {
  it("merged is terminal", () => {
    expect(TRANSITIONS.merged).toEqual([]);
    expect(canTransition("merged", "closed")).toBe(false);
  });

  it("needs-input can return to any active state", () => {
    expect(canTransition("needs-input", "planning")).toBe(true);
    expect(canTransition("needs-input", "coding")).toBe(true);
    expect(canTransition("needs-input", "pr-open")).toBe(true);
    expect(canTransition("needs-input", "merged")).toBe(false);
  });

  it("changes-requested loops back to coding but not straight to merged", () => {
    expect(canTransition("changes-requested", "coding")).toBe(true);
    expect(canTransition("changes-requested", "merged")).toBe(false);
  });
});

describe("latestPlanningTransitionAt", () => {
  it("returns the most recent entry into planning", () => {
    const it0 = item([
      tx("planning", "2026-07-01T01:00:00.000Z"),
      tx("needs-input", "2026-07-01T02:00:00.000Z", "planning"),
      tx("planning", "2026-07-01T03:00:00.000Z", "needs-input"),
    ]);
    expect(latestPlanningTransitionAt(it0)).toBe("2026-07-01T03:00:00.000Z");
  });

  it("is undefined when the item never entered planning", () => {
    expect(latestPlanningTransitionAt(item([tx("closed", "2026-07-01T01:00:00.000Z")]))).toBeUndefined();
    expect(latestPlanningTransitionAt(item([]))).toBeUndefined();
  });
});

describe("latestCodingTransitionAt", () => {
  it("returns the most recent entry into coding", () => {
    const it0 = item([
      tx("coding", "2026-07-01T01:00:00.000Z", "queued"),
      tx("agent-review", "2026-07-01T02:00:00.000Z", "coding"),
      tx("coding", "2026-07-01T03:00:00.000Z", "changes-requested"),
    ]);
    expect(latestCodingTransitionAt(it0)).toBe("2026-07-01T03:00:00.000Z");
  });

  it("is undefined when the item never entered coding", () => {
    expect(latestCodingTransitionAt(item([tx("planning", "2026-07-01T01:00:00.000Z")]))).toBeUndefined();
    expect(latestCodingTransitionAt(item([]))).toBeUndefined();
  });
});
