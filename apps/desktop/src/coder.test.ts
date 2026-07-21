import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LLM_SETTINGS,
  resolveRepoOrchestratorSettings,
  type CoderReport,
  type CodingEvent,
  type IssuePlan,
  type LifecycleState,
  type RepoIntakeSettings,
  type StoredPlan,
  type TrackedItem,
  type TransitionActor,
} from "@skipper/shared";
import type {
  RunCodingAgentOptions,
  CodingRunResult,
  LLMProviderInterface,
  OrchestratorSettings,
} from "@skipper/core";
import { DEFAULT_ORCHESTRATOR_SETTINGS, CodingAbortError } from "@skipper/core";
import { initCoder, pokeCoder, cancelCodingRun, type CoderDeps } from "./coder";
import { reportFileName } from "./report-store";

const validReport: CoderReport = {
  done: [{ path: "src/a.ts", summary: "did it" }],
  deviations: [],
  verification: [{ command: "pnpm test", passed: true }],
  open: [],
};
const REPORT_JSON = JSON.stringify(validReport);

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
  reports: { itemId: string; reportRef?: string; reason: string }[];
}

let plansDir: string;

function makeHarness(
  overrides: Partial<CoderDeps> = {},
  repoSettings: RepoIntakeSettings = {},
): Harness {
  const items = new Map<string, TrackedItem>();
  const transitions: Harness["transitions"] = [];
  const worktreeWrites: Harness["worktreeWrites"] = [];
  const events: Harness["events"] = [];
  const reports: Harness["reports"] = [];
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
    // Mirrors the orchestrator's completeCoding: agent-review transition +
    // coderReport bookkeeping in one step.
    completeCoding: async (itemId, reportRef, reason) => {
      reports.push({ itemId, reportRef, reason });
      transitions.push({ itemId, to: "agent-review", actor: "coder", reason });
      const item = items.get(itemId)!;
      const { coderReport: _drop, ...rest } = item;
      items.set(itemId, {
        ...rest,
        state: "agent-review",
        ...(reportRef ? { coderReport: { ref: reportRef } } : {}),
        transitions: [
          ...item.transitions,
          { at: new Date().toISOString(), from: item.state, to: "agent-review", actor: "coder" },
        ],
      });
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
    getLlmSettings: async () => ({ ...DEFAULT_LLM_SETTINGS }),
    plansDir,
    ...overrides,
  };
  return { items, deps, transitions, worktreeWrites, events, reports };
}

/** A successful run whose final message is a valid structured report (#146). */
function okRunner(resultText = REPORT_JSON) {
  return vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
    opts.onEvent({ kind: "result", ok: true, summary: resultText });
    return {
      ok: true,
      summary: resultText,
      resultText,
      sessionId: opts.sessionId ?? opts.resumeSessionId ?? "",
    };
  });
}

/** ok result carrying a valid report — for inline runners in ordering tests. */
function okReport(opts: RunCodingAgentOptions): CodingRunResult {
  return {
    ok: true,
    summary: REPORT_JSON,
    resultText: REPORT_JSON,
    sessionId: opts.sessionId ?? opts.resumeSessionId ?? "",
  };
}

async function settle(): Promise<void> {
  // setTimeout (not setImmediate) so the report-store's real fs writes on the
  // libuv threadpool have wall-clock time to land before assertions/afterEach.
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 1));
}

beforeEach(async () => {
  plansDir = await mkdtemp(join(tmpdir(), "nb-coder-plans-"));
  initCoder(makeHarness().deps); // reset module state; each test re-inits
});

afterEach(async () => {
  await rm(plansDir, { recursive: true, force: true });
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
    expect(h.transitions[1].reason).toBe("1 file(s) done");
    // worktree + session persisted BEFORE the runner started
    expect(h.worktreeWrites).toHaveLength(1);
    expect(h.worktreeWrites[0].sessionId).toBeTruthy();
    expect(runner).toHaveBeenCalledOnce();
    const opts = runner.mock.calls[0][0];
    expect(opts.cwd).toBe("/wt/repo/issue-1");
    expect(opts.sessionId).toBe(h.worktreeWrites[0].sessionId);
    expect(opts.resumeSessionId).toBeUndefined();
  });

  // #125: with no per-role or global override, the resolved coderModel floors to the
  // llm.claudeModel default ("sonnet"), which is what the runner's direct-model path uses.
  it("hands the runner the default model when nothing overrides coderModel", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runner);
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(runner.mock.calls[0][0].model).toBe("sonnet");
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
      return okReport(opts);
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
        return okReport(opts);
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
        return okReport(opts);
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
        return okReport(opts);
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
        return okReport(opts);
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
        return okReport(opts);
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
        opts.onEvent({ kind: "result", ok: true, summary: REPORT_JSON });
        return okReport(opts);
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
      return okReport(opts);
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
      return okReport(opts);
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

// #146: the success path parses the final JSON into a structured report,
// persists it, derives the transition reason from it, and degrades to the
// prose summary when the report cannot be recovered.
describe("structured coder report (#146)", () => {
  it("persists a parsed report and derives the reason from it", async () => {
    const h = makeHarness();
    initCoder(h.deps, okRunner());
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    const ref = reportFileName("github:1");
    expect(h.reports).toEqual([{ itemId: "github:1", reportRef: ref, reason: "1 file(s) done" }]);
    expect(h.items.get("github:1")!.coderReport).toEqual({ ref });
    const onDisk = JSON.parse(await readFile(join(plansDir, ref), "utf-8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.report.done[0].path).toBe("src/a.ts");
    expect(onDisk.model).toBe("sonnet");
  });

  it("folds the first deviation into the transition reason", async () => {
    const withDeviation: CoderReport = { ...validReport, deviations: ["renamed foo to bar"] };
    const h = makeHarness();
    initCoder(h.deps, okRunner(JSON.stringify(withDeviation)));
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(h.reports[0].reason).toBe("1 file(s) done — deviation: renamed foo to bar");
  });

  it("degrades to the prose summary when the report is unparseable and repair fails", async () => {
    const h = makeHarness();
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
      opts.onEvent({ kind: "result", ok: true, summary: "just prose, no JSON here" });
      return {
        ok: true,
        summary: "just prose, no JSON here",
        resultText: "just prose, no JSON here",
        sessionId: opts.sessionId ?? "",
      };
    });
    const rejectingProvider = {
      name: "fake",
      ask: vi.fn(),
      askStructured: vi.fn(async () => {
        throw new Error("repair failed");
      }),
    } as unknown as LLMProviderInterface;
    initCoder(h.deps, runner, rejectingProvider);
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(h.reports).toEqual([
      { itemId: "github:1", reportRef: undefined, reason: "just prose, no JSON here" },
    ]);
    expect(h.items.get("github:1")!.state).toBe("agent-review");
    expect(h.items.get("github:1")!.coderReport).toBeUndefined();
  });

  it("writes a report on a fix round too", async () => {
    const h = makeHarness();
    initCoder(h.deps, okRunner());
    h.items.set("github:1", {
      ...makeItem(1, "coding"),
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "old-session" },
      review: {
        rounds: 1,
        outcome: "reject",
        pendingObjections: [{ kind: "acceptance-gap", detail: "criterion not met", blocking: true }],
        at: "2026-07-13T00:00:00.000Z",
      },
    });

    pokeCoder();
    await settle();

    expect(h.reports[0].reportRef).toBe(reportFileName("github:1"));
    expect(h.items.get("github:1")!.coderReport).toEqual({ ref: reportFileName("github:1") });
  });
});
