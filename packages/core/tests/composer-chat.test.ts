import { describe, it, expect, vi } from "vitest";
import type { ComposerDraft, PlanChatMessage } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { AgentRuntime } from "../src/runtime";
import type { GraphifyContext } from "../src/llm/graphify-mcp";
import { discussComposer } from "../src/composer";

const HISTORY: PlanChatMessage[] = [
  { role: "user", text: "I want to rate-limit the webhook.", at: "2026-07-29T00:00:00.000Z" },
  { role: "assistant", text: "The handler lives in src/hooks.ts.", at: "2026-07-29T00:00:01.000Z" },
];

const DRAFT: ComposerDraft = {
  issues: [
    {
      title: "web:feat: rate-limit the webhook",
      body: "Throttle inbound calls.",
      acceptanceCriteria: ["429 after the cap"],
      labels: ["web", "enhancement"],
    },
    {
      title: "core:test: cover the limiter",
      body: "Unit tests for the token bucket.",
      acceptanceCriteria: [],
      labels: ["core"],
    },
  ],
  relations: [{ from: 1, to: 0, kind: "blocks" }],
};

const GRAPHIFY: GraphifyContext = {
  mcp: { mcpBinPath: "/tools/graphify-mcp", graphPath: "/graphs/o_r/graph.json" },
  indexedSha: "abc1234",
};

function fakeLLM(opts: { agentReply?: string; noAgent?: boolean } = {}): {
  llm: LLMProviderInterface;
  runtime: AgentRuntime | undefined;
  agent: ReturnType<typeof vi.fn>;
  ask: ReturnType<typeof vi.fn>;
} {
  const agent = vi.fn(
    async (_prompt: string, _o?: AgentOptions): Promise<LLMResponse> => ({
      text: opts.agentReply ?? "an answer",
      sessionId: "resolved-session",
    }),
  );
  const ask = vi.fn(async (): Promise<LLMResponse> => ({ text: "ask answer" }));
  const llm = {
    name: "claude-cli",
    ask,
    askStructured: vi.fn(),
  } as unknown as LLMProviderInterface;
  const runtime = opts.noAgent ? undefined : ({ id: "claude-cli", agent } as unknown as AgentRuntime);
  return { llm, runtime, agent, ask };
}

describe("discussComposer", () => {
  it("resume path: carries the message and threads resumeSessionId, no transcript", async () => {
    const { llm, runtime, agent } = fakeLLM();
    const res = await discussComposer({
      llm,
      runtime,
      cwd: "/repo",
      message: "split it in two",
      resumeSessionId: "sess-1",
    });
    expect(res.reply).toBe("an answer");
    expect(res.sessionId).toBe("resolved-session");
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("User: split it in two");
    expect(prompt).not.toContain("--- Conversation so far ---");
    expect(o.resumeSessionId).toBe("sess-1");
    expect(o.sessionId).toBeUndefined();
  });

  it("resume path: renders the current draft with per-field edited markers", async () => {
    const { llm, runtime, agent } = fakeLLM();
    await discussComposer({
      llm,
      runtime,
      cwd: "/repo",
      message: "what about the tests?",
      resumeSessionId: "sess-1",
      draft: DRAFT,
      edited: { 0: ["title"] },
    });
    const prompt = agent.mock.calls[0][0] as string;
    expect(prompt).toContain("--- Current draft ---");
    expect(prompt).toContain("web:feat: rate-limit the webhook");
    expect(prompt).toContain("Title: [edited by user — preserve verbatim unless the user asks otherwise]");
    // Only the flagged field is marked.
    expect(prompt).toContain("Body:\nThrottle inbound calls.");
    expect(prompt).toContain("Issue 2 blocks issue 1");
  });

  it("fallback path: embeds the transcript and the draft, mints a session", async () => {
    const { llm, runtime, agent } = fakeLLM();
    await discussComposer({
      llm,
      runtime,
      cwd: "/repo",
      message: "go on",
      sessionId: "mint-1",
      context: { history: HISTORY },
      draft: DRAFT,
    });
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("--- Conversation so far ---");
    expect(prompt).toContain("I want to rate-limit the webhook.");
    expect(prompt).toContain("--- Current draft ---");
    expect(o.sessionId).toBe("mint-1");
    expect(o.resumeSessionId).toBeUndefined();
  });

  it("throws when there is neither a session nor context", async () => {
    const { llm, runtime } = fakeLLM();
    await expect(discussComposer({ llm, runtime, cwd: "/repo", message: "hi" })).rejects.toThrow(
      /needs context/,
    );
  });

  it("appends the repo conventions and the graph section to the system prompt", async () => {
    const { llm, runtime, agent } = fakeLLM();
    await discussComposer({
      llm,
      runtime,
      cwd: "/repo",
      message: "hi",
      resumeSessionId: "sess-1",
      repoInstructions: "Always prefix issue titles with the scope.",
      graphify: GRAPHIFY,
    });
    const o = agent.mock.calls[0][1] as AgentOptions;
    expect(o.systemPrompt).toContain("well-scoped issues");
    expect(o.systemPrompt).toContain("## Repository conventions");
    expect(o.systemPrompt).toContain("Always prefix issue titles with the scope.");
    expect(o.systemPrompt).toContain("## Repository knowledge graph");
    expect(o.systemPrompt).toContain("abc1234");
  });

  it("passes the graphify MCP server through to the runtime", async () => {
    const { llm, runtime, agent } = fakeLLM();
    await discussComposer({
      llm,
      runtime,
      cwd: "/repo",
      message: "hi",
      resumeSessionId: "sess-1",
      graphify: GRAPHIFY,
    });
    expect((agent.mock.calls[0][1] as AgentOptions).graph).toEqual(GRAPHIFY.mcp);
  });

  it("omits the graph when the repo has no index", async () => {
    const { llm, runtime, agent } = fakeLLM();
    await discussComposer({ llm, runtime, cwd: "/repo", message: "hi", resumeSessionId: "s" });
    expect((agent.mock.calls[0][1] as AgentOptions).graph).toBeUndefined();
  });

  it("resume path: threads the attachment paths into the prompt", async () => {
    const { llm, runtime, agent } = fakeLLM();
    await discussComposer({
      llm,
      runtime,
      cwd: "/repo",
      message: "why is the header cut off?",
      resumeSessionId: "sess-1",
      attachments: ["/data/attachments/c1/shot.png", "/data/attachments/c1/spec.pdf"],
    });
    const prompt = agent.mock.calls[0][0] as string;
    expect(prompt).toContain(
      "Attached image: /data/attachments/c1/shot.png — read this file before answering.",
    );
    expect(prompt).toContain(
      "Attached PDF: /data/attachments/c1/spec.pdf — read this file before answering.",
    );
  });

  it("fallback path: threads the attachment paths into the seeded prompt", async () => {
    const { llm, runtime, agent } = fakeLLM();
    await discussComposer({
      llm,
      runtime,
      cwd: "/repo",
      message: "have a look",
      sessionId: "mint-1",
      context: { history: HISTORY },
      attachments: ["/data/attachments/c1/notes.md"],
    });
    const prompt = agent.mock.calls[0][0] as string;
    expect(prompt).toContain(
      "Attached file: /data/attachments/c1/notes.md — read this file before answering.",
    );
    expect(prompt).toContain("--- Conversation so far ---");
  });

  it("says nothing about attachments when the turn has none", async () => {
    const { llm, runtime, agent } = fakeLLM();
    await discussComposer({ llm, runtime, cwd: "/repo", message: "hi", resumeSessionId: "sess-1" });
    expect(agent.mock.calls[0][0] as string).not.toContain("Attached");
  });

  it("degrades to a single ask() when there is no runtime", async () => {
    const { llm, runtime, ask } = fakeLLM({ noAgent: true });
    const res = await discussComposer({
      llm,
      runtime,
      cwd: "/repo",
      message: "hi",
      context: { history: HISTORY },
    });
    expect(res.reply).toBe("ask answer");
    expect(ask).toHaveBeenCalledOnce();
  });
});
