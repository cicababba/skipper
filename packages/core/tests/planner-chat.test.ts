import { describe, it, expect, vi } from "vitest";
import type { IssuePlan, PlanChatMessage } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import { discussPlan, applyPlanFromDiscussion, type PlanIssueInput } from "../src/planner";

const ISSUE: PlanIssueInput = {
  key: "42",
  title: "Add retry to the poller",
  url: "https://github.com/o/r/issues/42",
  labels: ["enhancement"],
  body: "The poller should retry on 429 with backoff.",
};

const PLAN: IssuePlan = {
  summary: "Add retry with backoff to the poller",
  context: [],
  files: [{ path: "src/poller.ts", reason: "hosts the poll loop" }],
  steps: [{ title: "Add backoff", detail: "exp backoff", files: ["src/poller.ts"], symbols: ["pollNow"] }],
  outOfScope: [],
  acceptance: [{ criterion: "retries on 429", addressedBy: "backoff" }],
  risks: [],
  verificationCommands: [],
  manualChecks: [],
  openQuestions: [],
  estimatedSize: "s",
};

const HISTORY: PlanChatMessage[] = [
  { role: "user", text: "Why exponential backoff?", at: "2026-07-21T00:00:00.000Z" },
  { role: "assistant", text: "To avoid hammering the API on 429.", at: "2026-07-21T00:00:01.000Z" },
];

interface FakeOpts {
  agentReply?: string;
  structuredReply?: unknown;
  askReply?: string;
  noAgent?: boolean;
}

function fakeLLM(opts: FakeOpts): {
  llm: LLMProviderInterface;
  agent: ReturnType<typeof vi.fn>;
  ask: ReturnType<typeof vi.fn>;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const agent = vi.fn(
    async (_prompt: string, _o?: AgentOptions): Promise<LLMResponse> => ({
      text: opts.agentReply ?? "",
      sessionId: "resolved-session",
    }),
  );
  const ask = vi.fn(async (): Promise<LLMResponse> => ({ text: opts.askReply ?? "" }));
  const askStructured = vi.fn(async (): Promise<unknown> => opts.structuredReply);
  const llm = {
    name: "claude-cli",
    ask,
    askStructured,
    ...(opts.noAgent ? {} : { agent }),
  } as unknown as LLMProviderInterface;
  return { llm, agent, ask, askStructured };
}

describe("discussPlan", () => {
  it("resume path: prompt carries the message, no plan JSON, and resumeSessionId is threaded", async () => {
    const { llm, agent } = fakeLLM({ agentReply: "Because 429 means back off." });
    const res = await discussPlan({
      message: "Why backoff?",
      llm,
      cwd: "/wt",
      resumeSessionId: "sess-1",
    });
    expect(res.reply).toBe("Because 429 means back off.");
    expect(res.sessionId).toBe("resolved-session");
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("Why backoff?");
    expect(prompt).not.toContain("estimatedSize");
    expect(o.resumeSessionId).toBe("sess-1");
    expect(o.sessionId).toBeUndefined();
  });

  it("fallback path: prompt embeds the issue, plan JSON and history", async () => {
    const { llm, agent } = fakeLLM({ agentReply: "answer" });
    await discussPlan({
      message: "Is the scheduler affected?",
      llm,
      cwd: "/wt",
      sessionId: "mint-1",
      context: { issue: ISSUE, plan: PLAN, history: HISTORY },
    });
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("Add retry to the poller");
    expect(prompt).toContain("estimatedSize");
    expect(prompt).toContain("Why exponential backoff?");
    expect(prompt).toContain("Is the scheduler affected?");
    expect(o.sessionId).toBe("mint-1");
    expect(o.resumeSessionId).toBeUndefined();
  });

  it("degrades to ask() when the provider has no agent mode", async () => {
    const { llm, ask } = fakeLLM({ noAgent: true, askReply: "degraded answer" });
    const res = await discussPlan({
      message: "q",
      llm,
      cwd: "/wt",
      context: { issue: ISSUE, plan: PLAN, history: [] },
    });
    expect(res.reply).toBe("degraded answer");
    expect(res.sessionId).toBeUndefined();
    expect(ask).toHaveBeenCalledOnce();
  });

  it("throws when no session and no context", async () => {
    const { llm } = fakeLLM({});
    await expect(discussPlan({ message: "q", llm, cwd: "/wt" })).rejects.toThrow(/needs context/);
  });
});

describe("applyPlanFromDiscussion", () => {
  it("resume path: embeds the current plan JSON + schema and validates the reply", async () => {
    const amended = { ...PLAN, summary: "Add retry with jittered backoff" };
    const { llm, agent, askStructured } = fakeLLM({ agentReply: JSON.stringify(amended) });
    const res = await applyPlanFromDiscussion({
      llm,
      cwd: "/wt",
      plan: PLAN,
      resumeSessionId: "sess-1",
    });
    expect(res.plan).toEqual(amended);
    expect(res.sessionId).toBe("resolved-session");
    expect(askStructured).not.toHaveBeenCalled();
    const [prompt] = agent.mock.calls[0] as [string];
    expect(prompt).toContain("Add retry with backoff to the poller"); // current plan embedded
    expect(prompt).toContain("Schema:");
  });

  it("resume path: spends the repair round when the agent reply is schema-invalid", async () => {
    const amended = { ...PLAN, summary: "repaired" };
    const { llm, askStructured } = fakeLLM({
      agentReply: JSON.stringify({ ...amended, steps: [] }),
      structuredReply: amended,
    });
    const res = await applyPlanFromDiscussion({
      llm,
      cwd: "/wt",
      plan: PLAN,
      resumeSessionId: "sess-1",
    });
    expect(res.plan).toEqual(amended);
    expect(askStructured).toHaveBeenCalledOnce();
  });

  it("throws when no session and no fallback context", async () => {
    const { llm } = fakeLLM({});
    await expect(applyPlanFromDiscussion({ llm, cwd: "/wt", plan: PLAN })).rejects.toThrow(
      /needs issue \+ history/,
    );
  });
});
