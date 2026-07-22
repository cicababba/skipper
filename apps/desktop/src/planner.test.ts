import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
import { AGENT_MAX_TURNS_BACKSTOP, DEFAULT_LLM_SETTINGS, resolveRepoOrchestratorSettings } from "@skipper/shared";
import type { OrchestratorSettings } from "@skipper/core";
import { AgentAbortError, DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/core";
import {
  initPlanner,
  pokePlanner,
  cancelPlanningRun,
  killAllPlanningRuns,
  type PlannerDeps,
} from "./planner";

// The planner's scan() gate (#62). run() itself needs a real LLM, so these cover
// the admission decision only — which is where the master switch lives.

function makeItem(state: LifecycleState, planningAt?: string): TrackedItem {
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
    transitions: planningAt
      ? [{ at: planningAt, from: "triage", to: "planning", actor: "user" }]
      : [],
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
    checkoutDirtyPaths: async () => null,
    getRepoSettings: () => resolveRepoOrchestratorSettings(repoSettings, getSettings()),
    requestTransition: async (itemId: string, to: LifecycleState, actor: TransitionActor) => {
      transitions.push({ itemId, to, actor });
      // Model the state change so the finally-poke rescan (#159) doesn't re-enqueue
      // an item still stuck in "planning". Throwing after keeps a manual run from
      // proceeding into real plan generation.
      const idx = items.findIndex((i) => i.id === itemId);
      if (idx >= 0) items[idx] = { ...items[idx], state: to };
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

async function waitFor(cond: () => boolean, max = 100): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
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
      checkoutDirtyPaths: async () => null,
      getRepoSettings: () =>
        resolveRepoOrchestratorSettings({}, { ...DEFAULT_ORCHESTRATOR_SETTINGS } as OrchestratorSettings),
      requestTransition: async (
        _itemId: string,
        to: LifecycleState,
        _actor: TransitionActor,
        reason?: string,
      ) => {
        transitions.push({ to, reason });
        // Move out of "planning" so the finally-poke rescan (#159) settles.
        items[0] = { ...items[0], state: to };
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
    context: [],
    files: [{ path: "a.ts", reason: "touch it" }],
    steps: [{ title: "s", detail: "d", files: [], symbols: [] }],
    outOfScope: [],
    acceptance: [],
    risks: [],
    verificationCommands: [],
    manualChecks: [],
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
    /** Plan session ids persisted via setPlanSessionId, in order (#111). */
    planSessionIds: string[];
    /** sessionId handed to each agent() call, in order (#111). */
    agentSessionIds: (string | undefined)[];
    /** Whether a plan session was persisted before the first agent() call (crash-safe order). */
    flags: { persistedBeforeAgent: boolean };
    transitions: { to: LifecycleState }[];
    /** Resolves once run() reaches completePlan — all plansDir writes are done by then. */
    done: Promise<void>;
  }

  function makeRunHarness(opts: {
    item: TrackedItem;
    prepareWorktree: PlannerDeps["prepareWorktree"];
    /** Provider name gating session minting (#111). Defaults to "fake" → no mint. */
    providerName?: string;
  }): RunHarness {
    const items = [opts.item];
    const cwds: string[] = [];
    const setWorktreeCalls: RunHarness["setWorktreeCalls"] = [];
    const planSessionIds: string[] = [];
    const agentSessionIds: (string | undefined)[] = [];
    const flags = { persistedBeforeAgent: false };
    let agentStarted = false;
    const transitions: RunHarness["transitions"] = [];
    let resolveDone: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    // agent capture stands in for the whole provider — computeConfidence's
    // extra runs reuse it, its askStructured throws (critic degrades safely).
    const provider = {
      name: opts.providerName ?? "fake",
      agent: async (_prompt: string, agentOpts: { cwd: string; sessionId?: string }) => {
        cwds.push(agentOpts.cwd);
        agentSessionIds.push(agentOpts.sessionId);
        if (!agentStarted) {
          agentStarted = true;
          flags.persistedBeforeAgent = planSessionIds.length > 0;
        }
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
      checkoutDirtyPaths: async () => null,
      getRepoSettings: () =>
        resolveRepoOrchestratorSettings({}, { ...DEFAULT_ORCHESTRATOR_SETTINGS } as OrchestratorSettings),
      requestTransition: async (itemId: string, to: LifecycleState) => {
        transitions.push({ to });
        const idx = items.findIndex((i) => i.id === itemId);
        if (idx >= 0) items[idx] = { ...items[idx], state: to };
        return items[0];
      },
      // Land the item out of "planning" so the finally-poke rescan (#159) settles.
      completePlan: async (itemId: string) => {
        const idx = items.findIndex((i) => i.id === itemId);
        if (idx >= 0) items[idx] = { ...items[idx], state: "plan-gate" };
        resolveDone();
      },
      prepareWorktree: opts.prepareWorktree,
      setWorktree: async (_itemId: string, worktree: { path: string; branch: string; sessionId?: string }) =>
        void setWorktreeCalls.push(worktree),
      setPlanSessionId: async (_itemId: string, sessionId: string) => void planSessionIds.push(sessionId),
      getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS }) as OrchestratorSettings,
      getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS }),
      emitEvent: () => {},
      plansDir,
    } as unknown as PlannerDeps;
    return {
      deps,
      provider,
      cwds,
      setWorktreeCalls,
      planSessionIds,
      agentSessionIds,
      flags,
      transitions,
      done,
    };
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

  it("hands generatePlan the planner time budget, so the agent runs on time not turns (#194)", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
    });
    const captured: { maxTurns?: number; hardTimeoutMs?: number }[] = [];
    const provider = h.provider as {
      agent: (p: string, o: Record<string, unknown>) => Promise<{ text: string }>;
    };
    const inner = provider.agent.bind(provider);
    provider.agent = async (p, o) => {
      captured.push({ maxTurns: o.maxTurns as number | undefined, hardTimeoutMs: o.hardTimeoutMs as number | undefined });
      return inner(p, o);
    };
    initPlanner(h.deps, provider as never);
    pokePlanner();
    await h.done;
    // The driver forwards the time budget and passes no turn knob, so generatePlan
    // falls back to the turn backstop (300) rather than the old plannerMaxTurns.
    expect(captured[0].hardTimeoutMs).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.plannerTimeBudgetMin * 60_000);
    expect(captured[0].maxTurns).toBe(AGENT_MAX_TURNS_BACKSTOP);
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

  // #111: claude-cli planning in the worktree mints and persists a session id
  // before the agent runs; the same id is handed to generatePlan/agent.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("mints and persists a plan session for claude-cli before the agent runs", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
      providerName: "claude-cli",
    });
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    expect(h.planSessionIds).toHaveLength(1);
    expect(h.planSessionIds[0]).toMatch(UUID_RE);
    expect(h.flags.persistedBeforeAgent).toBe(true);
    // The primary agent run receives the minted id; confidence's extra runs stay stateless.
    expect(h.agentSessionIds[0]).toBe(h.planSessionIds[0]);
  });

  it("does not mint a plan session for a non-claude-cli provider", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
    });
    initPlanner(h.deps, h.provider as never); // name "fake"
    pokePlanner();
    await h.done;
    expect(h.planSessionIds).toEqual([]);
    expect(h.agentSessionIds[0]).toBeUndefined();
  });

  it("does not mint when planning degrades to the shared clone", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => {
        throw new Error("offline");
      },
      providerName: "claude-cli",
    });
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    // Degraded to /repo — a session against the clone would break cwd-scoped resume.
    expect(h.cwds.every((c) => c === "/repo")).toBe(true);
    expect(h.planSessionIds).toEqual([]);
    expect(h.agentSessionIds[0]).toBeUndefined();
  });

  // #202: the worktree's pre-existing uncommitted changes (leftover from a failed
  // coding attempt) are surfaced in the plan prompt. Capture the prompt the fake
  // agent receives as its first argument.
  function capturePrompts(provider: unknown): string[] {
    const prompts: string[] = [];
    const p = provider as {
      agent: (prompt: string, o: Record<string, unknown>) => Promise<{ text: string }>;
    };
    const inner = p.agent.bind(p);
    p.agent = async (prompt, o) => {
      prompts.push(prompt);
      return inner(prompt, o);
    };
    return prompts;
  }

  it("feeds the worktree's pre-existing uncommitted changes into the plan prompt (#202)", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
    });
    // Dirty in the worktree, clean in the shared clone — so the tripwire (which
    // diffs /repo) never fires and only the pre-existing block reaches the prompt.
    (h.deps as { checkoutDirtyPaths: PlannerDeps["checkoutDirtyPaths"] }).checkoutDirtyPaths =
      async (path: string) =>
        path === "/wt/issue-1" ? [" M github/close.ts", "?? github/new.ts"] : [];
    const prompts = capturePrompts(h.provider);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    expect(prompts[0]).toContain("--- Pre-existing uncommitted changes ---");
    expect(prompts[0]).toContain(" M github/close.ts");
    expect(prompts[0]).toContain("?? github/new.ts");
    expect(h.transitions).toEqual([]); // dirty worktree is grounding, not an escape
  });

  it("omits the block when the worktree is clean (#202)", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
    });
    (h.deps as { checkoutDirtyPaths: PlannerDeps["checkoutDirtyPaths"] }).checkoutDirtyPaths =
      async () => [];
    const prompts = capturePrompts(h.provider);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    expect(prompts[0]).not.toContain("Pre-existing uncommitted changes");
  });

  it("omits the block when git status fails in the worktree (#202)", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
    });
    (h.deps as { checkoutDirtyPaths: PlannerDeps["checkoutDirtyPaths"] }).checkoutDirtyPaths =
      async () => null;
    const prompts = capturePrompts(h.provider);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    expect(prompts[0]).not.toContain("Pre-existing uncommitted changes");
  });

  it("omits the block when planning degrades to the shared clone even if it is dirty (#202)", async () => {
    const h = makeRunHarness({
      item: makeItem("planning"),
      prepareWorktree: async () => {
        throw new Error("offline");
      },
    });
    // The shared clone's dirt is the user's own in-flight work — never reported.
    (h.deps as { checkoutDirtyPaths: PlannerDeps["checkoutDirtyPaths"] }).checkoutDirtyPaths =
      async () => [" M user-file.ts"];
    const prompts = capturePrompts(h.provider);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await h.done;
    expect(h.cwds.every((c) => c === "/repo")).toBe(true);
    expect(prompts[0]).not.toContain("Pre-existing uncommitted changes");
  });
});

// #159: an in-flight planning run must die on cancel/untrack, and a zombie that
// survives the race must never land results on a newer lifecycle. The fake
// provider holds its agent() until the test releases it (or the signal aborts).
describe("planner cancellation & zombie protection (#159)", () => {
  const VALID_PLAN = JSON.stringify({
    summary: "do the thing",
    context: [],
    files: [{ path: "a.ts", reason: "touch it" }],
    steps: [{ title: "s", detail: "d", files: [], symbols: [] }],
    outOfScope: [],
    acceptance: [],
    risks: [],
    verificationCommands: [],
    manualChecks: [],
    openQuestions: [],
    estimatedSize: "s",
  });

  let plansDir: string;
  // Held runs never resolve on their own — drain them so the module-level `active`
  // counter (intentionally not reset by initPlanner) doesn't leak across tests.
  let drainItems: TrackedItem[] = [];
  beforeEach(async () => {
    plansDir = await mkdtemp(join(tmpdir(), "nb-planner-cancel-"));
  });
  afterEach(async () => {
    drainItems.length = 0;
    killAllPlanningRuns();
    await settle();
    await rm(plansDir, { recursive: true, force: true });
  });

  interface CancelHarness {
    deps: PlannerDeps;
    provider: unknown;
    items: TrackedItem[];
    /** Signal handed to each agent() call, in order. */
    signals: (AbortSignal | undefined)[];
    /** Release the currently-held agent() call with a successful plan. */
    release: (plan?: string) => void;
    completePlanCalls: { itemId: string; ref: string; expectedPlanningAt?: string }[];
    transitions: { to: LifecycleState }[];
    events: CodingEvent[];
  }

  function makeCancelHarness(items: TrackedItem[]): CancelHarness {
    drainItems = items;
    const signals: (AbortSignal | undefined)[] = [];
    const completePlanCalls: CancelHarness["completePlanCalls"] = [];
    const transitions: CancelHarness["transitions"] = [];
    const events: CodingEvent[] = [];
    let releaseFn: (plan: string) => void = () => {};
    const provider = {
      name: "fake",
      agent: (_prompt: string, agentOpts: { signal?: AbortSignal }) => {
        signals.push(agentOpts.signal);
        return new Promise<{ text: string }>((resolve, reject) => {
          releaseFn = (plan: string) => resolve({ text: plan });
          agentOpts.signal?.addEventListener("abort", () => reject(new AgentAbortError()));
        });
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
      checkoutDirtyPaths: async () => null,
      getRepoSettings: () =>
        resolveRepoOrchestratorSettings({}, { ...DEFAULT_ORCHESTRATOR_SETTINGS } as OrchestratorSettings),
      requestTransition: async (_itemId: string, to: LifecycleState) => {
        transitions.push({ to });
        return items[0];
      },
      completePlan: async (
        itemId: string,
        ref: string,
        _confidence: unknown,
        expectedPlanningAt?: string,
      ) => {
        completePlanCalls.push({ itemId, ref, expectedPlanningAt });
        const idx = items.findIndex((i) => i.id === itemId);
        if (idx >= 0) items[idx] = { ...items[idx], state: "plan-gate" };
      },
      prepareWorktree: async () => ({ path: "/wt/issue-1", branch: "feature/issue-1" }),
      setWorktree: async () => {},
      getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS }) as OrchestratorSettings,
      getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS }),
      emitEvent: (_id: string, e: CodingEvent) => void events.push(e),
      plansDir,
    } as unknown as PlannerDeps;
    return {
      deps,
      provider,
      items,
      signals,
      release: (plan = VALID_PLAN) => releaseFn(plan),
      completePlanCalls,
      transitions,
      events,
    };
  }

  it("cancel mid-run kills everything and clears the in-flight slot", async () => {
    const item = makeItem("planning", "2026-07-21T00:00:00.000Z");
    const h = makeCancelHarness([item]);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await settle();
    expect(h.signals).toHaveLength(1);

    cancelPlanningRun(item.id);
    await settle();

    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.completePlanCalls).toEqual([]);
    expect(h.transitions).toEqual([]); // no needs-input on cancel
    expect(await readdir(plansDir)).toEqual([]); // no plan file written
    // The finally-poke re-enqueues the still-planning item → a fresh run starts,
    // which is only possible if the in-flight slot was cleared.
    expect(h.signals).toHaveLength(2);
  });

  it("a zombie run cannot land on the re-admitted lifecycle", async () => {
    const h = makeCancelHarness([makeItem("planning", "2026-07-21T00:00:00.000Z")]);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await settle();
    expect(h.signals).toHaveLength(1);

    // Re-admit under a NEWER planning transition without aborting the zombie.
    h.items[0] = makeItem("planning", "2026-07-21T00:05:00.000Z");
    // The zombie finishes successfully — the pre-write live() check must reject it.
    h.release();
    await settle();

    expect(h.completePlanCalls).toEqual([]);
    expect(await readdir(plansDir)).toEqual([]);
  });

  it("untrack → re-admit runs a fresh plan that completes with the new token", async () => {
    const item = makeItem("planning", "2026-07-21T00:00:00.000Z");
    const h = makeCancelHarness([item]);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await settle();
    expect(h.signals).toHaveLength(1);

    // Untrack: drop the item and cancel its run (mirrors orchestrator.untrackItem).
    h.items.length = 0;
    cancelPlanningRun(item.id);
    await settle();

    // Re-admit with a fresh planning transition, then poke.
    h.items.push(makeItem("planning", "2026-07-21T00:05:00.000Z"));
    pokePlanner();
    await settle();
    expect(h.signals.length).toBeGreaterThanOrEqual(2);

    // Release the fresh run — it completes against the new token.
    h.release();
    await waitFor(() => h.completePlanCalls.length > 0);
    expect(h.completePlanCalls).toHaveLength(1);
    expect(h.completePlanCalls[0]).toMatchObject({
      itemId: "github:1",
      expectedPlanningAt: "2026-07-21T00:05:00.000Z",
    });
  });

  // #196: a plan run that leaves new dirt in the linked checkout is failed to
  // needs-input; the plan is neither completed nor written to disk.
  it("fails to needs-input with an escape reason when the run dirtied the checkout", async () => {
    const item = makeItem("planning", "2026-07-21T00:00:00.000Z");
    const h = makeCancelHarness([item]);
    let calls = 0;
    h.deps.checkoutDirtyPaths = async () => (calls++ === 0 ? [] : ["?? stray.ts"]);
    initPlanner(h.deps, h.provider as never);
    pokePlanner();
    await settle();
    expect(h.signals).toHaveLength(1);

    // The plan run finishes successfully, but it dirtied the linked checkout.
    h.release();
    await waitFor(() => h.transitions.some((t) => t.to === "needs-input"));

    expect(h.transitions.map((t) => t.to)).toContain("needs-input");
    expect(
      h.events.some((e) => e.kind === "error" && /escaped the worktree/.test(e.message)),
    ).toBe(true);
    expect(h.completePlanCalls).toEqual([]);
    expect(await readdir(plansDir)).toEqual([]);
  });
});
