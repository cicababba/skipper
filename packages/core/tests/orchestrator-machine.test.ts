import { describe, it, expect } from "vitest";
import type { Issue, LifecycleState } from "@skipper/shared";
import {
  TRANSITIONS,
  TERMINAL_STATES,
  canTransition,
  admitItem,
  applyTransition,
  IllegalTransitionError,
} from "../src/orchestrator";

const ALL_STATES: LifecycleState[] = [
  "triage",
  "planning",
  "plan-gate",
  "queued",
  "coding",
  "agent-review",
  "human-review",
  "pr-open",
  "in-review",
  "changes-requested",
  "merged",
  "needs-input",
  "blocked",
  "failed",
  "closed",
];

function issue(n: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: `github:${n}`,
    kind: "issue",
    platform: "github",
    accountId: "acct-1",
    repo: { owner: "o", name: "r" },
    number: n,
    title: `Issue ${n}`,
    labels: [],
    assignees: [],
    url: `https://github.com/o/r/issues/${n}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

describe("transition table", () => {
  it("covers every lifecycle state", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it("terminal states have no outgoing edges", () => {
    for (const state of TERMINAL_STATES) {
      expect(TRANSITIONS[state]).toEqual([]);
    }
  });

  it("every target is a known state and never a self-loop", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL_STATES).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });

  it("every state is reachable from triage", () => {
    const seen = new Set<LifecycleState>(["triage"]);
    const queue: LifecycleState[] = ["triage"];
    while (queue.length > 0) {
      for (const next of TRANSITIONS[queue.shift()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ALL_STATES].sort());
  });

  it("canTransition matches the table", () => {
    expect(canTransition("triage", "planning")).toBe(true);
    expect(canTransition("triage", "coding")).toBe(false);
    expect(canTransition("merged", "closed")).toBe(false);
    expect(canTransition("closed", "triage")).toBe(true);
  });
});

describe("admitItem", () => {
  it("creates a triage record with an admission event", () => {
    const now = new Date("2026-07-11T10:00:00.000Z");
    const item = admitItem(issue(1), now);
    expect(item.state).toBe("triage");
    expect(item.createdAt).toBe(now.toISOString());
    expect(item.transitions).toEqual([
      {
        at: now.toISOString(),
        from: null,
        to: "triage",
        actor: "reconcile",
        reason: "admitted",
      },
    ]);
  });
});

describe("applyTransition", () => {
  it("appends to the transition log and returns a new object", () => {
    const item = admitItem(issue(1));
    const next = applyTransition(item, "planning", "planner", "eager plan");
    expect(next.state).toBe("planning");
    expect(next.transitions).toHaveLength(2);
    expect(next.transitions[1]).toMatchObject({
      from: "triage",
      to: "planning",
      actor: "planner",
      reason: "eager plan",
    });
    // original untouched
    expect(item.state).toBe("triage");
    expect(item.transitions).toHaveLength(1);
  });

  it("records resumeTo when parking on needs-input", () => {
    const item = applyTransition(admitItem(issue(1)), "planning", "planner");
    const parked = applyTransition(item, "needs-input", "planner", "plan generation failed", {
      resumeTo: "planning",
    });
    expect(parked.resumeTo).toBe("planning");
  });

  it("clears resumeTo on any non-parked transition", () => {
    const item = applyTransition(admitItem(issue(1)), "planning", "planner");
    const parked = applyTransition(item, "needs-input", "planner", "failed", {
      resumeTo: "planning",
    });
    const resumed = applyTransition(parked, "planning", "user", "resume");
    expect(resumed.resumeTo).toBeUndefined();
  });

  it("ignores resumeTo on non-parked targets", () => {
    const item = admitItem(issue(1));
    const next = applyTransition(item, "planning", "planner", "eager plan", {
      resumeTo: "queued",
    });
    expect(next.resumeTo).toBeUndefined();
  });

  it("throws IllegalTransitionError on a bad edge", () => {
    const item = admitItem(issue(1));
    let caught: unknown;
    try {
      applyTransition(item, "merged", "user");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    const err = caught as IllegalTransitionError;
    expect(err.itemId).toBe("github:1");
    expect(err.from).toBe("triage");
    expect(err.to).toBe("merged");
  });
});
