import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveRepoOrchestratorSettings,
  type CodingEvent,
  type IssuePlan,
  type LifecycleState,
  type RepoIntakeSettings,
  type StoredPlan,
  type TrackedItem,
  type TransitionActor,
} from "@skipper/shared";
import type { RunCodingAgentOptions, CodingRunResult, OrchestratorSettings } from "@skipper/core";
import { DEFAULT_ORCHESTRATOR_SETTINGS, CodingAbortError } from "@skipper/core";
import { initCoder, pokeCoder, cancelCodingRun, type CoderDeps } from "./coder";

const plan: IssuePlan = {
  summary: "do the thing",
  files: [],
  steps: [],
  acceptance: [],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
};

function storedPlanFor(item: TrackedItem): StoredPlan {
  return {
    version: 2,
    itemId: item.id,
    repo: item.repo,
    issueNumber: item.number,
    generatedAt: "2026-07-13T00:00:00.000Z",
    model: "opus",
    plan,
  };
}

function makeItem(n: number, state: LifecycleState, repoName = "repo"): TrackedItem {
  return {
    id: `github:${n}`,
    source: "github",
    sourceRef: { project: `owner/${repoName}`, key: String(n) },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "owner", name: repoName },
    key: String(n),
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/owner/${repoName}/issues/${n}`,
    state,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    transitions: [
      { at: `2026-07-13T00:00:0${n % 10}.000Z`, from: "plan-gate", to: "queued", actor: "user" },
    ],
  };
}

interface Harness {
  items: Map<string, TrackedItem>;
  deps: CoderDeps;
  transitions: {
    itemId: string;
    to: LifecycleState;
    actor: TransitionActor;
    reason?: string;
    resumeTo?: LifecycleState;
  }[];
  worktreeWrites: { itemId: string; sessionId?: string }[];
  events: { itemId: string; event: CodingEvent }[];
}

function makeHarness(
  overrides: Partial<CoderDeps> = {},
  repoSettings: RepoIntakeSettings = {},
): Harness {
  const items = new Map<string, TrackedItem>();
  const transitions: Harness["transitions"] = [];
  const worktreeWrites: Harness["worktreeWrites"] = [];
  const events: Harness["events"] = [];
  const deps: CoderDeps = {
    listItems: () => [...items.values()],
    getItem: (id) => items.get(id),
    getIssue: () => undefined,
    getPlan: async (item) => storedPlanFor(item),
    requestTransition: async (itemId, to, actor, reason, resumeTo) => {
      transitions.push({ itemId, to, actor, reason, resumeTo });
      const item = items.get(itemId)!;
      const next = { ...item, state: to, transitions: [...item.transitions, { at: new Date().toISOString(), from: item.state, to, actor }] };
      items.set(itemId, next);
      return next;
    },
    setWorktree: async (itemId, worktree) => {
      worktreeWrites.push({ itemId, sessionId: worktree.sessionId });
      const item = items.get(itemId)!;
      items.set(itemId, { ...item, worktree });
    },
    prepareWorktree: async (item) => ({
      path: `/wt/${item.repo.name}/issue-${item.number}`,
      branch: `feature/issue-${item.number}`,
    }),
    getSettings: () => DEFAULT_ORCHESTRATOR_SETTINGS as OrchestratorSettings,
    getRepoPriority: () => "normal",
    // Defaults to the global setting so existing WIP tests (which override
    // getSettings) keep working; a test can still override this directly.
    getRepoWipLimit: () => Math.max(1, deps.getSettings().codingWipPerRepo ?? 1),
    // Same reasoning: resolve against the live global bag, so a test that only
    // overrides getSettings still sees its coderModel (#58).
    getRepoSettings: () => resolveRepoOrchestratorSettings(repoSettings, deps.getSettings()),
    emitEvent: (itemId, event) => events.push({ itemId, event }),
    ...overrides,
  };
  return { items, deps, transitions, worktreeWrites, events };
}

function okRunner(summary = "all done") {
  return vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
    opts.onEvent({ kind: "result", ok: true, summary });
    return { ok: true, summary, sessionId: opts.sessionId ?? opts.resumeSessionId ?? "" };
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  initCoder(makeHarness().deps); // reset module state; each test re-inits
});

describe("coder driver", () => {
  it("runs a queued item through coding to agent-review", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runner);
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "agent-review"]);
    expect(h.transitions[1].actor).toBe("coder");
    expect(h.transitions[1].reason).toBe("all done");
    // worktree + session persisted BEFORE the runner started
    expect(h.worktreeWrites).toHaveLength(1);
    expect(h.worktreeWrites[0].sessionId).toBeTruthy();
    expect(runner).toHaveBeenCalledOnce();
    const opts = runner.mock.calls[0][0];
    expect(opts.cwd).toBe("/wt/repo/issue-1");
    expect(opts.sessionId).toBe(h.worktreeWrites[0].sessionId);
    expect(opts.resumeSessionId).toBeUndefined();
  });

  // #58: the model reaches the runner from the resolved per-repo bag.
  it("hands the runner the global coderModel when the repo has no override", async () => {
    const h = makeHarness({
      getSettings: () =>
        ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, coderModel: "sonnet" }) as OrchestratorSettings,
    });
    const runner = okRunner();
    initCoder(h.deps, runner);
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(runner.mock.calls[0][0].model).toBe("sonnet");
  });

  it("lets a per-repo coderModel override the global", async () => {
    const h = makeHarness(
      {
        getSettings: () =>
          ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, coderModel: "sonnet" }) as OrchestratorSettings,
      },
      { coderModel: "haiku" },
    );
    const runner = okRunner();
    initCoder(h.deps, runner);
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(runner.mock.calls[0][0].model).toBe("haiku");
  });

  it("enforces WIP 1 per repo, FIFO by queued time", async () => {
    const h = makeHarness();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
      order.push(opts.cwd);
      await gate;
      return { ok: true, summary: "done", sessionId: opts.sessionId ?? "" };
    });
    initCoder(h.deps, runner);
    h.items.set("github:2", makeItem(2, "queued"));
    h.items.set("github:1", makeItem(1, "queued"));
    h.items.set("github:3", makeItem(3, "queued", "other"));

    pokeCoder();
    await settle();

    // one run per repo: issue-1 (earlier queued time) + issue-3 (other repo)
    expect(order).toEqual(["/wt/repo/issue-1", "/wt/other/issue-3"]);
    expect(h.items.get("github:2")!.state).toBe("queued");

    release();
    await settle();
    // repo freed → issue-2 runs
    expect(order).toContain("/wt/repo/issue-2");
  });

  it("reads the WIP limit from settings", async () => {
    const h = makeHarness({
      getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, codingWipPerRepo: 2 }),
    });
    const order: string[] = [];
    const gate = new Promise<void>(() => {});
    initCoder(
      h.deps,
      vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        order.push(opts.cwd);
        await gate;
        return { ok: true, summary: "done", sessionId: opts.sessionId ?? "" };
      }),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    h.items.set("github:2", makeItem(2, "queued"));
    h.items.set("github:3", makeItem(3, "queued"));

    pokeCoder();
    await settle();

    // limit 2: two runs in the same repo, third waits
    expect(order).toEqual(["/wt/repo/issue-1", "/wt/repo/issue-2"]);
    expect(h.items.get("github:3")!.state).toBe("queued");
  });

  it("pinned item jumps an older queued item in the same repo", async () => {
    const h = makeHarness();
    const order: string[] = [];
    const gate = new Promise<void>(() => {});
    initCoder(
      h.deps,
      vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        order.push(opts.cwd);
        await gate;
        return { ok: true, summary: "done", sessionId: opts.sessionId ?? "" };
      }),
    );
    h.items.set("github:1", makeItem(1, "queued")); // older queued time
    h.items.set("github:2", { ...makeItem(2, "queued"), pinned: true });

    pokeCoder();
    await settle();

    expect(order).toEqual(["/wt/repo/issue-2"]);
    expect(h.items.get("github:1")!.state).toBe("queued");
  });

  it("repo priority orders queue admission across repos", async () => {
    const h = makeHarness({
      getRepoPriority: (repo) => (repo.name === "important" ? "high" : "normal"),
    });
    const order: string[] = [];
    initCoder(
      h.deps,
      vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        order.push(opts.cwd);
        return { ok: true, summary: "done", sessionId: opts.sessionId ?? "" };
      }),
    );
    h.items.set("github:1", makeItem(1, "queued")); // older, normal-priority repo
    h.items.set("github:2", makeItem(2, "queued", "important"));

    pokeCoder();
    await settle();

    expect(order[0]).toBe("/wt/important/issue-2");
  });

  it("re-entry takes the repo slot before an older queued item", async () => {
    const h = makeHarness();
    const order: string[] = [];
    const gate = new Promise<void>(() => {});
    initCoder(
      h.deps,
      vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        order.push(opts.cwd);
        await gate;
        return { ok: true, summary: "done", sessionId: opts.sessionId ?? opts.resumeSessionId ?? "" };
      }),
    );
    h.items.set("github:1", makeItem(1, "queued")); // queued earlier than the re-entry
    h.items.set("github:2", {
      ...makeItem(2, "coding"),
      worktree: { path: "/wt/repo/issue-2", branch: "feature/issue-2", sessionId: "s2" },
      shepherd: { pendingReviewComments: [{ body: "fix it" }] },
    });

    pokeCoder();
    await settle();

    expect(order).toEqual(["/wt/repo/issue-2"]);
    expect(h.items.get("github:1")!.state).toBe("queued");
  });

  it("missing plan lands on needs-input", async () => {
    const h = makeHarness({ getPlan: async () => null });
    initCoder(h.deps, okRunner());
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "needs-input"]);
    expect(h.transitions[1].reason).toMatch(/no stored plan/);
    expect(h.transitions[1].resumeTo).toBe("planning");
  });

  it("worktree failure lands on needs-input", async () => {
    const h = makeHarness({
      prepareWorktree: async () => {
        throw new Error("branch checked out elsewhere");
      },
    });
    initCoder(h.deps, okRunner());
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "needs-input"]);
    expect(h.transitions[1].reason).toMatch(/worktree setup failed: branch checked out/);
    expect(h.transitions[1].resumeTo).toBe("queued");
  });

  it("runner failure lands on failed", async () => {
    const h = makeHarness();
    initCoder(
      h.deps,
      vi.fn(async () => {
        throw new Error("agent exploded");
      }),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "failed"]);
    expect(h.transitions[1].reason).toMatch(/agent exploded/);
  });

  it("non-ok result lands on failed", async () => {
    const h = makeHarness();
    initCoder(
      h.deps,
      vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => ({
        ok: false,
        summary: "hit max turns",
        sessionId: opts.sessionId ?? "",
      })),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "failed"]);
    expect(h.transitions[1].reason).toMatch(/hit max turns/);
  });

  it("makes no transition when the item is moved mid-run", async () => {
    const h = makeHarness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    initCoder(
      h.deps,
      vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        await gate;
        return { ok: true, summary: "done", sessionId: opts.sessionId ?? "" };
      }),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();

    // user moves it away mid-run
    const item = h.items.get("github:1")!;
    h.items.set("github:1", { ...item, state: "blocked" });
    release();
    await settle();

    expect(h.transitions.map((t) => t.to)).toEqual(["coding"]);
  });

  it("aborted run makes no transition", async () => {
    const h = makeHarness();
    initCoder(
      h.deps,
      vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        return new Promise((_res, rej) => {
          opts.signal?.addEventListener("abort", () => rej(new CodingAbortError()));
        });
      }),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();

    cancelCodingRun("github:1");
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding"]);
  });

  it("crash recovery resumes a coding item with its persisted session", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runner);
    const item = makeItem(1, "coding");
    h.items.set("github:1", {
      ...item,
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "old-session" },
    });

    pokeCoder();
    await settle();

    const opts = runner.mock.calls[0][0];
    expect(opts.resumeSessionId).toBe("old-session");
    expect(opts.sessionId).toBeUndefined();
    expect(opts.prompt).toMatch(/interrupted/);
    expect(h.transitions.map((t) => t.to)).toEqual(["agent-review"]);
  });

  it("dead --resume retries once with a fresh session", async () => {
    const h = makeHarness();
    const runner = vi
      .fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        if (opts.resumeSessionId) throw new Error("No conversation found");
        opts.onEvent({ kind: "result", ok: true, summary: "fresh run done" });
        return { ok: true, summary: "fresh run done", sessionId: opts.sessionId ?? "" };
      });
    initCoder(h.deps, runner);
    const item = makeItem(1, "coding");
    h.items.set("github:1", {
      ...item,
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "dead-session" },
    });

    pokeCoder();
    await settle();

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][0].sessionId).toBeTruthy();
    expect(runner.mock.calls[1][0].sessionId).not.toBe("dead-session");
    expect(h.transitions.map((t) => t.to)).toEqual(["agent-review"]);
    // fresh session persisted for the retry
    expect(h.worktreeWrites.at(-1)!.sessionId).toBe(runner.mock.calls[1][0].sessionId);
  });

  it("fix round uses the fix prompt on a resumed session", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runner);
    const item = makeItem(1, "coding");
    h.items.set("github:1", {
      ...item,
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "old-session" },
      review: {
        rounds: 1,
        outcome: "reject",
        pendingObjections: [
          { kind: "acceptance-gap", detail: "criterion not met", blocking: true },
        ],
        at: "2026-07-13T00:00:00.000Z",
      },
    });

    pokeCoder();
    await settle();

    const opts = runner.mock.calls[0][0];
    expect(opts.resumeSessionId).toBe("old-session");
    expect(opts.prompt).toContain("independent reviewer");
    expect(opts.prompt).toContain("[BLOCKING] (acceptance-gap) criterion not met");
    expect(opts.prompt).not.toMatch(/interrupted/);
  });

  it("PR fix round (#11) uses the PR fix prompt and outranks stale critic objections", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runner);
    const item = makeItem(1, "coding");
    h.items.set("github:1", {
      ...item,
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "old-session" },
      review: {
        rounds: 1,
        outcome: "reject",
        pendingObjections: [{ kind: "risk", detail: "stale objection", blocking: false }],
        at: "2026-07-13T00:00:00.000Z",
      },
      shepherd: {
        pendingReviewComments: [
          { author: "rev", path: "src/a.ts", line: 3, body: "rename this" },
        ],
      },
    });

    pokeCoder();
    await settle();

    const opts = runner.mock.calls[0][0];
    expect(opts.resumeSessionId).toBe("old-session");
    expect(opts.prompt).toContain("requested changes on the pull request");
    expect(opts.prompt).toContain("- rev on src/a.ts:3: rename this");
    expect(opts.prompt).not.toContain("stale objection");
    expect(h.transitions.map((t) => t.to)).toEqual(["agent-review"]);
  });

  it("PR re-entry in coding state counts toward the per-repo WIP limit", async () => {
    const h = makeHarness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
      await gate;
      return { ok: true, summary: "done", sessionId: opts.sessionId ?? opts.resumeSessionId ?? "" };
    });
    initCoder(h.deps, runner);
    // Re-entered item occupies the repo's single slot...
    h.items.set("github:1", {
      ...makeItem(1, "coding"),
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "s1" },
      shepherd: { pendingReviewComments: [{ body: "fix it" }] },
    });
    // ...so this queued item in the same repo must wait.
    h.items.set("github:2", makeItem(2, "queued"));

    pokeCoder();
    await settle();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(h.items.get("github:2")!.state).toBe("queued");

    release();
    await settle();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("fix round dead-resume retry keeps the fix prompt", async () => {
    const h = makeHarness();
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
      if (opts.resumeSessionId) throw new Error("No conversation found");
      return { ok: true, summary: "fixed", sessionId: opts.sessionId ?? "" };
    });
    initCoder(h.deps, runner);
    const item = makeItem(1, "coding");
    h.items.set("github:1", {
      ...item,
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "dead-session" },
      review: {
        rounds: 1,
        outcome: "reject",
        pendingObjections: [
          { kind: "acceptance-gap", detail: "criterion not met", blocking: true },
        ],
        at: "2026-07-13T00:00:00.000Z",
      },
    });

    pokeCoder();
    await settle();

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][0].prompt).toContain("independent reviewer");
    expect(h.transitions.map((t) => t.to)).toEqual(["agent-review"]);
  });
});
