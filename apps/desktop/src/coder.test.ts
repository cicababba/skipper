import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_MAX_TURNS_BACKSTOP,
  DEFAULT_LLM_SETTINGS,
  resolveRepoOrchestratorSettings,
  type AgentRuntimeId,
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
  AgentRuntime,
  RunCodingAgentOptions,
  CodingRunResult,
  LLMProviderInterface,
  OrchestratorSettings,
} from "@skipper/core";
import { DEFAULT_ORCHESTRATOR_SETTINGS, CodingAbortError, CodingTimeoutError } from "@skipper/core";
import { initCoder, pokeCoder, cancelCodingRun, type CoderDeps } from "./coder";

/** The coding run moved behind AgentRuntime (#238): wrap the fake runner so its
 *  .mock stays the assertion surface. Claude-cli capabilities keep resume/salvage on. */
function runtimeOf(
  runCoding: (opts: RunCodingAgentOptions) => Promise<CodingRunResult>,
  id: AgentRuntimeId = "claude-cli",
): AgentRuntime {
  return {
    id,
    capabilities: {
      streaming: true,
      resume: true,
      confinement: "rules",
      mcp: true,
      images: true,
      pdfs: true,
    },
    runCoding,
    agent: vi.fn(),
    structured: vi.fn(),
  } as unknown as AgentRuntime;
}
import { reportFileName, writeStoredCoderReport } from "./report-store";

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
    getRepoPath: () => "/repo",
    checkoutDirtyPaths: async () => null,
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
    getRepoInstructions: async () => undefined,
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
    initCoder(h.deps, runtimeOf(runner));
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

  it("asks for a base refresh, so a reused worktree codes on the fresh base", async () => {
    const asked: ({ refreshBase?: boolean } | undefined)[] = [];
    const h = makeHarness();
    h.deps.prepareWorktree = async (item, opts) => {
      asked.push(opts);
      return {
        path: `/wt/${item.repo.name}/issue-${item.number}`,
        branch: `feature/issue-${item.number}`,
      };
    };
    initCoder(h.deps, runtimeOf(okRunner()));
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(asked).toEqual([{ refreshBase: true }]);
  });

  // #125: with no per-role or global override, the resolved coderModel floors to the
  // llm.claudeModel default ("sonnet"), which is what the runner's direct-model path uses.
  it("hands the runner the default model when nothing overrides coderModel", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runtimeOf(runner));
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(runner.mock.calls[0][0].model).toBe("sonnet");
  });

  // #58: the model reaches the runner from the resolved per-repo bag.
  it("hands the runner the global coder pair's model when the repo has no override", async () => {
    const h = makeHarness({
      getSettings: () =>
        ({
          ...DEFAULT_ORCHESTRATOR_SETTINGS,
          coderAgent: { runtime: "claude-cli", model: "sonnet" },
        }) as OrchestratorSettings,
    });
    const runner = okRunner();
    initCoder(h.deps, runtimeOf(runner));
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(runner.mock.calls[0][0].model).toBe("sonnet");
  });

  it("lets a per-repo coder pair override the global", async () => {
    const h = makeHarness(
      {
        getSettings: () =>
          ({
            ...DEFAULT_ORCHESTRATOR_SETTINGS,
            coderAgent: { runtime: "claude-cli", model: "sonnet" },
          }) as OrchestratorSettings,
      },
      { coderAgent: { runtime: "claude-cli", model: "haiku" } },
    );
    const runner = okRunner();
    initCoder(h.deps, runtimeOf(runner));
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
    initCoder(h.deps, runtimeOf(runner));
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
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        order.push(opts.cwd);
        await gate;
        return okReport(opts);
      })),
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
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        order.push(opts.cwd);
        await gate;
        return okReport(opts);
      })),
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
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        order.push(opts.cwd);
        return okReport(opts);
      })),
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
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        order.push(opts.cwd);
        await gate;
        return okReport(opts);
      })),
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
    initCoder(h.deps, runtimeOf(okRunner()));
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
    initCoder(h.deps, runtimeOf(okRunner()));
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
      runtimeOf(vi.fn(async () => {
        throw new Error("agent exploded");
      })),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "failed"]);
    expect(h.transitions[1].reason).toMatch(/agent exploded/);
  });

  it("non-ok result without a salvageable subtype lands on failed in one run", async () => {
    const h = makeHarness();
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => ({
      ok: false,
      summary: "hit max turns",
      sessionId: opts.sessionId ?? "",
    }));
    initCoder(h.deps, runtimeOf(runner));
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    // No subtype → not a budget death → no salvage, a single runner call.
    expect(runner).toHaveBeenCalledOnce();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "failed"]);
    expect(h.transitions[1].reason).toMatch(/hit max turns/);
  });

  it("passes the coder time budget as hardTimeoutMs and no maxTurns (#194)", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runtimeOf(runner));
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    const opts = runner.mock.calls[0][0];
    expect(opts.hardTimeoutMs).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.coderTimeBudgetMin * 60_000);
    expect(opts.maxTurns).toBeUndefined();
  });

  it("salvages a hard-timeout death, resuming the run's session for a final report (#194)", async () => {
    const h = makeHarness();
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
      if (opts.resumeSessionId) {
        opts.onEvent({ kind: "result", ok: true, summary: REPORT_JSON });
        return okReport(opts);
      }
      throw new CodingTimeoutError("hard time limit — killed", "hard_timeout", 3_600_000);
    });
    initCoder(h.deps, runtimeOf(runner));
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();

    expect(runner).toHaveBeenCalledTimes(2);
    const salvage = runner.mock.calls[1][0];
    expect(salvage.resumeSessionId).toBe(runner.mock.calls[0][0].sessionId);
    expect(salvage.maxTurns).toBe(4);
    expect(salvage.hardTimeoutMs).toBe(300_000);
    expect(salvage.prompt).toContain("Your FINAL message must be ONLY a single JSON object");
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "agent-review"]);
  });

  it("salvages a max-turns non-ok result on the same path (#194)", async () => {
    const h = makeHarness();
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
      if (opts.resumeSessionId) {
        opts.onEvent({ kind: "result", ok: true, summary: REPORT_JSON });
        return okReport(opts);
      }
      return { ok: false, summary: "", subtype: "error_max_turns", sessionId: opts.sessionId ?? "" };
    });
    initCoder(h.deps, runtimeOf(runner));
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][0].maxTurns).toBe(4);
    expect(runner.mock.calls[1][0].hardTimeoutMs).toBe(300_000);
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "agent-review"]);
  });

  it("fails with the honest time-budget reason when salvage also dies (#194)", async () => {
    const h = makeHarness();
    initCoder(
      h.deps,
      runtimeOf(vi.fn(async (): Promise<CodingRunResult> => {
        throw new CodingTimeoutError("hard time limit — killed", "hard_timeout", 3_600_000);
      })),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "failed"]);
    expect(h.transitions[1].reason).toContain(
      `hit the time budget (${DEFAULT_ORCHESTRATOR_SETTINGS.coderTimeBudgetMin} min)`,
    );
  });

  it("fails with the max-turns backstop reason when a max-turns salvage dies (#194)", async () => {
    const h = makeHarness();
    initCoder(
      h.deps,
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        if (opts.resumeSessionId) throw new Error("no session on disk");
        return { ok: false, summary: "", subtype: "error_max_turns", sessionId: opts.sessionId ?? "" };
      })),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "failed"]);
    expect(h.transitions[1].reason).toContain(`max-turns backstop (${AGENT_MAX_TURNS_BACKSTOP})`);
  });

  it("fails with the no-output reason when an inactivity salvage dies (#194)", async () => {
    const h = makeHarness();
    initCoder(
      h.deps,
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        if (opts.resumeSessionId) throw new Error("no session on disk");
        throw new CodingTimeoutError("no output — killed as hung", "inactivity", 600_000);
      })),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "failed"]);
    expect(h.transitions[1].reason).toMatch(/produced no output for 10 minutes/);
  });

  it("stays silent when the run is cancelled during salvage (#194)", async () => {
    const h = makeHarness();
    initCoder(
      h.deps,
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        if (opts.resumeSessionId) throw new CodingAbortError();
        throw new CodingTimeoutError("hard time limit — killed", "hard_timeout", 3_600_000);
      })),
    );
    h.items.set("github:1", makeItem(1, "queued"));
    pokeCoder();
    await settle();
    // The salvage abort rethrows past the honest-fail branch — no failed transition.
    expect(h.transitions.map((t) => t.to)).toEqual(["coding"]);
  });

  it("makes no transition when the item is moved mid-run", async () => {
    const h = makeHarness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    initCoder(
      h.deps,
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        await gate;
        return okReport(opts);
      })),
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
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        return new Promise((_res, rej) => {
          opts.signal?.addEventListener("abort", () => rej(new CodingAbortError()));
        });
      })),
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
    initCoder(h.deps, runtimeOf(runner));
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
    initCoder(h.deps, runtimeOf(runner));
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

  // #240: the session on disk belongs to the runtime that minted it. After a
  // mid-issue runtime switch there is nothing to resume, but the work is still in
  // the worktree — so the fresh run is seeded with a recap instead of the plain
  // "implement this" prompt that would restart from scratch.
  it("a coder runtime switch starts fresh with a recap, never resuming the other runtime's session", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runtimeOf(runner, "codex-cli"));
    const item = makeItem(1, "coding");
    const ref = reportFileName(item.id);
    await writeStoredCoderReport(plansDir, ref, {
      version: 1,
      itemId: item.id,
      repo: item.repo,
      generatedAt: "2026-07-13T00:00:00.000Z",
      model: "sonnet",
      report: validReport,
    });
    h.items.set("github:1", {
      ...item,
      coderReport: { ref },
      worktree: {
        path: "/wt/repo/issue-1",
        branch: "feature/issue-1",
        sessionId: "claude-session",
        sessionRuntime: "claude-cli",
      },
    });

    pokeCoder();
    await settle();

    const opts = runner.mock.calls[0][0];
    expect(opts.resumeSessionId).toBeUndefined();
    expect(opts.sessionId).toBeTruthy();
    expect(opts.sessionId).not.toBe("claude-session");
    expect(opts.prompt).toContain("already in progress");
    expect(opts.prompt).toContain("Do NOT restart the work from scratch");
    expect(opts.prompt).not.toMatch(/interrupted/);
    // The recap is built from durable artifacts — here, the stored report (#146).
    expect(opts.prompt).toContain("- src/a.ts — did it");
    // The new session is stamped with the runtime that actually minted it.
    expect(h.items.get("github:1")!.worktree!.sessionRuntime).toBe("codex-cli");
    // The feed shows a fresh start, not a resume.
    const phases = h.events
      .map((e) => (e.event.kind === "status" ? e.event.phase : undefined))
      .filter(Boolean);
    expect(phases).toContain("agent-start");
    expect(phases).not.toContain("resuming");
    expect(h.transitions.map((t) => t.to)).toEqual(["agent-review"]);
  });

  // Control case: no prior work in the worktree means no recap to give — the run
  // gets the plain plan prompt it always got.
  it("uses the plain coder prompt when the worktree holds no prior session", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runtimeOf(runner, "codex-cli"));
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    const opts = runner.mock.calls[0][0];
    expect(opts.prompt).toContain("Implement this issue following the plan below.");
    expect(opts.prompt).not.toContain("already in progress");
    expect(opts.resumeSessionId).toBeUndefined();
  });

  // Same reasoning as the switch: once --resume is off the table, the fresh run
  // must still know that work exists in the worktree.
  it("a dead --resume retry carries the recap, not the plain prompt", async () => {
    const h = makeHarness();
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
      if (opts.resumeSessionId) throw new Error("No conversation found");
      opts.onEvent({ kind: "result", ok: true, summary: REPORT_JSON });
      return okReport(opts);
    });
    initCoder(h.deps, runtimeOf(runner));
    const item = makeItem(1, "coding");
    h.items.set("github:1", {
      ...item,
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "dead-session" },
    });

    pokeCoder();
    await settle();

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][0].prompt).toContain("already in progress");
    expect(runner.mock.calls[1][0].prompt).toContain("No report from the previous session survived.");
  });

  it("fix round uses the fix prompt on a resumed session", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runtimeOf(runner));
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
    initCoder(h.deps, runtimeOf(runner));
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
    initCoder(h.deps, runtimeOf(runner));
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
    initCoder(h.deps, runtimeOf(runner));
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
    initCoder(h.deps, runtimeOf(okRunner()));
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
    initCoder(h.deps, runtimeOf(okRunner(JSON.stringify(withDeviation))));
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
    initCoder(h.deps, runtimeOf(runner), rejectingProvider);
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(h.reports).toEqual([
      { itemId: "github:1", reportRef: undefined, reason: "just prose, no JSON here" },
    ]);
    expect(h.items.get("github:1")!.state).toBe("agent-review");
    expect(h.items.get("github:1")!.coderReport).toBeUndefined();
  });

  it("repairs an unparseable report on the coder's runtime, not the completions provider", async () => {
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
    const structured = vi.fn(async () => validReport);
    const runtime = { ...runtimeOf(runner), structured } as unknown as AgentRuntime;
    const rejectingProvider = {
      name: "fake",
      ask: vi.fn(),
      askStructured: vi.fn(async () => {
        throw new Error("the completions provider must not be used");
      }),
    } as unknown as LLMProviderInterface;
    initCoder(h.deps, runtime, rejectingProvider);
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(structured).toHaveBeenCalledOnce();
    expect((structured.mock.calls[0] as unknown as [string, unknown, { tools: string }])[2].tools).toBe("");
    expect(h.reports[0].reportRef).toBe(reportFileName("github:1"));
    expect(h.items.get("github:1")!.coderReport).toEqual({ ref: reportFileName("github:1") });
  });

  it("writes a report on a fix round too", async () => {
    const h = makeHarness();
    initCoder(h.deps, runtimeOf(okRunner()));
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

// #178: a zombie run (untrack -> re-admit) must not land on the fresh lifecycle,
// and overlapping scans must not breach a per-repo WIP limit.
describe("coder stale-run token + WIP reservation (#178)", () => {
  it("refuses to complete a run whose coding token was superseded (B3)", async () => {
    const h = makeHarness();
    // Two gates: the first (zombie) run parks on gate1, the re-admitted run that
    // the finally-rescan starts parks on gate2 — so releasing gate1 exercises the
    // zombie's completion in isolation.
    let releaseZombie: () => void = () => {};
    const gate1 = new Promise<void>((r) => (releaseZombie = r));
    const gate2 = new Promise<void>(() => {});
    let call = 0;
    initCoder(
      h.deps,
      runtimeOf(vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
        await (++call === 1 ? gate1 : gate2);
        return okReport(opts);
      })),
    );
    // In coding, with a coding transition that is this run's token.
    h.items.set("github:1", {
      ...makeItem(1, "coding"),
      worktree: { path: "/wt/repo/issue-1", branch: "feature/issue-1", sessionId: "s1" },
      transitions: [{ at: "2026-07-13T00:00:00.000Z", from: "queued", to: "coding", actor: "coder" }],
    });

    pokeCoder();
    await settle();

    // Untrack -> re-admit: a newer coding transition supersedes the run's token.
    const cur = h.items.get("github:1")!;
    h.items.set("github:1", {
      ...cur,
      transitions: [
        ...cur.transitions,
        { at: "2026-07-13T02:00:00.000Z", from: "queued", to: "coding", actor: "coder" },
      ],
    });

    releaseZombie();
    await settle();

    // The zombie completion is refused; the re-admitted run (parked on gate2) has
    // not completed either, so nothing landed on the fresh lifecycle.
    expect(h.reports).toEqual([]);
    expect(call).toBe(2); // the finally-rescan started the fresh run
    expect(h.items.get("github:1")!.state).toBe("coding");
  });

  it("reserves the repo slot before the transition await so overlapping scans can't breach WIP=1 (B4)", async () => {
    const h = makeHarness();
    let releaseTransition: () => void = () => {};
    const transitionGate = new Promise<void>((r) => (releaseTransition = r));
    const transitionCalls: string[] = [];
    const origRT = h.deps.requestTransition;
    h.deps.requestTransition = async (itemId, to, actor, reason, resumeTo) => {
      transitionCalls.push(itemId);
      await transitionGate; // park every admission so a second scan can race in
      return origRT(itemId, to, actor, reason, resumeTo);
    };
    const held = new Promise<void>(() => {}); // runner never resolves — holds the slot
    const runner = vi.fn(async (opts: RunCodingAgentOptions): Promise<CodingRunResult> => {
      await held;
      return okReport(opts);
    });
    initCoder(h.deps, runtimeOf(runner));
    h.items.set("github:1", makeItem(1, "queued"));
    h.items.set("github:2", makeItem(2, "queued")); // same repo

    pokeCoder();
    await settle();
    pokeCoder(); // overlapping scan while the first admission is still parked
    await settle();

    releaseTransition();
    await settle();

    // The overlapping scan saw the reservation and admitted nothing more: exactly
    // one transition requested, one run, the second queued item still waiting.
    expect(transitionCalls).toEqual(["github:1"]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(h.items.get("github:2")!.state).toBe("queued");
  });
});

// #196: the run must never touch the linked repo checkout. The post-run tripwire
// diffs the checkout's dirty set before vs after and fails on anything new.
describe("coder confinement tripwire (#196)", () => {
  it("hands the runner a confinement scoped to the worktree with the checkout denied", async () => {
    const h = makeHarness();
    const runner = okRunner();
    initCoder(h.deps, runtimeOf(runner));
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    const conf = runner.mock.calls[0][0].confinement!;
    expect(conf.runRoot).toBe("/wt/repo/issue-1");
    expect(conf.denyRoots).toEqual(["/repo"]);
    // #278: the guard's Bash branch confines writes to the run root within these.
    expect(conf.protectRoots).toEqual([homedir()]);
  });

  it("fails the run and skips completeCoding when the run left new dirt in the checkout", async () => {
    let calls = 0;
    const h = makeHarness({
      checkoutDirtyPaths: async () => (calls++ === 0 ? [] : ["?? stray.ts"]),
    });
    initCoder(h.deps, runtimeOf(okRunner()));
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "failed"]);
    expect(h.transitions[1].reason).toMatch(/escaped the worktree/);
    expect(h.reports).toEqual([]);
    expect(h.items.get("github:1")!.state).toBe("failed");
  });

  it("does not trip on pre-existing checkout dirt the run didn't grow", async () => {
    const h = makeHarness({ checkoutDirtyPaths: async () => [" M existing.ts"] });
    initCoder(h.deps, runtimeOf(okRunner()));
    h.items.set("github:1", makeItem(1, "queued"));

    pokeCoder();
    await settle();

    expect(h.transitions.map((t) => t.to)).toEqual(["coding", "agent-review"]);
  });
});
