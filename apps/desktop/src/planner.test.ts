import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodingEvent,
  Issue,
  LifecycleState,
  LlmSettings,
  RepoIntakeSettings,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import { DEFAULT_LLM_SETTINGS, resolveRepoOrchestratorSettings } from "@skipper/shared";
import type { OrchestratorSettings } from "@skipper/core";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/core";
import { initPlanner, pokePlanner, type PlannerDeps } from "./planner";

// The planner's scan() gate (#62). run() itself needs a real LLM, so these cover
// the admission decision only — which is where the master switch lives.

function makeItem(state: LifecycleState): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "owner/repo", key: "1" },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "owner", name: "repo" },
    key: "1",
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
    prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
    setWorktree: async () => {},
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
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
      setWorktree: async () => {},
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
    // The message has to stand alone — it is what the user reads on the item.
    expect(h.events.some((e) => e.kind === "error" && /claude-cli or ollama/.test(e.message))).toBe(true);
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

// #110: planning runs in the shared worktree, degrading to the shared clone when
// setup fails. A fake agent provider captures the cwd it is handed.
describe("planner worktree at planning (#110)", () => {
  const VALID_PLAN = JSON.stringify({
    summary: "do the thing",
    files: [{ path: "a.ts", reason: "touch it" }],
    steps: [{ title: "s", detail: "d", files: [], symbols: [] }],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
  });

  let plansDir: string;
  beforeEach(async () => {
    plansDir = await mkdtemp(join(tmpdir(), "nb-planner-"));
  });
  afterEach(async () => {
    await rm(plansDir, { recursive: true, force: true });
  });

  interface RunHarness {
    deps: PlannerDeps;
    provider: unknown;
    cwds: string[];
    setWorktreeCalls: { path: string; branch: string; sessionId?: string }[];
    transitions: { to: LifecycleState }[];
    /** Resolves once run() reaches completePlan — all plansDir writes are done by then. */
    done: Promise<void>;
  }

  function makeRunHarness(opts: {
    item: TrackedItem;
    prepareWorktree: PlannerDeps["prepareWorktree"];
  }): RunHarness {
    const items = [opts.item];
    const cwds: string[] = [];
    const setWorktreeCalls: RunHarness["setWorktreeCalls"] = [];
    const transitions: RunHarness["transitions"] = [];
    let resolveDone: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    // agent capture stands in for the whole provider — computeConfidence's
    // extra runs reuse it, its askStructured throws (critic degrades safely).
    const provider = {
      name: "fake",
      agent: async (_prompt: string, agentOpts: { cwd: string }) => {
        cwds.push(agentOpts.cwd);
        return { text: VALID_PLAN };
      },
      askStructured: async () => {
        throw new Error("no structured mode in the fake");
      },
    };
    const deps: PlannerDeps = {
      listItems: () => items,
      getItem: (id: string) => items.find((i) => i.id === id),
      getIssue: () => ({ labels: [] }) as unknown as Issue,
      getRepoPath: () => "/repo",
      getRepoSettings: () =>
        resolveRepoOrchestratorSettings({}, { ...DEFAULT_ORCHESTRATOR_SETTINGS } as OrchestratorSettings),
      requestTransition: async (_itemId: string, to: LifecycleState) => {
        transitions.push({ to });
        return items[0];
      },
      completePlan: async () => void resolveDone(),
      prepareWorktree: opts.prepareWorktree,
      setWorktree: async (_itemId: string, worktree: { path: string; branch: string; sessionId?: string }) =>
        void setWorktreeCalls.push(worktree),
      getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS }) as OrchestratorSettings,
      getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS }),
      emitEvent: () => {},
      plansDir,
    } as unknown as PlannerDeps;
    return { deps, provider, cwds, setWorktreeCalls, transitions, done };
  }

  it("plans in the worktree and records it once", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
    });
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    expect(h.cwds.length).toBeGreaterThan(0);
    expect(h.cwds.every((c) => c === "/wt/issue-1")).toBe(true);
    expect(h.setWorktreeCalls).toEqual([{ path: "/wt/issue-1", branch: "feature/issue-1" }]);
    expect(h.setWorktreeCalls[0]).not.toHaveProperty("sessionId");
    expect(h.transitions).toEqual([]); // no needs-input
  });

  it("degrades to the shared clone when worktree setup fails", async () => {
    const events: CodingEvent[] = [];
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => {
        throw new Error("offline");
      },
    });
    (h.deps as { emitEvent: PlannerDeps["emitEvent"] }).emitEvent = (_id, event) =>
      void events.push(event);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    expect(h.cwds.every((c) => c === "/repo")).toBe(true);
    expect(h.cwds.length).toBeGreaterThan(0);
    expect(h.setWorktreeCalls).toEqual([]);
    expect(h.transitions).toEqual([]); // never needs-input on degrade
    expect(
      events.some(
        (e) => e.kind === "status" && e.phase === "worktree" && /shared clone/.test(e.detail ?? ""),
      ),
    ).toBe(true);
  });

  it("skips the worktree write when the record already matches", async () => {
    const item = makeItem("planning");
    item.worktree = { path: "/wt/issue-1", branch: "feature/issue-1", sessionId: "s" };
    const h = makeRunHarness({
      item,
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
    });
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    expect(h.setWorktreeCalls).toEqual([]);
  });
});
