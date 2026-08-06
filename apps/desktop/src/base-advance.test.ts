import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  GroundednessSignal,
  IssuePlan,
  LifecycleState,
  SourceRef,
  StoredPlan,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import {
  initBaseAdvance,
  reactToMergedItems,
  reactToMerges,
  resolveBaseAdvanceVerdicts,
  type BaseAdvanceDeps,
  type BaseAdvanceEvidence,
  type BaseAdvancePlanFacts,
} from "./base-advance";
import type { RepoLinksFile } from "./repo-links";

// The #329 merge reaction, driver-style: every git/FS op is injected, so the
// invariants under test are the ladder (replan / warn / probe), the probe
// worktree's lifecycle, and "a merge reaction never breaks polling".

const REPO = { owner: "acme", name: "rocket" };
const REPO_KEY = "acme/rocket";
const OTHER_REPO = { owner: "acme", name: "anvil" };

function planWith(files: string[]): IssuePlan {
  return {
    summary: "s",
    files: files.map((path) => ({ path, reason: "r" })),
    steps: [],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "m",
  };
}

function item(n: number, state: LifecycleState, overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: `github:${n}`,
    source: "github",
    sourceRef: { project: "acme/rocket", key: String(n) },
    codeHost: "github",
    accountId: "acct-1",
    repo: REPO,
    key: String(n),
    number: n,
    title: `Issue ${n}`,
    url: `https://example.test/acme/rocket/issues/${n}`,
    state,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    transitions: [],
    plan: { ref: `plan-${n}` },
    ...overrides,
  };
}

function ref(n: number): SourceRef {
  return { project: "acme/rocket", key: String(n) };
}

function stored(plan: IssuePlan, overrides: Partial<StoredPlan> = {}): StoredPlan {
  return {
    version: 2,
    itemId: "github:1",
    repo: REPO,
    generatedAt: "2026-08-01T00:00:00.000Z",
    model: "claude",
    plan,
    ...overrides,
  };
}

function groundedness(overrides: Partial<GroundednessSignal> = {}): GroundednessSignal {
  return {
    score: 0.9,
    filesChecked: 1,
    filesFound: 1,
    symbolsChecked: 0,
    symbolsFound: 0,
    missingFiles: [],
    missingSymbols: [],
    newFiles: [],
    ...overrides,
  };
}

interface Harness {
  deps: BaseAdvanceDeps;
  links: RepoLinksFile;
  order: string[];
  saveRepoLinks: ReturnType<typeof vi.fn>;
  requestTransition: ReturnType<typeof vi.fn>;
  setBaseAdvance: ReturnType<typeof vi.fn>;
  diffNames: ReturnType<typeof vi.fn>;
  addWorktree: ReturnType<typeof vi.fn>;
  removeWorktree: ReturnType<typeof vi.fn>;
  scoreGroundedness: ReturnType<typeof vi.fn>;
}

function makeHarness(
  opts: {
    items?: TrackedItem[];
    plans?: Record<string, StoredPlan | null>;
    changed?: string[];
    baseSha?: string | null;
    newSha?: string;
    fresh?: Record<string, GroundednessSignal>;
    linked?: boolean;
    revParse?: () => Promise<string>;
    addWorktree?: () => Promise<void>;
    scoreGroundedness?: () => Promise<GroundednessSignal>;
  } = {},
): Harness {
  const order: string[] = [];
  const links: RepoLinksFile = {
    version: 1,
    repos:
      opts.linked === false
        ? {}
        : {
            [REPO_KEY]: {
              localPath: "/clones/rocket",
              linkedAt: "2026-08-01T00:00:00.000Z",
              ...(opts.baseSha === null ? {} : { baseSha: opts.baseSha ?? "sha-old" }),
            },
          },
  };

  const saveRepoLinks = vi.fn(async () => {});
  const requestTransition = vi.fn(
    async (
      _itemId: string,
      _to: LifecycleState,
      _actor: TransitionActor,
      _reason?: string,
    ): Promise<TrackedItem> => item(1, "planning"),
  );
  const setBaseAdvance = vi.fn(async () => {});
  const diffNames = vi.fn(async (): Promise<string[]> => opts.changed ?? []);
  const addWorktree = vi.fn(async (): Promise<void> => {
    if (opts.addWorktree) return opts.addWorktree();
    order.push("worktree-add");
  });
  const removeWorktree = vi.fn(async (): Promise<void> => {
    order.push("worktree-remove");
  });
  const scoreGroundedness = vi.fn(
    async (_plan: IssuePlan, path: string): Promise<GroundednessSignal> => {
      if (opts.scoreGroundedness) return opts.scoreGroundedness();
      order.push(`score ${path}`);
      return groundedness();
    },
  );

  const deps: BaseAdvanceDeps = {
    plansDir: "/plans",
    worktreesDir: "/worktrees",
    getItems: async () => opts.items ?? [],
    getRepoLinks: async () => links,
    saveRepoLinks,
    withRepoGitLock: async (repo, fn) => {
      order.push(`lock-enter ${repo.owner}/${repo.name}`);
      try {
        return await fn();
      } finally {
        order.push(`lock-exit ${repo.owner}/${repo.name}`);
      }
    },
    requestTransition,
    setBaseAdvance,
    ops: {
      fetchOrigin: async () => {},
      resolveBaseRef: async () => "origin/main",
      revParse: opts.revParse ?? (async () => opts.newSha ?? "sha-new"),
      diffNames,
      addWorktree,
      removeWorktree,
      readPlan: async (planRef: string) => opts.plans?.[planRef] ?? null,
      scoreGroundedness,
      now: () => new Date("2026-08-07T12:00:00.000Z"),
    },
  };

  return {
    deps,
    links,
    order,
    saveRepoLinks,
    requestTransition,
    setBaseAdvance,
    diffNames,
    addWorktree,
    removeWorktree,
    scoreGroundedness,
  };
}

function evidence(overrides: Partial<BaseAdvanceEvidence> = {}): BaseAdvanceEvidence {
  return {
    merged: [{ source: "github", sourceRef: ref(9), key: "9" }],
    changedFiles: [],
    plans: new Map<string, BaseAdvancePlanFacts>(),
    ...overrides,
  };
}

function facts(plan: IssuePlan, handEdited = false): BaseAdvancePlanFacts {
  return { plan, handEdited };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveBaseAdvanceVerdicts — the ladder", () => {
  it("replans a plan-gate item whose merged prerequisite it still lists", () => {
    const dependent = item(1, "plan-gate", { blockedBy: [ref(9)] });
    const verdicts = resolveBaseAdvanceVerdicts(
      [dependent],
      REPO_KEY,
      evidence({ plans: new Map([[dependent.id, facts(planWith(["src/a.ts"]))]]) }),
    );
    expect(verdicts).toEqual([
      { id: "github:1", key: "1", action: "replan", mergedKeys: ["9"], overlapFiles: [] },
    ]);
  });

  it("warns instead of replanning when the plan was hand-edited", () => {
    const dependent = item(1, "plan-gate", { blockedBy: [ref(9)] });
    const verdicts = resolveBaseAdvanceVerdicts(
      [dependent],
      REPO_KEY,
      evidence({ plans: new Map([[dependent.id, facts(planWith(["src/a.ts"]), true)]]) }),
    );
    expect(verdicts[0]).toMatchObject({ action: "warn", reason: "edited-plan" });
  });

  it("warns instead of replanning when the state cannot reach planning", () => {
    const dependent = item(1, "human-review", { blockedBy: [ref(9)] });
    const verdicts = resolveBaseAdvanceVerdicts(
      [dependent],
      REPO_KEY,
      evidence({ plans: new Map([[dependent.id, facts(planWith(["src/a.ts"]))]]) }),
    );
    expect(verdicts[0]).toMatchObject({ action: "warn", reason: "in-flight" });
  });

  it("probes an item whose plan cites files the merge changed", () => {
    const sibling = item(1, "plan-gate");
    const verdicts = resolveBaseAdvanceVerdicts(
      [sibling],
      REPO_KEY,
      evidence({
        changedFiles: ["src/a.ts", "src/untouched.ts"],
        plans: new Map([[sibling.id, facts(planWith(["src/a.ts", "src/b.ts"]))]]),
      }),
    );
    expect(verdicts).toEqual([
      {
        id: "github:1",
        key: "1",
        action: "probe",
        mergedKeys: ["9"],
        overlapFiles: ["src/a.ts"],
      },
    ]);
  });

  it("stamps the blocker on a probe so the later warn can name it", () => {
    const sibling = item(1, "coding");
    const verdicts = resolveBaseAdvanceVerdicts(
      [sibling],
      REPO_KEY,
      evidence({
        changedFiles: ["src/a.ts"],
        plans: new Map([[sibling.id, facts(planWith(["src/a.ts"]))]]),
      }),
    );
    expect(verdicts[0]).toMatchObject({ action: "probe", reason: "in-flight" });
  });

  it("says nothing about an item with neither a prerequisite nor an overlap", () => {
    const sibling = item(1, "plan-gate");
    const verdicts = resolveBaseAdvanceVerdicts(
      [sibling],
      REPO_KEY,
      evidence({
        changedFiles: ["src/elsewhere.ts"],
        plans: new Map([[sibling.id, facts(planWith(["src/a.ts"]))]]),
      }),
    );
    expect(verdicts).toEqual([]);
  });

  it("prefers the prerequisite rung over the overlap rung", () => {
    const dependent = item(1, "plan-gate", { blockedBy: [ref(9)] });
    const verdicts = resolveBaseAdvanceVerdicts(
      [dependent],
      REPO_KEY,
      evidence({
        changedFiles: ["src/a.ts"],
        plans: new Map([[dependent.id, facts(planWith(["src/a.ts"]))]]),
      }),
    );
    expect(verdicts[0]).toMatchObject({ action: "replan", overlapFiles: ["src/a.ts"] });
  });

  it("skips triage, planning and pr-open items", () => {
    const skipped: LifecycleState[] = ["triage", "planning", "pr-open", "in-review", "merged"];
    const items = skipped.map((state, i) => item(i + 1, state, { blockedBy: [ref(9)] }));
    const plans = new Map(items.map((i) => [i.id, facts(planWith(["src/a.ts"]))]));
    expect(resolveBaseAdvanceVerdicts(items, REPO_KEY, evidence({ plans }))).toEqual([]);
  });

  it("skips an item with no stored plan facts", () => {
    const sibling = item(1, "plan-gate", { blockedBy: [ref(9)] });
    expect(resolveBaseAdvanceVerdicts([sibling], REPO_KEY, evidence())).toEqual([]);
  });

  it("skips items on another repo", () => {
    const foreign = item(1, "plan-gate", { repo: OTHER_REPO, blockedBy: [ref(9)] });
    const verdicts = resolveBaseAdvanceVerdicts(
      [foreign],
      REPO_KEY,
      evidence({ plans: new Map([[foreign.id, facts(planWith(["src/a.ts"]))]]) }),
    );
    expect(verdicts).toEqual([]);
  });

  it("does not match a prerequisite that merged on another tracker", () => {
    const dependent = item(1, "plan-gate", { blockedBy: [ref(9)] });
    const verdicts = resolveBaseAdvanceVerdicts(
      [dependent],
      REPO_KEY,
      evidence({
        merged: [{ source: "jira", sourceRef: ref(9), key: "9" }],
        plans: new Map([[dependent.id, facts(planWith(["src/a.ts"]))]]),
      }),
    );
    expect(verdicts).toEqual([]);
  });
});

describe("reactToMergedItems", () => {
  it("replans a dependent released to plan-gate by the merge", async () => {
    const merged = item(9, "merged");
    const dependent = item(1, "plan-gate", { blockedBy: [ref(9)] });
    const h = makeHarness({
      items: [merged, dependent],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.requestTransition).toHaveBeenCalledWith(
      "github:1",
      "planning",
      "reconcile",
      "9 merged — replanning on the new base",
    );
    expect(h.setBaseAdvance).not.toHaveBeenCalled();
  });

  it("warns a hand-edited dependent instead of replanning it", async () => {
    const dependent = item(1, "plan-gate", { blockedBy: [ref(9)] });
    const h = makeHarness({
      items: [item(9, "merged"), dependent],
      plans: { "plan-1": stored(planWith(["src/a.ts"]), { editedAt: "2026-08-02T00:00:00.000Z" }) },
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.requestTransition).not.toHaveBeenCalled();
    expect(h.setBaseAdvance).toHaveBeenCalledWith("github:1", {
      at: "2026-08-07T12:00:00.000Z",
      mergedKeys: ["9"],
      overlapFiles: [],
      reason: "edited-plan",
    });
  });

  it("warns an in-flight dependent without touching its worktree", async () => {
    const dependent = item(1, "human-review", { blockedBy: [ref(9)] });
    const h = makeHarness({
      items: [item(9, "merged"), dependent],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.requestTransition).not.toHaveBeenCalled();
    expect(h.setBaseAdvance.mock.calls[0][1]).toMatchObject({ reason: "in-flight" });
  });

  it("replans an overlapping sibling once the probe finds new misses", async () => {
    const sibling = item(1, "plan-gate");
    const h = makeHarness({
      items: [item(9, "merged"), sibling],
      changed: ["src/a.ts"],
      plans: {
        "plan-1": stored(planWith(["src/a.ts"]), {
          confidence: {
            version: 1,
            composite: 0.8,
            weights: { convergence: 0.2, critic: 0.7, clarity: 0.1 },
            signals: { groundedness: groundedness() },
            errors: [],
            computedAt: "2026-08-01T00:00:00.000Z",
          },
        }),
      },
      scoreGroundedness: async () => groundedness({ missingFiles: ["src/a.ts"] }),
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.requestTransition).toHaveBeenCalledWith(
      "github:1",
      "planning",
      "reconcile",
      "9 merged — replanning on the new base",
    );
    expect(h.setBaseAdvance).not.toHaveBeenCalled();
  });

  it("warns with the overlap when the probe finds nothing new", async () => {
    const sibling = item(1, "plan-gate");
    const h = makeHarness({
      items: [item(9, "merged"), sibling],
      changed: ["src/a.ts", "src/b.ts"],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.requestTransition).not.toHaveBeenCalled();
    expect(h.setBaseAdvance).toHaveBeenCalledWith("github:1", {
      at: "2026-08-07T12:00:00.000Z",
      mergedKeys: ["9"],
      overlapFiles: ["src/a.ts"],
      reason: "overlap",
    });
  });

  it("keeps a hand-edited plan at a warning even when the probe finds misses", async () => {
    const sibling = item(1, "plan-gate");
    const h = makeHarness({
      items: [item(9, "merged"), sibling],
      changed: ["src/a.ts"],
      plans: {
        "plan-1": stored(planWith(["src/a.ts"]), {
          revisions: [
            { plan: planWith(["src/a.ts"]), at: "2026-08-02T00:00:00.000Z", source: "inline-edit" },
          ],
        }),
      },
      scoreGroundedness: async () =>
        groundedness({ missingFiles: ["src/a.ts"], missingSymbols: ["gone"] }),
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.requestTransition).not.toHaveBeenCalled();
    expect(h.setBaseAdvance).toHaveBeenCalledWith("github:1", {
      at: "2026-08-07T12:00:00.000Z",
      mergedKeys: ["9"],
      overlapFiles: ["src/a.ts"],
      newMisses: { files: ["src/a.ts"], symbols: ["gone"] },
      reason: "edited-plan",
    });
  });

  it("stays silent on an unrelated item", async () => {
    const sibling = item(1, "plan-gate");
    const h = makeHarness({
      items: [item(9, "merged"), sibling],
      changed: ["src/elsewhere.ts"],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.requestTransition).not.toHaveBeenCalled();
    expect(h.setBaseAdvance).not.toHaveBeenCalled();
    expect(h.addWorktree).not.toHaveBeenCalled();
  });

  it("skips the diff and every textual verdict when no base sha was ever observed", async () => {
    const sibling = item(1, "plan-gate");
    const h = makeHarness({
      items: [item(9, "merged"), sibling],
      baseSha: null,
      changed: ["src/a.ts"],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.diffNames).not.toHaveBeenCalled();
    expect(h.setBaseAdvance).not.toHaveBeenCalled();
    expect(h.links.repos[REPO_KEY].baseSha).toBe("sha-new");
  });

  it("diffs the observed base sha against the fresh one and advances it", async () => {
    const h = makeHarness({ items: [item(9, "merged")] });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.diffNames).toHaveBeenCalledWith("/clones/rocket", "sha-old", "sha-new");
    expect(h.links.repos[REPO_KEY].baseSha).toBe("sha-new");
    expect(h.saveRepoLinks).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite the links file when the base did not move", async () => {
    const h = makeHarness({ items: [item(9, "merged")], baseSha: "sha-new" });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.diffNames).not.toHaveBeenCalled();
    expect(h.saveRepoLinks).not.toHaveBeenCalled();
  });

  it("creates the probe worktree only when a verdict needs it, and removes it after", async () => {
    const h = makeHarness({
      items: [item(9, "merged"), item(1, "plan-gate")],
      changed: ["src/a.ts"],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.addWorktree).toHaveBeenCalledWith(
      "/clones/rocket",
      "/worktrees/_base-advance/acme-rocket",
      "sha-new",
    );
    expect(h.scoreGroundedness).toHaveBeenCalledWith(
      expect.anything(),
      "/worktrees/_base-advance/acme-rocket",
    );
    // Scoring runs outside the lock the worktree was created under; the removal
    // takes the lock again.
    expect(h.order).toEqual([
      "lock-enter acme/rocket",
      "worktree-add",
      "lock-exit acme/rocket",
      "score /worktrees/_base-advance/acme-rocket",
      "lock-enter acme/rocket",
      "worktree-remove",
      "lock-exit acme/rocket",
    ]);
  });

  it("removes the probe worktree even when scoring blows up", async () => {
    const h = makeHarness({
      items: [item(9, "merged"), item(1, "plan-gate")],
      changed: ["src/a.ts"],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
      scoreGroundedness: async () => {
        throw new Error("repoPath is not a directory");
      },
    });
    initBaseAdvance(h.deps);

    await expect(reactToMergedItems(REPO_KEY, ["github:9"])).resolves.toBeUndefined();

    expect(h.removeWorktree).toHaveBeenCalledTimes(1);
    expect(h.requestTransition).not.toHaveBeenCalled();
    expect(h.setBaseAdvance).not.toHaveBeenCalled();
  });

  it("degrades a probe to a plain warning when the worktree cannot be created", async () => {
    const h = makeHarness({
      items: [item(9, "merged"), item(1, "plan-gate")],
      changed: ["src/a.ts"],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
      addWorktree: async () => {
        throw new Error("worktree add failed");
      },
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.scoreGroundedness).not.toHaveBeenCalled();
    expect(h.removeWorktree).not.toHaveBeenCalled();
    expect(h.setBaseAdvance.mock.calls[0][1]).toMatchObject({ reason: "overlap" });
  });

  it("swallows a git failure — the poll loop must survive it", async () => {
    const h = makeHarness({
      items: [item(9, "merged"), item(1, "plan-gate", { blockedBy: [ref(9)] })],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
      revParse: async () => {
        throw new Error("not a git repository");
      },
    });
    initBaseAdvance(h.deps);

    await expect(reactToMergedItems(REPO_KEY, ["github:9"])).resolves.toBeUndefined();

    expect(h.requestTransition).not.toHaveBeenCalled();
    expect(h.setBaseAdvance).not.toHaveBeenCalled();
    expect(h.saveRepoLinks).not.toHaveBeenCalled();
  });

  it("swallows a failed transition", async () => {
    const h = makeHarness({
      items: [item(9, "merged"), item(1, "plan-gate", { blockedBy: [ref(9)] })],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
    });
    h.requestTransition.mockRejectedValue(new Error("illegal transition"));
    initBaseAdvance(h.deps);

    await expect(reactToMergedItems(REPO_KEY, ["github:9"])).resolves.toBeUndefined();
  });

  it("does nothing when the repo is not linked", async () => {
    const h = makeHarness({
      items: [item(9, "merged"), item(1, "plan-gate", { blockedBy: [ref(9)] })],
      plans: { "plan-1": stored(planWith(["src/a.ts"])) },
      linked: false,
    });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.diffNames).not.toHaveBeenCalled();
    expect(h.requestTransition).not.toHaveBeenCalled();
  });

  it("does nothing when none of the merged items belong to the repo", async () => {
    const h = makeHarness({ items: [item(9, "merged", { repo: OTHER_REPO })] });
    initBaseAdvance(h.deps);

    await reactToMergedItems(REPO_KEY, ["github:9"]);

    expect(h.diffNames).not.toHaveBeenCalled();
    expect(h.saveRepoLinks).not.toHaveBeenCalled();
  });

  it("is inert before init", async () => {
    initBaseAdvance(undefined as unknown as BaseAdvanceDeps);
    await expect(reactToMergedItems(REPO_KEY, ["github:9"])).resolves.toBeUndefined();
  });
});

describe("reactToMerges", () => {
  it("reacts once per repo the merges belong to", async () => {
    const h = makeHarness({
      items: [item(9, "merged"), item(8, "merged", { repo: OTHER_REPO, id: "github:8" })],
    });
    initBaseAdvance(h.deps);

    await reactToMerges(["github:9", "github:8"]);

    // Only acme/rocket is linked, so acme/anvil resolves to no link and stops.
    expect(h.order.filter((o) => o === "lock-enter acme/rocket")).toHaveLength(1);
    expect(h.saveRepoLinks).toHaveBeenCalledTimes(1);
  });

  it("does nothing without merged ids", async () => {
    const h = makeHarness({ items: [item(9, "merged")] });
    initBaseAdvance(h.deps);

    await reactToMerges([]);
    expect(h.saveRepoLinks).not.toHaveBeenCalled();
  });
});
