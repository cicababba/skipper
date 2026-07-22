import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodingEvent,
  Issue,
  IssuePlan,
  LlmSettings,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredCoderReport,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { DEFAULT_LLM_SETTINGS } from "@skipper/shared";
import { AgentAbortError, type LLMProviderInterface, type LLMResponse } from "@skipper/core";
import {
  initAgentChat,
  sendAgentChatMessage,
  getAgentChatHistory,
  prepareCoderChatApply,
  confirmCoderChatApply,
  cancelAgentChat,
  type AgentChatDeps,
} from "./agent-chat";
import { appendAgentChatExchange, readAgentChat, setAgentChatSessionId } from "./agent-chat-store";

const AT = "2026-07-21T00:00:00.000Z";

const VALID_PLAN: IssuePlan = {
  summary: "do the thing",
  files: [{ path: "src/a.ts", reason: "hosts the change" }],
  steps: [{ title: "edit", detail: "do it", files: ["src/a.ts"], symbols: ["run"] }],
  acceptance: [{ criterion: "works", addressedBy: "the edit" }],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
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
    state: "human-review",
    createdAt: AT,
    updatedAt: AT,
    transitions: [],
    plan: { ref: "github_1.json" },
    worktree: { path: "/wt/issue-1", branch: "feature/issue-1", sessionId: "wt-sess" },
    review: {
      rounds: 1,
      outcome: "concerns",
      objections: [{ kind: "underspecified", detail: "needs a ceiling", blocking: false }],
      sessionId: "rev-sess",
      at: AT,
    },
    ...over,
  } as TrackedItem;
}

interface Harness {
  deps: AgentChatDeps;
  items: Map<string, TrackedItem>;
  events: { kind: string; event: CodingEvent }[];
}

function makeHarness(plansDir: string, item: TrackedItem, report?: StoredCoderReport): Harness {
  const items = new Map<string, TrackedItem>([[item.id, item]]);
  const events: { kind: string; event: CodingEvent }[] = [];
  const stored: StoredPlan = {
    version: 2,
    itemId: item.id,
    repo: item.repo,
    generatedAt: AT,
    model: "opus",
    plan: VALID_PLAN,
  };
  const deps: AgentChatDeps = {
    getItem: (id) => items.get(id),
    getIssue: () => ({ labels: [], body: "the body" }) as unknown as Issue,
    getRepoPath: (_repo: RepoRef) => "/repo",
    getRepoSettings: () =>
      ({ coderModel: "opus", reviewerModel: "opus" }) as unknown as ResolvedRepoOrchestratorSettings,
    getStoredPlan: async () => stored,
    getCoderReport: async () => report ?? null,
    getLlmSettings: async (): Promise<LlmSettings> => ({ ...DEFAULT_LLM_SETTINGS }),
    emitEvent: (kind, _id, event) => events.push({ kind, event }),
    plansDir,
    completeReentry: async () => {},
  };
  return { deps, items, events };
}

function fakeProvider(
  agentImpl?: (prompt: string, opts?: Record<string, unknown>) => Promise<LLMResponse>,
): LLMProviderInterface & { agent: ReturnType<typeof vi.fn> } {
  const agent = vi.fn(
    agentImpl ?? (async (): Promise<LLMResponse> => ({ text: "an answer", sessionId: "wt-sess" })),
  );
  return {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "ask answer" }),
    askStructured: async () => VALID_PLAN,
    agent,
  } as unknown as LLMProviderInterface & { agent: ReturnType<typeof vi.fn> };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let plansDir: string;
beforeEach(async () => {
  plansDir = await mkdtemp(join(tmpdir(), "nb-agent-chat-"));
});
afterEach(async () => {
  await rm(plansDir, { recursive: true, force: true });
});

describe("sendAgentChatMessage availability", () => {
  it("blocks the coder chat while the item is coding", async () => {
    const h = makeHarness(plansDir, makeItem({ state: "coding" }));
    initAgentChat(h.deps, fakeProvider());
    const res = await sendAgentChatMessage("coder", "github:1", "hi");
    expect(res.ok).toBe(false);
  });

  it("blocks the coder chat without a worktree", async () => {
    const h = makeHarness(plansDir, makeItem({ worktree: undefined }));
    initAgentChat(h.deps, fakeProvider());
    const res = await sendAgentChatMessage("coder", "github:1", "hi");
    expect(res.ok).toBe(false);
  });

  it("blocks the reviewer chat while the item is in agent-review", async () => {
    const h = makeHarness(plansDir, makeItem({ state: "agent-review" }));
    initAgentChat(h.deps, fakeProvider());
    const res = await sendAgentChatMessage("reviewer", "github:1", "hi");
    expect(res.ok).toBe(false);
  });

  it("blocks the reviewer chat without a review", async () => {
    const h = makeHarness(plansDir, makeItem({ review: undefined }));
    initAgentChat(h.deps, fakeProvider());
    const res = await sendAgentChatMessage("reviewer", "github:1", "hi");
    expect(res.ok).toBe(false);
  });
});

describe("sendAgentChatMessage resume vs fallback", () => {
  it("resumes the coder session from worktree.sessionId on turn 1", async () => {
    const provider = fakeProvider();
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    const res = await sendAgentChatMessage("coder", "github:1", "why?");
    expect(res).toEqual({ ok: true, reply: "an answer", mode: "resumed" });
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBe("wt-sess");
    const chat = await readAgentChat(plansDir, "coder", "github:1");
    expect(chat?.messages.map((m) => m.text)).toEqual(["why?", "an answer"]);
  });

  it("resumes the reviewer session from review.sessionId on turn 1", async () => {
    const provider = fakeProvider();
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    const res = await sendAgentChatMessage("reviewer", "github:1", "why?");
    expect(res.ok).toBe(true);
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBe("rev-sess");
  });

  it("prefers the chat store's own session id on turn 2", async () => {
    await setAgentChatSessionId(plansDir, "coder", "github:1", "/wt/issue-1", "store-sess");
    const provider = fakeProvider();
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    await sendAgentChatMessage("coder", "github:1", "again?");
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBe("store-sess");
  });

  it("falls back to a minted persist-before-run session when no session exists", async () => {
    const provider = fakeProvider();
    const item = makeItem({ worktree: { path: "/wt/issue-1", branch: "feature/issue-1" } });
    const h = makeHarness(plansDir, item);
    initAgentChat(h.deps, provider);
    const res = await sendAgentChatMessage("coder", "github:1", "why?");
    expect(res.ok && res.mode).toBe("fresh");
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBeUndefined();
    expect(typeof opts.sessionId).toBe("string");
    // The minted id was persisted before the run.
    const chat = await readAgentChat(plansDir, "coder", "github:1");
    expect(chat?.sessionId).toBe(opts.sessionId);
  });

  it("captures a drifted session id into the chat store (never a manifest write)", async () => {
    const provider = fakeProvider(async (_p, opts) => {
      (opts!.onEvent as (e: CodingEvent) => void)({
        kind: "agent-init",
        sessionId: "drifted",
      } as CodingEvent);
      return { text: "ok", sessionId: "drifted" };
    });
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    await sendAgentChatMessage("coder", "github:1", "why?");
    const chat = await readAgentChat(plansDir, "coder", "github:1");
    expect(chat?.sessionId).toBe("drifted");
    // The manifest sessionId is untouched — the runner never sets it (D1).
    expect(h.items.get("github:1")?.worktree?.sessionId).toBe("wt-sess");
  });

  it("retries fresh once when a dead resume fails without events", async () => {
    let call = 0;
    const provider = fakeProvider(async () => {
      call++;
      if (call === 1) throw new Error("session not found");
      return { text: "recovered", sessionId: "fresh" };
    });
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    const res = await sendAgentChatMessage("coder", "github:1", "why?");
    expect(res).toEqual({ ok: true, reply: "recovered", mode: "fresh" });
    expect(provider.agent).toHaveBeenCalledTimes(2);
    const retryOpts = provider.agent.mock.calls[1][1] as Record<string, unknown>;
    expect(retryOpts.resumeSessionId).toBeUndefined();
  });

  it("passes the selected file into the coder prompt", async () => {
    const provider = fakeProvider();
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    await sendAgentChatMessage("coder", "github:1", "why?", { selectedFile: "src/target.ts" });
    expect(provider.agent.mock.calls[0][0]).toContain("src/target.ts");
  });

  it("seeds the reviewer fallback prompt with the outcome and objections", async () => {
    const provider = fakeProvider();
    // No worktree → not resumable, reviewer runs a fresh, fully-seeded turn.
    const item = makeItem({
      worktree: undefined,
      review: {
        rounds: 1,
        outcome: "concerns",
        objections: [{ kind: "underspecified", detail: "needs a ceiling", blocking: false }],
        at: AT,
      },
    });
    const h = makeHarness(plansDir, item);
    initAgentChat(h.deps, provider);
    const res = await sendAgentChatMessage("reviewer", "github:1", "why concerns?");
    expect(res.ok).toBe(true);
    const prompt = provider.agent.mock.calls[0][0] as string;
    expect(prompt).toContain("concerns");
    expect(prompt).toContain("needs a ceiling");
  });
});

describe("sendAgentChatMessage cancel + drift", () => {
  it("returns cancelled and persists nothing on abort", async () => {
    const provider = fakeProvider(
      (_p, opts) =>
        new Promise<LLMResponse>((_res, rej) => {
          const sig = opts!.signal as AbortSignal;
          if (sig.aborted) rej(new AgentAbortError());
          else sig.addEventListener("abort", () => rej(new AgentAbortError()));
        }),
    );
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    const pending = sendAgentChatMessage("coder", "github:1", "why?");
    cancelAgentChat("coder", "github:1");
    const res = await pending;
    expect(res).toEqual({ ok: false, cancelled: true });
    const chat = await readAgentChat(plansDir, "coder", "github:1");
    expect(chat?.messages ?? []).toEqual([]);
  });

  it("returns cancelled when the item leaves availability mid-turn", async () => {
    const gate = deferred<LLMResponse>();
    const provider = fakeProvider(() => gate.promise);
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    const pending = sendAgentChatMessage("coder", "github:1", "why?");
    // The coder starts running under us — the chat's read-only view no longer holds.
    h.items.set("github:1", makeItem({ state: "coding" }));
    gate.resolve({ text: "late", sessionId: "wt-sess" });
    const res = await pending;
    expect(res).toEqual({ ok: false, cancelled: true });
  });

  it("busy-guards a second turn of the same kind", async () => {
    const gate = deferred<LLMResponse>();
    const provider = fakeProvider(() => gate.promise);
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    const first = sendAgentChatMessage("coder", "github:1", "q1");
    const second = await sendAgentChatMessage("coder", "github:1", "q2");
    expect(second).toEqual({ ok: false, error: "chat turn already running" });
    gate.resolve({ text: "answer", sessionId: "wt-sess" });
    await first;
  });
});

describe("getAgentChatHistory", () => {
  it("returns the transcript bound to the current binding", async () => {
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, fakeProvider());
    await sendAgentChatMessage("coder", "github:1", "q");
    const history = await getAgentChatHistory("coder", "github:1");
    expect(history.map((m) => m.text)).toEqual(["q", "an answer"]);
  });

  it("drops a transcript from a superseded binding", async () => {
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, fakeProvider());
    await sendAgentChatMessage("coder", "github:1", "q");
    // A fresh worktree supersedes the coder transcript.
    h.items.set("github:1", makeItem({ worktree: { path: "/wt/new", branch: "b", sessionId: "s" } }));
    const history = await getAgentChatHistory("coder", "github:1");
    expect(history).toEqual([]);
  });
});

const INSTR_JSON = JSON.stringify({
  instructions: [{ path: "src/a.ts", body: "add a null check" }, { body: "update the test" }],
});

function instructionsProvider() {
  return fakeProvider(async () => ({ text: INSTR_JSON, sessionId: "wt-sess" }));
}

async function seedCoderHistory(): Promise<void> {
  await appendAgentChatExchange(plansDir, "coder", "github:1", "/wt/issue-1", "please fix", "will do");
}

describe("prepareCoderChatApply guards", () => {
  it("blocks when the item is not in an apply state", async () => {
    const h = makeHarness(plansDir, makeItem({ state: "pr-open" }));
    initAgentChat(h.deps, instructionsProvider());
    const res = await prepareCoderChatApply("github:1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("not available");
  });

  it("blocks when the coder chat itself is unavailable (coding)", async () => {
    const h = makeHarness(plansDir, makeItem({ state: "coding" }));
    initAgentChat(h.deps, instructionsProvider());
    const res = await prepareCoderChatApply("github:1");
    expect(res.ok).toBe(false);
  });

  it("blocks with no discussion to apply", async () => {
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, instructionsProvider());
    const res = await prepareCoderChatApply("github:1");
    expect(res).toEqual({ ok: false, error: "no discussion to apply" });
  });

  it("busy-guards against a concurrent send", async () => {
    const gate = deferred<LLMResponse>();
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, fakeProvider(() => gate.promise));
    await seedCoderHistory();
    const send = sendAgentChatMessage("coder", "github:1", "q");
    const res = await prepareCoderChatApply("github:1");
    expect(res).toEqual({ ok: false, error: "chat turn already running" });
    gate.resolve({ text: "answer", sessionId: "wt-sess" });
    await send;
  });
});

describe("prepareCoderChatApply distillation", () => {
  it("resumes the session, maps instructions with the coder-chat author, persists the session", async () => {
    const provider = instructionsProvider();
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    await seedCoderHistory();
    const res = await prepareCoderChatApply("github:1");
    expect(res).toEqual({
      ok: true,
      instructions: [
        { author: "coder-chat", path: "src/a.ts", body: "add a null check" },
        { author: "coder-chat", body: "update the test" },
      ],
    });
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBe("wt-sess");
    // Apply never appends to the transcript, but it persists the session lineage.
    const chat = await readAgentChat(plansDir, "coder", "github:1");
    expect(chat?.messages.map((m) => m.text)).toEqual(["please fix", "will do"]);
    expect(chat?.sessionId).toBe("wt-sess");
  });

  it("spends the repair round when the agent reply is not valid instructions JSON", async () => {
    const askStructured = vi.fn(async () => ({ instructions: [{ body: "repaired" }] }));
    const provider = {
      name: "claude-cli",
      ask: async () => ({ text: "" }),
      askStructured,
      agent: vi.fn(async () => ({ text: "not json", sessionId: "wt-sess" })),
    } as unknown as LLMProviderInterface & { agent: ReturnType<typeof vi.fn> };
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    await seedCoderHistory();
    const res = await prepareCoderChatApply("github:1");
    expect(res).toEqual({ ok: true, instructions: [{ author: "coder-chat", body: "repaired" }] });
    expect(askStructured).toHaveBeenCalledOnce();
  });

  it("captures a drifted session id into the chat store", async () => {
    const provider = fakeProvider(async (_p, opts) => {
      (opts!.onEvent as (e: CodingEvent) => void)({ kind: "agent-init", sessionId: "drifted" } as CodingEvent);
      return { text: INSTR_JSON, sessionId: "drifted" };
    });
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    await seedCoderHistory();
    await prepareCoderChatApply("github:1");
    const chat = await readAgentChat(plansDir, "coder", "github:1");
    expect(chat?.sessionId).toBe("drifted");
  });

  it("returns cancelled when the item leaves the apply set mid-distillation", async () => {
    const gate = deferred<LLMResponse>();
    const provider = fakeProvider(() => gate.promise);
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, provider);
    await seedCoderHistory();
    const pending = prepareCoderChatApply("github:1");
    // A human opens the PR under us — pr-open is out of the apply set.
    h.items.set("github:1", makeItem({ state: "pr-open" }));
    gate.resolve({ text: INSTR_JSON, sessionId: "wt-sess" });
    const res = await pending;
    expect(res).toEqual({ ok: false, cancelled: true });
  });
});

describe("confirmCoderChatApply", () => {
  it("blocks when the item is not in an apply state", async () => {
    const h = makeHarness(plansDir, makeItem({ state: "pr-open" }));
    initAgentChat(h.deps, instructionsProvider());
    const res = await confirmCoderChatApply("github:1", [{ author: "coder-chat", body: "x" }]);
    expect(res.ok).toBe(false);
  });

  it("blocks empty instructions", async () => {
    const h = makeHarness(plansDir, makeItem());
    initAgentChat(h.deps, instructionsProvider());
    const res = await confirmCoderChatApply("github:1", []);
    expect(res).toEqual({ ok: false, error: "no instructions to apply" });
  });

  it("fires completeReentry with the mapped comments and the user actor", async () => {
    const reentry = vi.fn(async () => {});
    const h = makeHarness(plansDir, makeItem());
    h.deps.completeReentry = reentry;
    initAgentChat(h.deps, instructionsProvider());
    const instructions = [{ author: "coder-chat", path: "src/a.ts", body: "add a null check" }];
    const res = await confirmCoderChatApply("github:1", instructions);
    expect(res).toEqual({ ok: true });
    expect(reentry).toHaveBeenCalledWith("github:1", instructions, "coder chat apply", "user");
  });
});
