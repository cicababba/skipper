import { describe, it, expect, vi } from "vitest";
import type { ComposerDraft, PlanChatMessage } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { AgentRuntime } from "../src/runtime";
import { distillComposerDraft, validateComposerDraft } from "../src/composer";

const HISTORY: PlanChatMessage[] = [
  { role: "user", text: "Rate-limit the webhook.", at: "2026-07-29T00:00:00.000Z" },
  { role: "assistant", text: "src/hooks.ts holds the handler.", at: "2026-07-29T00:00:01.000Z" },
];

const DRAFT: ComposerDraft = {
  issues: [
    {
      title: "web:feat: rate-limit the webhook",
      body: "Throttle inbound calls.",
      acceptanceCriteria: ["429 after the cap"],
      labels: ["web"],
    },
  ],
  relations: [],
};

const REPLY = {
  issues: [
    {
      title: "  web:feat: rate-limit the webhook  ",
      body: "Throttle inbound calls.",
      acceptanceCriteria: ["429 after the cap"],
      labels: ["web"],
    },
    {
      title: "core:test: cover the limiter",
      body: "Unit tests.",
      acceptanceCriteria: [],
      labels: ["core"],
    },
  ],
  relations: [{ from: 1, to: 0, kind: "blocks" }],
};

function fakeLLM(opts: { agentReply?: string; structuredReply?: unknown; noAgent?: boolean }): {
  llm: LLMProviderInterface;
  runtime: AgentRuntime | undefined;
  agent: ReturnType<typeof vi.fn>;
  structured: ReturnType<typeof vi.fn>;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const agent = vi.fn(
    async (_prompt: string, _o?: AgentOptions): Promise<LLMResponse> => ({
      text: opts.agentReply ?? "",
      sessionId: "resolved-session",
    }),
  );
  const structured = vi.fn(async (): Promise<unknown> => opts.structuredReply);
  const askStructured = vi.fn(async (): Promise<unknown> => opts.structuredReply);
  const llm = {
    name: "claude-cli",
    ask: vi.fn(async (): Promise<LLMResponse> => ({ text: "" })),
    askStructured,
  } as unknown as LLMProviderInterface;
  const runtime = opts.noAgent
    ? undefined
    : ({ id: "claude-cli", agent, structured } as unknown as AgentRuntime);
  return { llm, runtime, agent, structured, askStructured };
}

describe("distillComposerDraft", () => {
  it("resume path: parses the draft, trims titles, threads the session", async () => {
    const { llm, runtime, agent, structured } = fakeLLM({ agentReply: JSON.stringify(REPLY) });
    const res = await distillComposerDraft({ llm, runtime, cwd: "/repo", resumeSessionId: "sess-1" });
    expect(res.draft.issues).toHaveLength(2);
    expect(res.draft.issues[0].title).toBe("web:feat: rate-limit the webhook");
    expect(res.draft.relations).toEqual([{ from: 1, to: 0, kind: "blocks" }]);
    expect(res.sessionId).toBe("resolved-session");
    expect(structured).not.toHaveBeenCalled();
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("Distill this discussion into the issues to open");
    expect(prompt).toContain("FINAL message must be ONLY a single JSON object");
    expect(prompt).toContain("Schema:");
    expect(o.resumeSessionId).toBe("sess-1");
  });

  it("embeds the prior draft plus its edit markers and the preserve instruction", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: JSON.stringify(REPLY) });
    await distillComposerDraft({
      llm,
      runtime,
      cwd: "/repo",
      resumeSessionId: "sess-1",
      draft: DRAFT,
      edited: { 0: ["body"] },
    });
    const prompt = agent.mock.calls[0][0] as string;
    expect(prompt).toContain("--- Current draft ---");
    expect(prompt).toContain("Body: [edited by user — preserve verbatim unless the user asks otherwise]");
    expect(prompt).toContain("reproduce them verbatim");
  });

  it("fallback path: embeds the transcript", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: JSON.stringify(REPLY) });
    await distillComposerDraft({
      llm,
      runtime,
      cwd: "/repo",
      sessionId: "mint-1",
      context: { history: HISTORY },
    });
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("Rate-limit the webhook.");
    expect(o.sessionId).toBe("mint-1");
    expect(o.resumeSessionId).toBeUndefined();
  });

  it("spends the repair round on the runtime, never on the completions provider", async () => {
    const { llm, runtime, agent, structured, askStructured } = fakeLLM({
      agentReply: "here you go: not json at all",
      structuredReply: REPLY,
    });
    const res = await distillComposerDraft({ llm, runtime, cwd: "/repo", resumeSessionId: "s" });
    expect(res.draft.issues).toHaveLength(2);
    expect(agent).toHaveBeenCalledOnce();
    expect(structured).toHaveBeenCalledOnce();
    expect(askStructured).not.toHaveBeenCalled();
    const [, , structuredOpts] = structured.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { tools: string },
    ];
    expect(structuredOpts.tools).toBe("");
  });

  it("throws when the repair round also fails validation", async () => {
    const { llm, runtime } = fakeLLM({
      agentReply: "garbage",
      structuredReply: { issues: [], relations: [] },
    });
    await expect(
      distillComposerDraft({ llm, runtime, cwd: "/repo", resumeSessionId: "s" }),
    ).rejects.toThrow(/failed validation/);
  });

  it("drops relations pointing outside the draft or at themselves", async () => {
    const { llm, runtime } = fakeLLM({
      agentReply: JSON.stringify({
        issues: [{ title: "one", body: "", acceptanceCriteria: [], labels: [] }],
        relations: [
          { from: 0, to: 3, kind: "blocks" },
          { from: 0, to: 0, kind: "relates-to" },
        ],
      }),
    });
    const res = await distillComposerDraft({ llm, runtime, cwd: "/repo", resumeSessionId: "s" });
    expect(res.draft.relations).toEqual([]);
  });

  it("degrades to askStructured when there is no runtime", async () => {
    const { llm, runtime, askStructured } = fakeLLM({ noAgent: true, structuredReply: REPLY });
    const res = await distillComposerDraft({
      llm,
      runtime,
      cwd: "/repo",
      context: { history: HISTORY },
    });
    expect(res.draft.issues).toHaveLength(2);
    expect(res.sessionId).toBeUndefined();
    expect(askStructured).toHaveBeenCalledOnce();
  });

  it("throws when there is neither a session nor context", async () => {
    const { llm, runtime } = fakeLLM({});
    await expect(distillComposerDraft({ llm, runtime, cwd: "/repo" })).rejects.toThrow(
      /needs context/,
    );
  });
});

describe("validateComposerDraft", () => {
  it("rejects an empty issue list", () => {
    const res = validateComposerDraft({ issues: [], relations: [] });
    expect(res.ok).toBe(false);
  });

  it("rejects an issue without a title", () => {
    const res = validateComposerDraft({
      issues: [{ title: "", body: "", acceptanceCriteria: [], labels: [] }],
      relations: [],
    });
    expect(res.ok).toBe(false);
  });
});
