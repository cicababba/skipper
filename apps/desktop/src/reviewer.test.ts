import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentReview,
  CriticObjection,
  IssuePlan,
  LifecycleState,
  RepoIntakeSettings,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { resolveRepoOrchestratorSettings } from "@skipper/shared";
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
    plan: { confidence: 0.9, ref: "github_1.json" },
    worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1" },
    ...(review ? { review } : {}),
  };
}

interface Harness {
  items: Map<string, TrackedItem>;
  deps: ReviewerDeps;
  completions: { itemId: string; review: AgentReview; to: LifecycleState; reason: string }[];
}

function makeHarness(
  overrides: Partial<ReviewerDeps> = {},
  /** Per-repo overrides (#62); resolved against getSettings() like production does. */
  repoSettings: RepoIntakeSettings = {},
): Harness {
  const items = new Map<string, TrackedItem>();
  const completions: Harness["completions"] = [];
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
    completeReview: async (itemId, review, to, reason) => {
      completions.push({ itemId, review, to, reason });
      const item = items.get(itemId)!;
      items.set(itemId, { ...item, review, state: to });
    },
    getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, review: "on" }) as OrchestratorSettings,
    getRepoSettings: () => resolveRepoOrchestratorSettings(repoSettings, deps.getSettings()),
    ...overrides,
  };
  return { items, deps, completions };
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
