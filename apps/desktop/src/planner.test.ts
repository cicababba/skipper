import { describe, it, expect } from "vitest";
import type {
  Issue,
  LifecycleState,
  RepoIntakeSettings,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import { resolveRepoOrchestratorSettings } from "@skipper/shared";
import type { OrchestratorSettings } from "@skipper/core";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/core";
import { initPlanner, pokePlanner, type PlannerDeps } from "./planner";

// The planner's scan() gate (#62). run() itself needs a real LLM, so these cover
// the admission decision only — which is where the master switch lives.

function makeItem(state: LifecycleState): TrackedItem {
  return {
    id: "github:1",
    platform: "github",
    accountId: "acct",
    repo: { owner: "owner", name: "repo" },
    number: 1,
    title: "issue 1",
    url: "https://github.com/owner/repo/issues/1",
    state,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    transitions: [],
  };
}

interface Harness {
  deps: PlannerDeps;
  transitions: { itemId: string; to: LifecycleState; actor: TransitionActor }[];
}

function makeHarness(
  items: TrackedItem[],
  settings: Partial<OrchestratorSettings> = {},
  repoSettings: RepoIntakeSettings = {},
): Harness {
  const transitions: Harness["transitions"] = [];
  const getSettings = () =>
    ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, ...settings }) as OrchestratorSettings;
  const deps: PlannerDeps = {
    listItems: () => items,
    getItem: (id: string) => items.find((i) => i.id === id),
    getIssue: () => ({ labels: [] }) as unknown as Issue,
    getRepoPath: () => "/repo",
    getRepoSettings: () => resolveRepoOrchestratorSettings(repoSettings, getSettings()),
    requestTransition: async (itemId: string, to: LifecycleState, actor: TransitionActor) => {
      transitions.push({ itemId, to, actor });
      // Never resolves into a real plan run: the item is gone by the time pump() looks.
      throw new Error("stop here");
    },
    completePlan: async () => {},
    getSettings,
    emitEvent: () => {},
  } as unknown as PlannerDeps;
  return { deps, transitions };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe("planner auto-plan master switch (#62)", () => {
  it("auto-plans a triage item when the switch is off", async () => {
    const h = makeHarness([makeItem("triage")], { autoPlanPaused: false });
    initPlanner(h.deps, {} as never);
    pokePlanner();
    await settle();
    expect(h.transitions).toEqual([{ itemId: "github:1", to: "planning", actor: "planner" }]);
  });

  it("does not auto-plan while paused", async () => {
    const h = makeHarness([makeItem("triage")], { autoPlanPaused: true });
    initPlanner(h.deps, {} as never);
    pokePlanner();
    await settle();
    expect(h.transitions).toEqual([]);
  });

  // The master switch outranks an explicit per-repo "on" — that is the whole point
  // of a switch rather than a default.
  it("beats a repo's explicit autoPlan on", async () => {
    const h = makeHarness([makeItem("triage")], { autoPlanPaused: true }, { autoPlan: "on" });
    initPlanner(h.deps, {} as never);
    pokePlanner();
    await settle();
    expect(h.transitions).toEqual([]);
  });

  // The guard sits in the triage branch only. Gating all of scan() would strand
  // every item that crashed mid-planning and silently kill the manual plan button.
  // A "planning" item is already past admission, so the switch must not touch it:
  // here it reaches run() and fails on the stub provider, which is proof enough
  // that it was picked up rather than skipped.
  it("still picks up an already-planning item while paused", async () => {
    const h = makeHarness([makeItem("planning")], { autoPlanPaused: true });
    initPlanner(h.deps, {} as never);
    pokePlanner();
    await settle();
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0]).toMatchObject({ itemId: "github:1", actor: "planner" });
  });
});
