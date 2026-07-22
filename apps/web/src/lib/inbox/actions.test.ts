import { describe, expect, it } from "vitest";
import type { LifecycleState, TrackedItem } from "@skipper/shared";
import { canTransition, TRANSITIONS } from "@skipper/shared";
import { actionsFor, PRIMARY_ACTION_IDS, splitActions, type ItemAction } from "./actions";

const ALL_STATES = Object.keys(TRANSITIONS) as LifecycleState[];

function item(overrides: Partial<TrackedItem>): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "octo/repo", key: "1" },
    codeHost: "github",
    key: "1",
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

  it("untrack is appended in every state, including the otherwise-empty ones (#120)", () => {
    for (const state of ALL_STATES) {
      const actions = actionsFor(item({ state }));
      expect(actions.at(-1), state).toEqual({ id: "untrack", kind: "untrack" });
      expect(actions.filter((a) => a.kind === "untrack").length, state).toBe(1);
    }
  });

  it("plan-gate offers approve, replan, and park", () => {
    const actions = actionsFor(item({ state: "plan-gate" }));
    expect(actions.map((a) => a.id)).toEqual(["approve", "replan", "park", "untrack"]);
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

  it("settled and platform-owned states expose only untrack (#120)", () => {
    for (const state of ["merged", "closed", "pr-open", "in-review", "changes-requested"]) {
      expect(actionsFor(item({ state: state as LifecycleState }))).toEqual([
        { id: "untrack", kind: "untrack" },
      ]);
    }
  });

  it("offers archive on a closed item with a worktree (#115)", () => {
    const actions = actionsFor(
      item({ state: "closed", worktree: { path: "/wt", branch: "feature/x" } }),
    );
    expect(actions).toEqual([
      { id: "archive", kind: "archive" },
      { id: "untrack", kind: "untrack" },
    ]);
  });

  it("offers archive on a closed item with an active plan ref (#115)", () => {
    const actions = actionsFor(item({ state: "closed", plan: { ref: "github_1.json" } }));
    expect(actions).toEqual([
      { id: "archive", kind: "archive" },
      { id: "untrack", kind: "untrack" },
    ]);
  });

  it("hides archive once the worktree is gone and the plan archived (#115)", () => {
    expect(actionsFor(item({ state: "closed", plan: { ref: "archive/github_1.json" } }))).toEqual([
      { id: "untrack", kind: "untrack" },
    ]);
    expect(actionsFor(item({ state: "closed" }))).toEqual([{ id: "untrack", kind: "untrack" }]);
  });

  it("never offers archive on a merged item (#115)", () => {
    expect(
      actionsFor(item({ state: "merged", worktree: { path: "/wt", branch: "feature/x" } })),
    ).toEqual([{ id: "untrack", kind: "untrack" }]);
  });
});

describe("splitActions", () => {
  const split = (overrides: Partial<TrackedItem>) => splitActions(actionsFor(item(overrides)));
  const ids = (actions: ItemAction[]) => actions.map((a) => a.id);

  it("puts plan inline on triage, the rest in the menu (#133)", () => {
    const { primary, menu, destructive } = split({ state: "triage" });
    expect(primary?.id).toBe("plan");
    expect(ids(menu)).toEqual([]);
    expect(ids(destructive)).toEqual(["close", "untrack"]);
  });

  it("puts approve inline on plan-gate, replan and park in the menu", () => {
    const { primary, menu, destructive } = split({ state: "plan-gate" });
    expect(primary?.id).toBe("approve");
    expect(ids(menu)).toEqual(["replan", "park"]);
    // plan-gate has no legal close transition.
    expect(ids(destructive)).toEqual(["untrack"]);
  });

  it("puts resume inline on needs-input and blocked", () => {
    for (const state of ["needs-input", "blocked"] as LifecycleState[]) {
      const { primary, destructive } = split({ state });
      expect(primary?.id, state).toBe("resume");
      expect(ids(destructive), state).toEqual(["close", "untrack"]);
    }
  });

  it("puts retry inline on failed", () => {
    expect(split({ state: "failed" }).primary?.id).toBe("retry");
  });

  it("keeps unpin out of the inline slot on a pinned queued item (#133)", () => {
    const { primary, menu, destructive } = split({ state: "queued", pinned: true });
    expect(primary).toBeNull();
    expect(ids(menu)).toEqual(["unpin"]);
    expect(ids(destructive)).toEqual(["close", "untrack"]);
  });

  it("keeps archive out of the inline slot on a closed item (#133)", () => {
    const { primary, menu, destructive } = split({
      state: "closed",
      worktree: { path: "/wt", branch: "feature/x" },
    });
    expect(primary).toBeNull();
    expect(ids(menu)).toEqual(["archive"]);
    expect(ids(destructive)).toEqual(["untrack"]);
  });

  it("leaves an already-archived closed item with untrack only", () => {
    const { primary, menu, destructive } = split({ state: "closed" });
    expect(primary).toBeNull();
    expect(ids(menu)).toEqual([]);
    expect(ids(destructive)).toEqual(["untrack"]);
  });

  it("keeps openPr in the menu on human-review", () => {
    const { primary, menu, destructive } = split({ state: "human-review" });
    expect(primary).toBeNull();
    expect(ids(menu)).toEqual(["openPr"]);
    expect(ids(destructive)).toEqual(["close", "untrack"]);
  });

  it("renders kebab-only for in-flight states", () => {
    for (const state of ["planning", "coding", "agent-review"] as LifecycleState[]) {
      const { primary, menu, destructive } = split({ state });
      expect(primary, state).toBeNull();
      expect(ids(menu), state).toEqual([]);
      expect(ids(destructive), state).toEqual(["close", "untrack"]);
    }
  });

  it("renders kebab-only for platform-owned and settled states", () => {
    for (const state of [
      "pr-open",
      "in-review",
      "changes-requested",
      "merged",
    ] as LifecycleState[]) {
      const { primary, menu, destructive } = split({ state });
      expect(primary, state).toBeNull();
      expect(ids(menu), state).toEqual([]);
      expect(ids(destructive), state).toEqual(["untrack"]);
    }
  });

  it("partitions every action exactly once, preserving actionsFor order", () => {
    for (const state of ALL_STATES) {
      const actions = actionsFor(item({ state }));
      const { primary, menu, destructive } = splitActions(actions);
      const recombined = [...(primary ? [primary] : []), ...menu, ...destructive];
      // No drops, no duplicates.
      expect(recombined.length, state).toBe(actions.length);
      for (const action of actions) expect(recombined, state).toContain(action);
      // Each bucket is a subsequence of the input: the helper never reorders.
      for (const bucket of [menu, destructive]) {
        const indices = bucket.map((a) => actions.indexOf(a));
        expect(indices, state).toEqual([...indices].sort((x, y) => x - y));
      }
    }
  });

  it("only ever promotes an allow-listed action to the inline slot", () => {
    for (const state of ALL_STATES) {
      const { primary } = splitActions(actionsFor(item({ state })));
      if (primary) expect(PRIMARY_ACTION_IDS, state).toContain(primary.id);
    }
  });
});
