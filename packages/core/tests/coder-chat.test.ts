import { describe, it, expect, vi } from "vitest";
import type { CoderReport, IssuePlan, PlanChatMessage } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import { distillCoderChatInstructions, type CoderChatContext, type PlanIssueInput } from "../src/coder";

const ISSUE: PlanIssueInput = {
  key: "42",
  title: "Add retry to the poller",
  url: "https://github.com/o/r/issues/42",
  labels: ["enhancement"],
  body: "The poller should retry on 429 with backoff.",
};

const PLAN: IssuePlan = {
  summary: "Add retry with backoff to the poller",
  files: [{ path: "src/poller.ts", reason: "hosts the poll loop" }],
  steps: [{ title: "Add backoff", detail: "exp backoff", files: ["src/poller.ts"], symbols: ["pollNow"] }],
  acceptance: [{ criterion: "retries on 429", addressedBy: "backoff" }],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
};

const REPORT: CoderReport = {
  done: [{ path: "src/poller.ts", summary: "added exponential backoff" }],
  deviations: ["renamed pollNow to pollOnce"],
  verification: [{ command: "pnpm test", passed: true }],
  open: [],
};

const HISTORY: PlanChatMessage[] = [
  { role: "user", text: "The backoff ceiling is too low.", at: "2026-07-21T00:00:00.000Z" },
  { role: "assistant", text: "I can raise it to 30s.", at: "2026-07-21T00:00:01.000Z" },
];

const INSTRUCTIONS = { instructions: [{ path: "src/poller.ts", body: "raise the backoff ceiling to 30s" }, { body: "add a test for the ceiling" }] };

interface FakeOpts {
  agentReply?: string;
  structuredReply?: unknown;
  noAgent?: boolean;
}

function fakeLLM(opts: FakeOpts): {
  llm: LLMProviderInterface;
  agent: ReturnType<typeof vi.fn>;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const agent = vi.fn(
    async (_prompt: string, _o?: AgentOptions): Promise<LLMResponse> => ({
      text: opts.agentReply ?? "",
      sessionId: "resolved-session",
    }),
  );
  const askStructured = vi.fn(async (): Promise<unknown> => opts.structuredReply);
  const llm = {
    name: "claude-cli",
    ask: vi.fn(async (): Promise<LLMResponse> => ({ text: "" })),
    askStructured,
    ...(opts.noAgent ? {} : { agent }),
  } as unknown as LLMProviderInterface;
  return { llm, agent, askStructured };
}

describe("distillCoderChatInstructions", () => {
  it("resume path: prompt demands JSON + schema, carries no issue/plan, threads resumeSessionId", async () => {
    const { llm, agent, askStructured } = fakeLLM({ agentReply: JSON.stringify(INSTRUCTIONS) });
    const res = await distillCoderChatInstructions({
      llm,
      cwd: "/wt",
      resumeSessionId: "sess-1",
    });
    expect(res.instructions).toEqual(INSTRUCTIONS.instructions);
    expect(res.sessionId).toBe("resolved-session");
    expect(askStructured).not.toHaveBeenCalled();
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("Distill the conclusions of this discussion");
    expect(prompt).toContain("FINAL message must be ONLY a single JSON object");
    expect(prompt).toContain("Schema:");
    expect(prompt).not.toContain("estimatedSize"); // no plan JSON on the resume path
    expect(o.resumeSessionId).toBe("sess-1");
    expect(o.sessionId).toBeUndefined();
  });

  it("fallback path: prompt embeds the issue, plan JSON, report and history + the JSON demand", async () => {
    const { llm, agent } = fakeLLM({ agentReply: JSON.stringify(INSTRUCTIONS) });
    await distillCoderChatInstructions({
      llm,
      cwd: "/wt",
      sessionId: "mint-1",
      context: { issue: ISSUE, plan: PLAN, report: REPORT, history: HISTORY },
    });
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("Add retry to the poller");
    expect(prompt).toContain("estimatedSize"); // plan JSON embedded
    expect(prompt).toContain("added exponential backoff"); // coder report embedded
    expect(prompt).toContain("The backoff ceiling is too low."); // history embedded
    expect(prompt).toContain("FINAL message must be ONLY a single JSON object");
    expect(o.sessionId).toBe("mint-1");
    expect(o.resumeSessionId).toBeUndefined();
  });

  it("spends the repair round when the agent reply is not valid instructions JSON", async () => {
    const { llm, agent, askStructured } = fakeLLM({
      agentReply: "here you go: not json at all",
      structuredReply: { instructions: [{ body: "repaired instruction" }] },
    });
    const res = await distillCoderChatInstructions({ llm, cwd: "/wt", resumeSessionId: "sess-1" });
    expect(res.instructions).toEqual([{ body: "repaired instruction" }]);
    expect(agent).toHaveBeenCalledOnce();
    expect(askStructured).toHaveBeenCalledOnce();
  });

  it("throws when the repair round also fails validation", async () => {
    const { llm } = fakeLLM({
      agentReply: "garbage",
      structuredReply: { instructions: [] }, // empty array is invalid
    });
    await expect(
      distillCoderChatInstructions({ llm, cwd: "/wt", resumeSessionId: "sess-1" }),
    ).rejects.toThrow(/failed validation/);
  });

  it("drops blank paths so an unscoped instruction carries no path", async () => {
    const { llm } = fakeLLM({
      agentReply: JSON.stringify({ instructions: [{ path: "  ", body: "do a thing" }] }),
    });
    const res = await distillCoderChatInstructions({ llm, cwd: "/wt", resumeSessionId: "sess-1" });
    expect(res.instructions).toEqual([{ body: "do a thing" }]);
  });

  it("degrades to askStructured when the provider has no agent mode", async () => {
    const { llm, askStructured } = fakeLLM({
      noAgent: true,
      structuredReply: { instructions: [{ body: "from structured" }] },
    });
    const res = await distillCoderChatInstructions({
      llm,
      cwd: "/wt",
      context: { issue: ISSUE, plan: PLAN, history: HISTORY },
    });
    expect(res.instructions).toEqual([{ body: "from structured" }]);
    expect(askStructured).toHaveBeenCalledOnce();
  });

  it("throws when there is neither a session nor context", async () => {
    const { llm } = fakeLLM({});
    await expect(distillCoderChatInstructions({ llm, cwd: "/wt" })).rejects.toThrow(/needs context/);
  });
});
