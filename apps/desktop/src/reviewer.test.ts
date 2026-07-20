import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentReview,
  CodingEvent,
  CriticObjection,
  IssuePlan,
  LifecycleState,
  LlmSettings,
  RepoIntakeSettings,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { DEFAULT_LLM_SETTINGS, resolveRepoOrchestratorSettings } from "@skipper/shared";
import type { critiqueDiff, OrchestratorSettings } from "@skipper/core";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/core";
import { initReviewer, pokeReviewer, type ReviewerDeps } from "./reviewer";
import type { WorktreeDiff } from "./worktrees";

const plan: IssuePlan = {
  summary: "do the thing",
  files: [],
  steps: [],
  acceptance: [{ criterion: "it works", addressedBy: "tests" }],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
};

const smallDiff: WorktreeDiff = {
  diff: "diff --git a/src/a.ts b/src/a.ts\n+1",
  stats: { filesChanged: 2, totalChangedLines: 23, files: ["src/a.ts", "src/b.ts"] },
};

const bigDiff: WorktreeDiff = {
  diff: "diff --git a/src/a.ts b/src/a.ts\n+lots",
  stats: { filesChanged: 3, totalChangedLines: 412, files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
};

const blockingObjection: CriticObjection = {
  kind: "acceptance-gap",
  detail: "criterion not met",
  blocking: true,
};

function makeItem(state: LifecycleState, review?: AgentReview): TrackedItem {
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
    plan: { confidence: 0.9, ref: "github_1.json" },
    worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1" },
    ...(review ? { review } : {}),
  };
}

interface Harness {
  items: Map<string, TrackedItem>;
  deps: ReviewerDeps;
  completions: {
    itemId: string;
    review: AgentReview;
    to: LifecycleState;
    reason: string;
    resumeTo?: LifecycleState;
  }[];
  /** setReviewSessionId calls, in order (#111). */
  sessionCalls: { itemId: string; sessionId: string }[];
}

function makeHarness(
  overrides: Partial<ReviewerDeps> = {},
  /** Per-repo overrides (#62); resolved against getSettings() like production does. */
  repoSettings: RepoIntakeSettings = {},
): Harness {
  const items = new Map<string, TrackedItem>();
  const completions: Harness["completions"] = [];
  const sessionCalls: Harness["sessionCalls"] = [];
  const deps: ReviewerDeps = {
    listItems: () => [...items.values()],
    getItem: (id) => items.get(id),
    getIssue: () => undefined,
    getPlan: async (item) =>
      ({
        version: 2,
        itemId: item.id,
        repo: item.repo,
        issueNumber: item.number,
        generatedAt: "2026-07-13T00:00:00.000Z",
        model: "opus",
        plan,
      }) as StoredPlan,
    getDiff: async () => smallDiff,
    completeReview: async (itemId, review, to, reason, resumeTo) => {
      completions.push({ itemId, review, to, reason, resumeTo });
      const item = items.get(itemId)!;
      items.set(itemId, { ...item, review, state: to });
    },
    getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, review: "on" }) as OrchestratorSettings,
    getRepoSettings: () => resolveRepoOrchestratorSettings(repoSettings, deps.getSettings()),
    getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS }),
    setReviewSessionId: async (itemId, sessionId) => void sessionCalls.push({ itemId, sessionId }),
    emitEvent: () => {},
    ...overrides,
  };
  return { items, deps, completions, sessionCalls };
}

function fakeCritic(verdict: "approve" | "concerns" | "reject", objections: CriticObjection[] = []) {
  return vi.fn(async () => ({
    score: 1,
    verdict,
    objections,
  })) as unknown as typeof critiqueDiff & ReturnType<typeof vi.fn>;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function settings(overrides: Partial<OrchestratorSettings>): () => OrchestratorSettings {
  return () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, ...overrides }) as OrchestratorSettings;
}

beforeEach(() => {
  initReviewer(makeHarness().deps, fakeCritic("approve"));
});

describe("reviewer driver", () => {
  it("off mode skips straight to human-review with the reason", async () => {
    const h = makeHarness({ getSettings: settings({ review: "off" }) });
    const critic = fakeCritic("approve");
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(critic).not.toHaveBeenCalled();
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0].to).toBe("human-review");
    expect(h.completions[0].review).toMatchObject({ rounds: 0, outcome: "skipped" });
    expect(h.completions[0].reason).toBe("review skipped (mode: off)");
  });

  // #62: on bypasses the heuristic — this diff is exactly the one auto skips.
  it("on mode reviews a small high-confidence diff that auto would skip", async () => {
    const h = makeHarness({ getSettings: settings({ review: "on" }) });
    const critic = fakeCritic("approve");
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(critic).toHaveBeenCalledOnce();
    expect(h.completions[0].review).toMatchObject({ rounds: 1, outcome: "approve" });
  });

  it("lets a per-repo review override beat the global default", async () => {
    const h = makeHarness({ getSettings: settings({ review: "on" }) }, { review: "off" });
    const critic = fakeCritic("approve");
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(critic).not.toHaveBeenCalled();
    expect(h.completions[0].review).toMatchObject({ outcome: "skipped" });
  });

  // The mode gate is first-round only, so a fix round re-reviews even under off —
  // otherwise the fix loop would never verify its own fix.
  it("re-reviews a chained fix round even when review is off", async () => {
    const h = makeHarness({ getSettings: settings({ review: "off" }) });
    const critic = fakeCritic("approve");
    initReviewer(h.deps, critic);
    h.items.set(
      "github:1",
      makeItem("agent-review", {
        rounds: 1,
        outcome: "reject",
        pendingObjections: [blockingObjection],
        at: "2026-07-13T00:00:00.000Z",
      }),
    );
    pokeReviewer();
    await settle();
    expect(critic).toHaveBeenCalledOnce();
  });

  it("auto mode skips a small high-confidence diff with an explainable reason", async () => {
    const h = makeHarness({ getSettings: settings({ review: "auto" }) });
    const critic = fakeCritic("approve");
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(critic).not.toHaveBeenCalled();
    expect(h.completions[0].to).toBe("human-review");
    expect(h.completions[0].reason).toContain("review skipped (auto)");
    expect(h.completions[0].reason).toContain("23 changed lines");
  });

  it("auto mode forces review on a big diff", async () => {
    const h = makeHarness({
      getSettings: settings({ review: "auto" }),
      getDiff: async () => bigDiff,
    });
    const critic = fakeCritic("approve");
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(critic).toHaveBeenCalledOnce();
    expect(h.completions[0].to).toBe("human-review");
  });

  it("approve lands on human-review with rounds 1", async () => {
    const h = makeHarness();
    initReviewer(h.deps, fakeCritic("approve"));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("human-review");
    expect(h.completions[0].review).toMatchObject({ rounds: 1, outcome: "approve" });
    expect(h.completions[0].review.pendingObjections).toBeUndefined();
  });

  it("non-blocking concerns pass to human-review with notes", async () => {
    const h = makeHarness();
    initReviewer(
      h.deps,
      fakeCritic("concerns", [{ kind: "risk", detail: "minor smell", blocking: false }]),
    );
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("human-review");
    expect(h.completions[0].reason).toContain("concerns");
    expect(h.completions[0].reason).toContain("minor smell");
  });

  it("reject on round 1 sends back to coding with pendingObjections", async () => {
    const h = makeHarness();
    initReviewer(h.deps, fakeCritic("reject", [blockingObjection]));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("coding");
    expect(h.completions[0].review).toMatchObject({ rounds: 1, outcome: "reject" });
    expect(h.completions[0].review.pendingObjections).toEqual([blockingObjection]);
  });

  it("blocking objection with concerns verdict also triggers the fix round", async () => {
    const h = makeHarness();
    initReviewer(h.deps, fakeCritic("concerns", [blockingObjection]));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("coding");
  });

  it("reject on a chained round 2 exits to needs-input with the objections", async () => {
    const h = makeHarness();
    initReviewer(h.deps, fakeCritic("reject", [blockingObjection]));
    h.items.set(
      "github:1",
      makeItem("agent-review", {
        rounds: 1,
        outcome: "reject",
        pendingObjections: [blockingObjection],
        at: "2026-07-13T00:00:00.000Z",
      }),
    );
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("needs-input");
    expect(h.completions[0].review.rounds).toBe(2);
    expect(h.completions[0].reason).toContain("did not converge after 2 rounds");
    expect(h.completions[0].reason).toContain("criterion not met");
    expect(h.completions[0].resumeTo).toBe("human-review");
  });

  // #62: reviewMaxRounds was hardcoded at 2 (MAX_REVIEW_ROUNDS).
  it("reviewMaxRounds 1 exits to needs-input on the first rejecting round", async () => {
    const h = makeHarness({ getSettings: settings({ review: "on", reviewMaxRounds: 1 }) });
    initReviewer(h.deps, fakeCritic("reject", [blockingObjection]));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("needs-input");
    expect(h.completions[0].review.rounds).toBe(1);
    expect(h.completions[0].reason).toContain("did not converge after 1 rounds");
  });

  it("reviewMaxRounds 3 lets a chained round 2 go back to coding", async () => {
    const h = makeHarness({ getSettings: settings({ review: "on", reviewMaxRounds: 3 }) });
    initReviewer(h.deps, fakeCritic("reject", [blockingObjection]));
    h.items.set(
      "github:1",
      makeItem("agent-review", {
        rounds: 1,
        outcome: "reject",
        pendingObjections: [blockingObjection],
        at: "2026-07-13T00:00:00.000Z",
      }),
    );
    pokeReviewer();
    await settle();
    // With the old hardcoded 2 this would have exited to needs-input.
    expect(h.completions[0].to).toBe("coding");
    expect(h.completions[0].review.rounds).toBe(2);
  });

  it("a chained fix round bypasses the auto-skip gate", async () => {
    const h = makeHarness({ getSettings: settings({ review: "auto" }) });
    const critic = fakeCritic("approve");
    initReviewer(h.deps, critic);
    h.items.set(
      "github:1",
      makeItem("agent-review", {
        rounds: 1,
        outcome: "reject",
        pendingObjections: [blockingObjection],
        at: "2026-07-13T00:00:00.000Z",
      }),
    );
    pokeReviewer();
    await settle();
    // small high-confidence diff would auto-skip on round 1 — but this is chained
    expect(critic).toHaveBeenCalledOnce();
    expect(h.completions[0].review.rounds).toBe(2);
    expect(h.completions[0].to).toBe("human-review");
  });

  it("critic failure passes to human-review as unavailable", async () => {
    const h = makeHarness();
    initReviewer(
      h.deps,
      vi.fn(async () => {
        throw new Error("LLM down");
      }) as unknown as typeof critiqueDiff,
    );
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("human-review");
    expect(h.completions[0].review.outcome).toBe("unavailable");
    expect(h.completions[0].reason).toContain("agent review unavailable: LLM down");
  });

  it("empty diff exits to needs-input", async () => {
    const h = makeHarness({
      getDiff: async () => ({ diff: "", stats: { filesChanged: 0, totalChangedLines: 0, files: [] } }),
    });
    initReviewer(h.deps, fakeCritic("approve"));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("needs-input");
    expect(h.completions[0].reason).toContain("no changes");
    expect(h.completions[0].resumeTo).toBe("queued");
  });

  it("diff capture failure exits to needs-input", async () => {
    const h = makeHarness({
      getDiff: async () => {
        throw new Error("worktree gone");
      },
    });
    initReviewer(h.deps, fakeCritic("approve"));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("needs-input");
    expect(h.completions[0].reason).toContain("cannot capture worktree diff: worktree gone");
  });

  it("discards the result when the item moves mid-review", async () => {
    const h = makeHarness();
    const critic = vi.fn(async () => {
      // simulate the user moving the item while the critic runs
      const item = h.items.get("github:1")!;
      h.items.set("github:1", { ...item, state: "closed" });
      return { score: 1, verdict: "approve" as const, objections: [] };
    }) as unknown as typeof critiqueDiff;
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions).toHaveLength(0);
  });

  it("a double poke while in flight reviews once", async () => {
    const h = makeHarness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const critic = vi.fn(async () => {
      await gate;
      return { score: 1, verdict: "approve" as const, objections: [] };
    }) as unknown as typeof critiqueDiff;
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    pokeReviewer();
    await settle();
    release();
    await settle();
    expect(critic).toHaveBeenCalledOnce();
    expect(h.completions).toHaveLength(1);
  });
});

// #111: the reviewer mints a per-round claude-cli session, persists it before the
// critic runs, and stamps it on the AgentReview it completes.
describe("reviewer session persistence (#111)", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("mints a session before the critic and stamps it on the review", async () => {
    const h = makeHarness();
    let sessionsAtCriticTime: number | undefined;
    let criticSession: { id: string; cwd: string } | undefined;
    const critic = vi.fn(async (args: { session?: { id: string; cwd: string } }) => {
      sessionsAtCriticTime = h.sessionCalls.length;
      criticSession = args.session;
      return { score: 1, verdict: "approve" as const, objections: [] };
    }) as unknown as typeof critiqueDiff;
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();

    expect(h.sessionCalls).toHaveLength(1);
    const sessionId = h.sessionCalls[0].sessionId;
    expect(sessionId).toMatch(UUID_RE);
    // Persisted before the critic ran — a crash mid-critique still leaves a pointer.
    expect(sessionsAtCriticTime).toBe(1);
    expect(criticSession).toEqual({ id: sessionId, cwd: "/wt/repo/issue-1" });
    expect(h.completions[0].review.sessionId).toBe(sessionId);
  });

  it("stamps the session on a fix-round review too", async () => {
    const h = makeHarness();
    initReviewer(h.deps, fakeCritic("reject", [blockingObjection]));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.completions[0].to).toBe("coding");
    expect(h.completions[0].review.sessionId).toBe(h.sessionCalls[0].sessionId);
  });

  it("does not mint when the mode gate skips the review", async () => {
    const h = makeHarness({ getSettings: settings({ review: "off" }) });
    initReviewer(h.deps, fakeCritic("approve"));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.sessionCalls).toEqual([]);
    expect(h.completions[0].review.sessionId).toBeUndefined();
  });

  it("does not mint on an empty diff", async () => {
    const h = makeHarness({
      getDiff: async () => ({ diff: "", stats: { filesChanged: 0, totalChangedLines: 0, files: [] } }),
    });
    initReviewer(h.deps, fakeCritic("approve"));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.sessionCalls).toEqual([]);
  });

  it("does not mint when diff capture fails", async () => {
    const h = makeHarness({
      getDiff: async () => {
        throw new Error("worktree gone");
      },
    });
    initReviewer(h.deps, fakeCritic("approve"));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    expect(h.sessionCalls).toEqual([]);
  });
});

// #113: the reviewer streams coarse lifecycle beats over its own event channel.
describe("reviewer event emission (#113)", () => {
  it("emits fetching → agent-init → result in order for an approve round", async () => {
    const events: CodingEvent[] = [];
    const h = makeHarness({ emitEvent: (_id, event) => void events.push(event) });
    initReviewer(h.deps, fakeCritic("approve"));
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();

    expect(events[0]).toMatchObject({ kind: "status", phase: "fetching" });
    expect(events.some((e) => e.kind === "agent-init")).toBe(true);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ kind: "result", ok: true });
    const initIndex = events.findIndex((e) => e.kind === "agent-init");
    const resultIndex = events.findIndex((e) => e.kind === "result");
    expect(initIndex).toBeLessThan(resultIndex);
  });
});

// #59: the reviewer builds its provider from settings.json rather than pinning
// claude-cli. Unlike the planner it only needs askStructured, so every provider works.
describe("reviewer provider selection (#59)", () => {
  /** Captures the provider the driver hands to the critic. */
  function capturingCritic() {
    const seen: string[] = [];
    const critic = vi.fn(async (_args, llm) => {
      seen.push(llm.name);
      return { score: 1, verdict: "approve" as const, objections: [] };
    }) as unknown as typeof critiqueDiff;
    return { critic, seen };
  }

  async function reviewWith(llm: Partial<LlmSettings>): Promise<string[]> {
    const h = makeHarness({
      getSettings: settings({ review: "on" }),
      getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS, ...llm }),
    });
    const { critic, seen } = capturingCritic();
    initReviewer(h.deps, critic);
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();
    return seen;
  }

  it("defaults to claude-cli when no provider is configured", async () => {
    expect(await reviewWith({})).toEqual(["claude-cli"]);
  });

  it("reviews through openai when it is selected", async () => {
    expect(await reviewWith({ provider: "openai", openaiModel: "gpt-4o", openaiApiKey: "sk-test" })).toEqual([
      "openai",
    ]);
  });

  it("reviews through ollama when it is selected", async () => {
    expect(await reviewWith({ provider: "ollama", ollamaModel: "llama3" })).toEqual(["ollama"]);
  });

  // The pre-#59 cache keyed on the model alone, so switching provider in Settings
  // kept serving the previous provider until restart.
  it("rebuilds the provider when the setting changes mid-session", async () => {
    let llm: Partial<LlmSettings> = {};
    const h = makeHarness({
      getSettings: settings({ review: "on" }),
      getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS, ...llm }),
    });
    const { critic, seen } = capturingCritic();
    initReviewer(h.deps, critic);

    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();

    llm = { provider: "ollama", ollamaModel: "llama3" };
    h.items.set("github:1", makeItem("agent-review"));
    pokeReviewer();
    await settle();

    expect(seen).toEqual(["claude-cli", "ollama"]);
  });
});
