import { describe, it, expect, vi } from "vitest";
import type { IssuePlan } from "@nestbrain/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import { generatePlan, PlanGenerationError, type PlanIssueInput } from "../src/planner";

const ISSUE: PlanIssueInput = {
  number: 42,
  title: "Add retry to the poller",
  url: "https://github.com/o/r/issues/42",
  labels: ["enhancement"],
  body: "The poller should retry on 429 with backoff.",
};

const VALID_PLAN: IssuePlan = {
  summary: "Add retry with backoff to the poller",
  files: [{ path: "src/poller.ts", reason: "hosts the poll loop" }],
  steps: [
    {
      title: "Add backoff helper",
      detail: "Exponential backoff computation",
      files: ["src/poller.ts"],
      symbols: ["pollNow"],
    },
  ],
  acceptance: [{ criterion: "retries on 429", addressedBy: "backoff in pollNow" }],
  risks: ["rate-limit interplay"],
  openQuestions: [],
  estimatedSize: "s",
};

interface FakeLLMOptions {
  agentReply?: string;
  structuredReply?: unknown;
  noAgent?: boolean;
}

function fakeLLM(opts: FakeLLMOptions): {
  llm: LLMProviderInterface;
  agent: ReturnType<typeof vi.fn>;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const agent = vi.fn(
    async (_prompt: string, _opts?: AgentOptions): Promise<LLMResponse> => ({
      text: opts.agentReply ?? "",
    }),
  );
  const askStructured = vi.fn(async (): Promise<unknown> => opts.structuredReply);
  const llm = {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "" }),
    askStructured,
    ...(opts.noAgent ? {} : { agent }),
  } as unknown as LLMProviderInterface;
  return { llm, agent, askStructured };
}

describe("generatePlan", () => {
  it("parses a clean JSON reply", async () => {
    const { llm, agent, askStructured } = fakeLLM({ agentReply: JSON.stringify(VALID_PLAN) });
    const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm });
    expect(plan).toEqual(VALID_PLAN);
    expect(agent).toHaveBeenCalledOnce();
    expect(askStructured).not.toHaveBeenCalled();
  });

  it("parses a fenced JSON reply", async () => {
    const { llm } = fakeLLM({
      agentReply: "```json\n" + JSON.stringify(VALID_PLAN) + "\n```",
    });
    const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm });
    expect(plan).toEqual(VALID_PLAN);
  });

  it("parses a prose-wrapped JSON reply", async () => {
    const { llm } = fakeLLM({
      agentReply: `Here is the plan:\n${JSON.stringify(VALID_PLAN)}\nLet me know!`,
    });
    const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm });
    expect(plan).toEqual(VALID_PLAN);
  });

  it("passes repoPath as cwd and includes issue + schema in the prompt", async () => {
    const { llm, agent } = fakeLLM({ agentReply: JSON.stringify(VALID_PLAN) });
    await generatePlan({ issue: ISSUE, repoPath: "/my/repo", llm });
    const [prompt, agentOpts] = agent.mock.calls[0] as [string, AgentOptions];
    expect(agentOpts.cwd).toBe("/my/repo");
    expect(agentOpts.maxTurns).toBe(24);
    expect(prompt).toContain("Add retry to the poller");
    expect(prompt).toContain("The poller should retry on 429");
    expect(prompt).toContain("estimatedSize");
  });

  it("passes onEvent through to the agent call and omits it otherwise", async () => {
    const { llm, agent } = fakeLLM({ agentReply: JSON.stringify(VALID_PLAN) });
    const onEvent = vi.fn();
    await generatePlan({ issue: ISSUE, repoPath: "/repo", llm, onEvent });
    let [, agentOpts] = agent.mock.calls[0] as [string, AgentOptions];
    expect(agentOpts.onEvent).toBe(onEvent);

    agent.mockClear();
    await generatePlan({ issue: ISSUE, repoPath: "/repo", llm });
    [, agentOpts] = agent.mock.calls[0] as [string, AgentOptions];
    expect("onEvent" in agentOpts).toBe(false);
  });

  it("repairs a schema-invalid reply via askStructured", async () => {
    const invalid = JSON.stringify({ ...VALID_PLAN, steps: [] });
    const { llm, askStructured } = fakeLLM({
      agentReply: invalid,
      structuredReply: VALID_PLAN,
    });
    const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm });
    expect(plan).toEqual(VALID_PLAN);
    expect(askStructured).toHaveBeenCalledOnce();
    const [repairPrompt] = askStructured.mock.calls[0] as [string];
    expect(repairPrompt).toContain(invalid);
    expect(repairPrompt).toContain("steps");
  });

  it("throws PlanGenerationError when the repair is also invalid", async () => {
    const { llm } = fakeLLM({
      agentReply: "no json here at all",
      structuredReply: { summary: "x" },
    });
    await expect(generatePlan({ issue: ISSUE, repoPath: "/repo", llm })).rejects.toThrow(
      PlanGenerationError,
    );
  });

  it("throws PlanGenerationError when the provider has no agent mode", async () => {
    const { llm } = fakeLLM({ noAgent: true });
    await expect(generatePlan({ issue: ISSUE, repoPath: "/repo", llm })).rejects.toThrow(
      /does not support agent mode/,
    );
  });
});
