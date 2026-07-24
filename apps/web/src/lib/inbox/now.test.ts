import { describe, expect, it } from "vitest";
import type { LifecycleState, TrackedItem, TransitionEvent } from "@skipper/shared";
import { nowSentence, railPrimary } from "./now";

function item(state: LifecycleState, overrides: Partial<TrackedItem> = {}): TrackedItem {
  const transitions: TransitionEvent[] = overrides.transitions ?? [
    { at: "2026-07-01T00:00:00.000Z", from: null, to: state, actor: "system" },
  ];
  return {
    id: "github:1",
    state,
    transitions,
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
    // keep the derived state consistent even if overrides carried transitions
  } as TrackedItem;
}

const NOW = Date.parse("2026-07-01T00:05:00.000Z");

describe("nowSentence", () => {
  it("routes the human-gate states to waiting-you", () => {
    for (const s of ["triage", "plan-gate", "human-review"] as LifecycleState[]) {
      expect(nowSentence(item(s), NOW).kind).toBe("waiting-you");
    }
  });

  it("maps working states to their role and elapsed time", () => {
    expect(nowSentence(item("planning"), NOW)).toEqual({ kind: "role-working", role: "planner", sinceMs: 300_000 });
    expect(nowSentence(item("coding"), NOW)).toMatchObject({ role: "coder" });
    expect(nowSentence(item("agent-review"), NOW)).toMatchObject({ role: "reviewer" });
  });

  it("reports the pinned flag on queued", () => {
    expect(nowSentence(item("queued"), NOW)).toEqual({ kind: "queued", pinned: false });
    expect(nowSentence(item("queued", { pinned: true }), NOW)).toEqual({ kind: "queued", pinned: true });
  });

  it("carries the last transition reason into a parked sentence", () => {
    const parked = item("needs-input", {
      transitions: [
        { at: "2026-07-01T00:00:00.000Z", from: null, to: "triage", actor: "system" },
        { at: "2026-07-01T00:01:00.000Z", from: "planning", to: "needs-input", actor: "user", reason: "clarify scope" },
      ],
    });
    expect(nowSentence(parked, NOW)).toEqual({ kind: "parked", state: "needs-input", reason: "clarify scope" });
  });

  it("routes upstream and settled states", () => {
    expect(nowSentence(item("in-review"), NOW)).toEqual({ kind: "upstream", state: "in-review" });
    expect(nowSentence(item("merged"), NOW)).toEqual({ kind: "settled", state: "merged" });
  });
});

describe("railPrimary", () => {
  it("offers the openPr action at human-review", () => {
    const primary = railPrimary(item("human-review"));
    expect(primary).toEqual({ kind: "action", action: { id: "openPr", kind: "openPr" } });
  });

  it("carries the PR number when the item already has a PR (#225)", () => {
    const primary = railPrimary(
      item("human-review", {
        pr: { id: "PR_1", number: 42, url: "https://github.com/octo/repo/pull/42" },
      }),
    );
    expect(primary).toEqual({
      kind: "action",
      action: { id: "openPr", kind: "openPr", prNumber: 42 },
    });
  });

  it("offers a plan link at the gate", () => {
    expect(railPrimary(item("plan-gate"))).toEqual({ kind: "plan-link" });
  });

  it("resumes the parking phase's session", () => {
    const parked = item("needs-input", {
      resumeTo: "coding",
      worktree: { path: "/wt", branch: "feature/x", sessionId: "sess-code" },
      transitions: [
        { at: "2026-07-01T00:00:00.000Z", from: null, to: "triage", actor: "system" },
        { at: "2026-07-01T00:01:00.000Z", from: "coding", to: "needs-input", actor: "coder" },
      ],
    });
    expect(railPrimary(parked)).toEqual({ kind: "resume-session", sessionId: "sess-code" });
  });

  it("falls back to the leaving phase when resumeTo is absent", () => {
    const parked = item("blocked", {
      review: { rounds: 1, outcome: "concerns", at: "2026-07-01T00:01:00.000Z", sessionId: "sess-review" },
      transitions: [
        { at: "2026-07-01T00:00:00.000Z", from: null, to: "triage", actor: "system" },
        { at: "2026-07-01T00:01:00.000Z", from: "agent-review", to: "blocked", actor: "reviewer" },
      ],
    });
    expect(railPrimary(parked)).toEqual({ kind: "resume-session", sessionId: "sess-review" });
  });

  it("resume-session with no session still returns the kind (renderer falls back)", () => {
    const parked = item("failed", {
      transitions: [
        { at: "2026-07-01T00:00:00.000Z", from: null, to: "triage", actor: "system" },
        { at: "2026-07-01T00:01:00.000Z", from: "coding", to: "failed", actor: "coder" },
      ],
    });
    expect(railPrimary(parked)).toEqual({ kind: "resume-session", sessionId: undefined });
  });

  it("returns null for states with no rail primary", () => {
    for (const s of ["planning", "coding", "queued", "merged"] as LifecycleState[]) {
      expect(railPrimary(item(s)), s).toBeNull();
    }
  });
});
