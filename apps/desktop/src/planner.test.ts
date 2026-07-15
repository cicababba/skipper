import { describe, it, expect, vi } from "vitest";
import type {
  CodingEvent,
  Issue,
  LifecycleState,
  LlmSettings,
  RepoIntakeSettings,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import {
  AGENTIC_PROVIDERS,
  DEFAULT_LLM_SETTINGS,
  resolveRepoOrchestratorSettings,
} from "@skipper/shared";
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
    getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS }),
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

// #59: the planner now builds its provider from settings.json instead of pinning
// claude-cli. These run the REAL generatePlan against a real provider — OpenAI has
// no agent(), so it throws before any network call.
describe("planner provider selection (#59)", () => {
  interface ProviderHarness {
    deps: PlannerDeps;
    transitions: { to: LifecycleState; reason?: string }[];
    events: CodingEvent[];
  }

  function makeProviderHarness(llm: Partial<LlmSettings>): ProviderHarness {
    const items = [makeItem("planning")];
    const transitions: ProviderHarness["transitions"] = [];
    const events: CodingEvent[] = [];
    const deps: PlannerDeps = {
      listItems: () => items,
      getItem: (id: string) => items.find((i) => i.id === id),
      getIssue: () => ({ labels: [] }) as unknown as Issue,
      getRepoPath: () => "/repo",
      getRepoSettings: () =>
        resolveRepoOrchestratorSettings({}, { ...DEFAULT_ORCHESTRATOR_SETTINGS } as OrchestratorSettings),
      requestTransition: async (
        _itemId: string,
        to: LifecycleState,
        _actor: TransitionActor,
        reason?: string,
      ) => {
        transitions.push({ to, reason });
        return items[0];
      },
      completePlan: async () => {},
      getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS }) as OrchestratorSettings,
      getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS, ...llm }),
      emitEvent: (_itemId: string, event: CodingEvent) => void events.push(event),
    } as unknown as PlannerDeps;
    return { deps, transitions, events };
  }

  it("parks the item in needs-input when the provider has no agent mode", async () => {
    const h = makeProviderHarness({ provider: "openai", openaiModel: "gpt-4o", openaiApiKey: "sk-test" });
    initPlanner(h.deps);
    pokePlanner();
    await settle();
    expect(h.transitions).toEqual([
      { to: "needs-input", reason: expect.stringContaining("planning needs a provider with agent mode") },
    ]);
    // The message has to stand alone — it is what the user reads on the item,
    // and it must name every provider that would actually work.
    const error = h.events.find((e) => e.kind === "error");
    expect(error).toBeDefined();
    for (const p of AGENTIC_PROVIDERS) {
      expect(error!.message).toContain(p);
    }
  });

  it("surfaces a missing OpenAI key rather than hanging", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const h = makeProviderHarness({ provider: "openai", openaiModel: "gpt-4o", openaiApiKey: "" });
    initPlanner(h.deps);
    pokePlanner();
    await settle();
    expect(h.transitions[0]).toMatchObject({
      to: "needs-input",
      reason: expect.stringContaining("OpenAI API key required"),
    });
    vi.unstubAllEnvs();
  });
});
