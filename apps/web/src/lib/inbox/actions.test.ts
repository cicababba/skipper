import { describe, expect, it } from "vitest";
import type { LifecycleState, TrackedItem } from "@nestbrain/shared";
import { canTransition, TRANSITIONS } from "@nestbrain/shared";
import { actionsFor } from "./actions";

const ALL_STATES = Object.keys(TRANSITIONS) as LifecycleState[];

function item(overrides: Partial<TrackedItem>): TrackedItem {
  return {
    id: "github:1",
    platform: "github",
    accountId: "acc",
    repo: { owner: "octo", name: "repo" },
    number: 1,
    title: "t",
    url: "https://github.com/octo/repo/issues/1",
    state: "triage",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    transitions: [],
    ...overrides,
  };
}

describe("actionsFor", () => {
  it("every transition action is legal per the shared TRANSITIONS table", () => {
    for (const state of ALL_STATES) {
      for (const action of actionsFor(item({ state }))) {
        if (action.kind !== "transition") continue;
        expect(
          canTransition(state, action.to),
          `${state} → ${action.to} (${action.id})`,
        ).toBe(true);
      }
    }
  });

  it("openPr only offered in human-review", () => {
    for (const state of ALL_STATES) {
      const hasOpenPr = actionsFor(item({ state })).some((a) => a.kind === "openPr");
      expect(hasOpenPr, state).toBe(state === "human-review");
    }
  });

  it("plan-gate offers approve, replan, and park", () => {
    const actions = actionsFor(item({ state: "plan-gate" }));
    expect(actions.map((a) => a.id)).toEqual(["approve", "replan", "park"]);
    expect(actions[2]).toEqual({ id: "park", kind: "transition", to: "needs-input" });
  });

  it("resume honors resumeTo when legal", () => {
    const actions = actionsFor(item({ state: "needs-input", resumeTo: "coding" }));
    expect(actions[0]).toEqual({ id: "resume", kind: "transition", to: "coding" });
  });

  it("resume falls back to triage without resumeTo", () => {
    const actions = actionsFor(item({ state: "blocked" }));
    expect(actions[0]).toEqual({ id: "resume", kind: "transition", to: "triage" });
  });

  it("queued offers pin, unpin when already pinned (#15)", () => {
    expect(actionsFor(item({ state: "queued" }))[0]).toEqual({
      id: "pin",
      kind: "pin",
      pinned: true,
    });
    expect(actionsFor(item({ state: "queued", pinned: true }))[0]).toEqual({
      id: "unpin",
      kind: "pin",
      pinned: false,
    });
    for (const state of ALL_STATES.filter((s) => s !== "queued")) {
      expect(actionsFor(item({ state })).some((a) => a.kind === "pin"), state).toBe(false);
    }
  });

  it("settled and platform-owned states expose no actions", () => {
    for (const state of ["merged", "closed", "pr-open", "in-review", "changes-requested"]) {
      expect(actionsFor(item({ state: state as LifecycleState }))).toEqual([]);
    }
  });
});
