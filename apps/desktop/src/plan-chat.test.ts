import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodingEvent,
  ConfidenceReport,
  Issue,
  IssuePlan,
  LlmSettings,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { DEFAULT_LLM_SETTINGS, isPlanChatText } from "@skipper/shared";
import { AgentAbortError, type LLMProviderInterface, type LLMResponse } from "@skipper/core";
import {
  initPlanChat,
  sendPlanChatMessage,
  applyPlanChatUpdate,
  getPlanChatHistory,
  cancelPlanChat,
  type PlanChatDeps,
} from "./plan-chat";
import { appendPlanChatApplied, appendPlanChatExchange, readPlanChat } from "./plan-chat-store";

const VALID_PLAN: IssuePlan = {
  summary: "do the thing",
  context: [],
  files: [{ path: "src/a.ts", reason: "hosts the change" }],
  steps: [{ title: "edit", detail: "do it", files: ["src/a.ts"], symbols: ["run"] }],
  outOfScope: [],
  acceptance: [{ criterion: "works", addressedBy: "the edit" }],
  risks: [],
  verificationCommands: [],
  manualChecks: [],
  openQuestions: [],
  estimatedSize: "s",
};

const GENERATED_AT = "2026-07-21T00:00:00.000Z";

const REPORT: ConfidenceReport = {
  version: 1,
  composite: 0.7,
  weights: { groundedness: 0.5, convergence: 0, critic: 0.5, clarity: 0 },
  signals: {
    critic: {
      score: 0.4,
      verdict: "concerns",
      objections: [{ kind: "underspecified", detail: "needs a ceiling", blocking: false }],
    },
  },
  errors: [],
  computedAt: GENERATED_AT,
};

function makeItem(over: Partial<TrackedItem> = {}): TrackedItem {
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
    state: "plan-gate",
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    transitions: [],
    plan: { ref: "github_1.json", sessionId: "sess-1" },
    worktree: { path: "/wt/issue-1", branch: "feature/issue-1" },
    ...over,
  } as TrackedItem;
}

interface Harness {
  deps: PlanChatDeps;
  items: Map<string, TrackedItem>;
  events: CodingEvent[];
  sessionWrites: string[];
  updates: IssuePlan[];
  stored: StoredPlan;
}

function makeHarness(plansDir: string, item: TrackedItem): Harness {
  const items = new Map<string, TrackedItem>([[item.id, item]]);
  const events: CodingEvent[] = [];
  const sessionWrites: string[] = [];
  const updates: IssuePlan[] = [];
  const stored: StoredPlan = {
    version: 2,
    itemId: item.id,
    repo: item.repo,
    generatedAt: GENERATED_AT,
    model: "opus",
    plan: VALID_PLAN,
  };
  const deps: PlanChatDeps = {
    getItem: (id) => items.get(id),
    getIssue: () => ({ labels: [], body: "the body" }) as unknown as Issue,
    getRepoPath: (_repo: RepoRef) => "/repo",
    checkoutDirtyPaths: async () => null,
    getRepoSettings: () => ({ plannerModel: "opus" }) as unknown as ResolvedRepoOrchestratorSettings,
    getStoredPlan: async () => stored,
    updatePlan: async (_item, plan) => {
      updates.push(plan);
      return { ...stored, plan, editedAt: "2026-07-21T01:00:00.000Z" };
    },
    setPlanSessionId: async (_id, sid) => {
      sessionWrites.push(sid);
    },
    getLlmSettings: async (): Promise<LlmSettings> => ({ ...DEFAULT_LLM_SETTINGS }),
    emitEvent: (_id, e) => events.push(e),
    plansDir,
  };
  return { deps, items, events, sessionWrites, updates, stored };
}

function fakeProvider(
  agentImpl?: (prompt: string, opts?: Record<string, unknown>) => Promise<LLMResponse>,
): LLMProviderInterface & { agent: ReturnType<typeof vi.fn> } {
  const agent = vi.fn(
    agentImpl ?? (async (): Promise<LLMResponse> => ({ text: "an answer", sessionId: "sess-1" })),
  );
  return {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "ask answer" }),
    askStructured: async () => VALID_PLAN,
    agent,
  } as unknown as LLMProviderInterface & { agent: ReturnType<typeof vi.fn> };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let plansDir: string;
beforeEach(async () => {
  plansDir = await mkdtemp(join(tmpdir(), "nb-plan-chat-"));
});
afterEach(async () => {
  await rm(plansDir, { recursive: true, force: true });
});

describe("sendPlanChatMessage guards", () => {
  it("rejects a non-empty message when the item is not at plan-gate", async () => {
    const h = makeHarness(plansDir, makeItem({ state: "queued" }));
    initPlanChat(h.deps, fakeProvider());
    const res = await sendPlanChatMessage("github:1", "hi");
    expect(res).toEqual({ ok: false, error: expect.stringContaining("gate") });
  });

  it("rejects an empty message", async () => {
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, fakeProvider());
    const res = await sendPlanChatMessage("github:1", "   ");
    expect(res.ok).toBe(false);
  });

  it("fails the turn with an escape error when it dirtied the checkout (#196)", async () => {
    const h = makeHarness(plansDir, makeItem());
    let calls = 0;
    h.deps.checkoutDirtyPaths = async () => (calls++ === 0 ? [] : ["?? stray.ts"]);
    initPlanChat(h.deps, fakeProvider());
    const res = await sendPlanChatMessage("github:1", "hello");
    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toMatch(/escaped the worktree/);
  });

  it("busy-guards a second turn while one is running", async () => {
    const gate = deferred<LLMResponse>();
    const provider = fakeProvider(() => gate.promise);
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, provider);

    const first = sendPlanChatMessage("github:1", "q1");
    const second = await sendPlanChatMessage("github:1", "q2");
    expect(second).toEqual({ ok: false, error: "chat turn already running" });

    gate.resolve({ text: "answer", sessionId: "sess-1" });
    await first;
  });
});

describe("sendPlanChatMessage resume vs fallback", () => {
  it("resumes the plan session when claude-cli + sessionId + worktree", async () => {
    const provider = fakeProvider();
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, provider);
    const res = await sendPlanChatMessage("github:1", "why?");
    expect(res).toEqual({ ok: true, reply: "an answer" });
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBe("sess-1");
    expect(opts.sessionId).toBeUndefined();
    // Persisted transcript survives.
    const chat = await readPlanChat(plansDir, "github:1");
    expect(chat?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual(["why?", "an answer"]);
    // Never emit agent-start (would wipe the planner replay buffer).
    expect(h.events.some((e) => e.kind === "status" && e.phase === "agent-start")).toBe(false);
  });

  it("falls back to a fresh minted session when there is no plan session", async () => {
    const provider = fakeProvider();
    const h = makeHarness(plansDir, makeItem({ plan: { ref: "github_1.json" } }));
    initPlanChat(h.deps, provider);
    const res = await sendPlanChatMessage("github:1", "why?");
    expect(res.ok).toBe(true);
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBeUndefined();
    expect(typeof opts.sessionId).toBe("string");
    expect(h.sessionWrites).toHaveLength(1); // persist-before-run
  });

  it("injects the confidence report on the first discuss turn only (resume path)", async () => {
    const provider = fakeProvider();
    const h = makeHarness(plansDir, makeItem());
    h.stored.confidence = REPORT;
    initPlanChat(h.deps, provider);

    await sendPlanChatMessage("github:1", "why is the score low?");
    expect(provider.agent.mock.calls[0][0]).toContain("Confidence report");

    await sendPlanChatMessage("github:1", "and now?");
    expect(provider.agent.mock.calls[1][0]).not.toContain("Confidence report");
  });

  it("retries fresh when a dead resume fails without events", async () => {
    let call = 0;
    const provider = fakeProvider(async () => {
      call++;
      if (call === 1) throw new Error("session not found");
      return { text: "recovered", sessionId: "fresh" };
    });
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, provider);
    const res = await sendPlanChatMessage("github:1", "why?");
    expect(res).toEqual({ ok: true, reply: "recovered" });
    expect(provider.agent).toHaveBeenCalledTimes(2);
    const retryOpts = provider.agent.mock.calls[1][1] as Record<string, unknown>;
    expect(retryOpts.resumeSessionId).toBeUndefined();
    expect(typeof retryOpts.sessionId).toBe("string");
  });
});

describe("cancelPlanChat", () => {
  it("returns cancelled and persists no history on abort", async () => {
    const provider = fakeProvider(
      (_p, opts) =>
        new Promise<LLMResponse>((_res, rej) => {
          const sig = opts!.signal as AbortSignal;
          if (sig.aborted) rej(new AgentAbortError());
          else sig.addEventListener("abort", () => rej(new AgentAbortError()));
        }),
    );
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, provider);
    const pending = sendPlanChatMessage("github:1", "why?");
    cancelPlanChat("github:1");
    const res = await pending;
    expect(res).toEqual({ ok: false, cancelled: true });
    expect(await readPlanChat(plansDir, "github:1")).toBeNull();
  });
});

describe("applyPlanChatUpdate", () => {
  it("overwrites the stored plan when there is discussion history", async () => {
    const amended = { ...VALID_PLAN, summary: "amended summary" };
    const provider = fakeProvider(async () => ({ text: JSON.stringify(amended), sessionId: "sess-1" }));
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, provider);
    await appendPlanChatExchange(plansDir, "github:1", GENERATED_AT, "change X", "ok");

    const res = await applyPlanChatUpdate("github:1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.stored.plan.summary).toBe("amended summary");
    expect(h.updates).toEqual([amended]);
  });

  it("refuses to apply with no discussion history", async () => {
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, fakeProvider());
    const res = await applyPlanChatUpdate("github:1");
    expect(res).toEqual({ ok: false, error: "no discussion to apply" });
  });

  it("persists an applied marker with the change count after a successful apply (#201)", async () => {
    const amended = { ...VALID_PLAN, summary: "amended summary" };
    const provider = fakeProvider(async () => ({ text: JSON.stringify(amended), sessionId: "sess-1" }));
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, provider);
    await appendPlanChatExchange(plansDir, "github:1", GENERATED_AT, "change X", "ok");

    const res = await applyPlanChatUpdate("github:1");
    expect(res.ok).toBe(true);

    const chat = await readPlanChat(plansDir, "github:1");
    const marker = chat?.messages.at(-1);
    expect(isPlanChatText(marker!)).toBe(false);
    expect(marker).toMatchObject({ kind: "applied" });
    expect((marker as { changeCount: number }).changeCount).toBeGreaterThan(0);
  });

  it("writes no marker when apply refuses for lack of history (#201)", async () => {
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, fakeProvider());
    const res = await applyPlanChatUpdate("github:1");
    expect(res.ok).toBe(false);
    expect(await readPlanChat(plansDir, "github:1")).toBeNull();
  });

  it("refuses to apply a transcript that holds only an applied marker (#201)", async () => {
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, fakeProvider());
    await appendPlanChatApplied(plansDir, "github:1", GENERATED_AT, 2);
    const res = await applyPlanChatUpdate("github:1");
    expect(res).toEqual({ ok: false, error: "no discussion to apply" });
  });
});

describe("getPlanChatHistory", () => {
  it("returns the transcript for the current plan generation", async () => {
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, fakeProvider());
    await appendPlanChatExchange(plansDir, "github:1", GENERATED_AT, "q", "a");
    const history = await getPlanChatHistory("github:1");
    expect(history.filter(isPlanChatText).map((m) => m.text)).toEqual(["q", "a"]);
  });

  it("drops a transcript from a superseded plan generation", async () => {
    const h = makeHarness(plansDir, makeItem());
    initPlanChat(h.deps, fakeProvider());
    await appendPlanChatExchange(plansDir, "github:1", "old-gen", "q", "a");
    const history = await getPlanChatHistory("github:1");
    expect(history).toEqual([]);
    expect(await readPlanChat(plansDir, "github:1")).toBeNull();
  });
});
