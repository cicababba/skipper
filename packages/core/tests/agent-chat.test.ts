import { describe, it, expect, vi } from "vitest";
import { CHAT_SALVAGE_DETAIL, type CodingEvent } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import { AgentAbortError } from "../src/llm/provider";
import { ClaudeCliError, isSalvageableDeath, salvageableDeathSubtype } from "../src/llm";
import type { MemoryMcp } from "../src/llm/memory-mcp";
import type { GraphifyMcp } from "../src/llm/graphify-mcp";
import type { AgentRuntime } from "../src/runtime";
import {
  runAgentDiscussion,
  AGENT_CHAT_HARD_TIMEOUT_MS,
  DEFAULT_AGENT_CHAT_MAX_TURNS,
} from "../src/agent-chat";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESUME_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRIFTED_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const MEMORY: MemoryMcp = { cliBundlePath: "/cli", dataDir: "/memory", repo: "acme_widgets" } as unknown as MemoryMcp;
const GRAPH: GraphifyMcp = { mcpBinPath: "/tools/graphify-mcp", graphPath: "/graphs/graph.json" };

/** The gemini runtime mints its own max-turns death (gemini-cli.ts): a plain
 *  Error subclass carrying the same subtype, never a ClaudeCliError. */
class GeminiShapedError extends Error {
  constructor(
    message: string,
    readonly subtype?: string,
  ) {
    super(message);
    this.name = "GeminiCliError";
  }
}

function fake(agentImpl: (prompt: string, opts: AgentOptions) => Promise<LLMResponse>): {
  llm: LLMProviderInterface;
  runtime: AgentRuntime;
  agent: ReturnType<typeof vi.fn>;
  ask: ReturnType<typeof vi.fn>;
} {
  const agent = vi.fn(async (prompt: string, opts: AgentOptions = {}) => agentImpl(prompt, opts));
  const ask = vi.fn(async (): Promise<LLMResponse> => ({ text: "ask answer" }));
  const llm = { name: "claude-cli", ask, askStructured: vi.fn() } as unknown as LLMProviderInterface;
  return { llm, runtime: { id: "claude-cli", agent } as unknown as AgentRuntime, agent, ask };
}

const BASE = { cwd: "/repo", systemPrompt: "be helpful", prompt: "what does the poller do?" };

const dies = (err: unknown) => async () => {
  throw err;
};

describe("runAgentDiscussion — budgets", () => {
  it("forwards the chat defaults on the fresh path (#301)", async () => {
    const { llm, runtime, agent } = fake(async () => ({ text: "an answer" }));
    const res = await runAgentDiscussion({ llm, runtime, ...BASE });
    expect(res.reply).toBe("an answer");
    const [, opts] = agent.mock.calls[0] as [string, AgentOptions];
    expect(opts.maxTurns).toBe(60);
    expect(opts.hardTimeoutMs).toBe(480_000);
    expect(DEFAULT_AGENT_CHAT_MAX_TURNS).toBe(60);
    expect(AGENT_CHAT_HARD_TIMEOUT_MS).toBe(480_000);
  });

  it("forwards the chat defaults on the resume path", async () => {
    const { llm, runtime, agent } = fake(async () => ({ text: "an answer" }));
    await runAgentDiscussion({ llm, runtime, ...BASE, resumeSessionId: RESUME_SESSION });
    const [, opts] = agent.mock.calls[0] as [string, AgentOptions];
    expect(opts.maxTurns).toBe(60);
    expect(opts.hardTimeoutMs).toBe(480_000);
  });

  it("lets an explicit maxTurns override the default", async () => {
    const { llm, runtime, agent } = fake(async () => ({ text: "an answer" }));
    await runAgentDiscussion({ llm, runtime, ...BASE, maxTurns: 12 });
    expect((agent.mock.calls[0][1] as AgentOptions).maxTurns).toBe(12);
  });
});

describe("runAgentDiscussion — budget salvage (#301)", () => {
  it("resumes the minted session and answers when the fresh run hits max-turns", async () => {
    const { llm, runtime, agent } = fake(async (_prompt, opts) => {
      if (opts.resumeSessionId) return { text: "a partial answer", sessionId: SESSION };
      throw new ClaudeCliError("agent hit the max-turns limit after 61 turns", "error_max_turns", 61);
    });

    const res = await runAgentDiscussion({ llm, runtime, ...BASE, sessionId: SESSION });

    expect(res.reply).toBe("a partial answer");
    expect(agent).toHaveBeenCalledTimes(2);
    const [salvagePrompt, salvageOpts] = agent.mock.calls[1] as [string, AgentOptions];
    expect(salvageOpts.resumeSessionId).toBe(SESSION);
    expect(salvageOpts.maxTurns).toBe(4);
    expect(salvageOpts.hardTimeoutMs).toBe(60_000);
    expect(salvagePrompt).toMatch(/Do NOT call any more tools/);
  });

  it("resumes the agent-init-drifted id, not the session the turn resumed", async () => {
    const { llm, runtime, agent } = fake(async (_prompt, opts) => {
      if (opts.resumeSessionId === DRIFTED_SESSION) return { text: "salvaged" };
      opts.onEvent?.({ kind: "agent-init", sessionId: DRIFTED_SESSION });
      throw new ClaudeCliError("agent hit the max-turns limit", "error_max_turns", 61);
    });

    const res = await runAgentDiscussion({
      llm,
      runtime,
      ...BASE,
      resumeSessionId: RESUME_SESSION,
    });

    expect(res.reply).toBe("salvaged");
    expect((agent.mock.calls[1][1] as AgentOptions).resumeSessionId).toBe(DRIFTED_SESSION);
  });

  it("emits the salvage notice through the caller's onEvent", async () => {
    const events: CodingEvent[] = [];
    const { llm, runtime } = fake(async (_prompt, opts) => {
      if (opts.resumeSessionId) return { text: "salvaged" };
      throw new ClaudeCliError("agent hit the max-turns limit", "error_max_turns", 61);
    });

    await runAgentDiscussion({
      llm,
      runtime,
      ...BASE,
      sessionId: SESSION,
      onEvent: (event) => events.push(event),
    });

    expect(events).toContainEqual({
      kind: "status",
      phase: "resuming",
      detail: CHAT_SALVAGE_DETAIL,
    });
  });

  it("drops memory and graph from the wrap-up round", async () => {
    const { llm, runtime, agent } = fake(async (_prompt, opts) => {
      if (opts.resumeSessionId) return { text: "salvaged" };
      throw new ClaudeCliError("agent hit the max-turns limit", "error_max_turns", 61);
    });

    await runAgentDiscussion({
      llm,
      runtime,
      ...BASE,
      sessionId: SESSION,
      memory: MEMORY,
      graph: GRAPH,
    });

    const [, primaryOpts] = agent.mock.calls[0] as [string, AgentOptions];
    const [, salvageOpts] = agent.mock.calls[1] as [string, AgentOptions];
    expect(primaryOpts.memory).toBe(MEMORY);
    expect(primaryOpts.graph).toBe(GRAPH);
    expect("memory" in salvageOpts).toBe(false);
    expect("graph" in salvageOpts).toBe(false);
  });

  it.each(["error_hard_timeout", "error_inactivity"] as const)(
    "salvages a %s death too",
    async (subtype) => {
      const { llm, runtime, agent } = fake(async (_prompt, opts) => {
        if (opts.resumeSessionId) return { text: "salvaged" };
        throw new ClaudeCliError("agent run hit the time budget (8 min) — killed", subtype);
      });

      const res = await runAgentDiscussion({ llm, runtime, ...BASE, sessionId: SESSION });
      expect(res.reply).toBe("salvaged");
      expect(agent).toHaveBeenCalledTimes(2);
    },
  );

  it("salvages a gemini-shaped death (structural subtype match)", async () => {
    const { llm, runtime, agent } = fake(async (_prompt, opts) => {
      if (opts.resumeSessionId) return { text: "salvaged" };
      throw new GeminiShapedError("gemini hit its session turn limit", "error_max_turns");
    });

    const res = await runAgentDiscussion({ llm, runtime, ...BASE, sessionId: SESSION });
    expect(res.reply).toBe("salvaged");
    expect(agent).toHaveBeenCalledTimes(2);
  });

  it("rethrows the original death and skips salvage when no session exists", async () => {
    const death = new ClaudeCliError("agent hit the max-turns limit", "error_max_turns", 61);
    const { llm, runtime, agent } = fake(dies(death));

    await expect(runAgentDiscussion({ llm, runtime, ...BASE })).rejects.toThrow(
      /max-turns limit/,
    );
    expect(agent).toHaveBeenCalledOnce();
  });

  it("rethrows the ORIGINAL death when the wrap-up dies too", async () => {
    const { llm, runtime, agent } = fake(async (_prompt, opts) => {
      if (opts.resumeSessionId) throw new ClaudeCliError("salvage boom", "error_max_turns", 4);
      throw new ClaudeCliError("original max-turns death", "error_max_turns", 61);
    });

    await expect(
      runAgentDiscussion({ llm, runtime, ...BASE, sessionId: SESSION }),
    ).rejects.toThrow(/original max-turns death/);
    expect(agent).toHaveBeenCalledTimes(2);
  });

  it("does not salvage a death with no salvageable subtype", async () => {
    const { llm, runtime, agent } = fake(dies(new Error("session not found")));

    await expect(
      runAgentDiscussion({ llm, runtime, ...BASE, resumeSessionId: RESUME_SESSION }),
    ).rejects.toThrow(/session not found/);
    expect(agent).toHaveBeenCalledOnce();
  });

  it("does not salvage an aborted turn", async () => {
    const controller = new AbortController();
    const { llm, runtime, agent } = fake(async () => {
      controller.abort();
      throw new ClaudeCliError("agent hit the max-turns limit", "error_max_turns", 61);
    });

    await expect(
      runAgentDiscussion({ llm, runtime, ...BASE, sessionId: SESSION, signal: controller.signal }),
    ).rejects.toThrow(/max-turns limit/);
    expect(agent).toHaveBeenCalledOnce();
  });

  it("has no salvage on the no-runtime path — a single ask()", async () => {
    const { llm, ask } = fake(dies(new Error("never called")));
    const res = await runAgentDiscussion({ llm, ...BASE });
    expect(res.reply).toBe("ask answer");
    expect(ask).toHaveBeenCalledOnce();
  });
});

describe("salvageableDeathSubtype", () => {
  it.each(["error_max_turns", "error_hard_timeout", "error_inactivity"] as const)(
    "matches a ClaudeCliError with subtype %s",
    (subtype) => {
      expect(salvageableDeathSubtype(new ClaudeCliError("dead", subtype))).toBe(subtype);
      expect(isSalvageableDeath(new ClaudeCliError("dead", subtype))).toBe(true);
    },
  );

  it("matches any runtime error carrying the subtype (gemini-shaped)", () => {
    const err = new GeminiShapedError("gemini hit its session turn limit", "error_max_turns");
    expect(salvageableDeathSubtype(err)).toBe("error_max_turns");
    expect(isSalvageableDeath(err)).toBe(true);
  });

  it("does not match an aborted run, a plain error, or a non-error value", () => {
    expect(salvageableDeathSubtype(new AgentAbortError())).toBeUndefined();
    expect(isSalvageableDeath(new AgentAbortError())).toBe(false);
    expect(salvageableDeathSubtype(new ClaudeCliError("boom", "error_during_execution"))).toBeUndefined();
    expect(salvageableDeathSubtype(new Error("plain"))).toBeUndefined();
    expect(salvageableDeathSubtype({ subtype: "error_max_turns" })).toBeUndefined();
  });
});
