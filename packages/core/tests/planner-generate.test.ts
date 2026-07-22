import { describe, it, expect, vi } from "vitest";
import type { IssuePlan } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import { ClaudeCliError } from "../src/llm";
import { generatePlan, IssuePlanSchema, PlanGenerationError, type PlanIssueInput } from "../src/planner";

const ISSUE: PlanIssueInput = {
  key: "42",
  title: "Add retry to the poller",
  url: "https://github.com/o/r/issues/42",
  labels: ["enhancement"],
  body: "The poller should retry on 429 with backoff.",
};

const VALID_PLAN: IssuePlan = {
  summary: "Add retry with backoff to the poller",
  context: ["src/poller.ts:12 polls on a fixed interval"],
  files: [{ path: "src/poller.ts", reason: "hosts the poll loop" }],
  steps: [
    {
      title: "Add backoff helper",
      detail: "Exponential backoff computation",
      files: ["src/poller.ts"],
      symbols: ["pollNow"],
    },
  ],
  outOfScope: ["the scheduler"],
  acceptance: [{ criterion: "retries on 429", addressedBy: "backoff in pollNow" }],
  risks: ["rate-limit interplay"],
  verificationCommands: ["pnpm test"],
  manualChecks: ["trigger a 429 and watch it retry"],
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

describe("IssuePlanSchema — new required generation fields (#143)", () => {
  it("accepts the four fields as empty arrays", () => {
    const payload = {
      ...VALID_PLAN,
      context: [],
      outOfScope: [],
      verificationCommands: [],
      manualChecks: [],
    };
    expect(IssuePlanSchema.parse(payload)).toEqual(payload);
  });

  it("rejects a payload missing one of them", () => {
    const { context: _context, ...missingContext } = VALID_PLAN;
    expect(IssuePlanSchema.safeParse(missingContext).success).toBe(false);
  });
});

describe("generatePlan — deterministic repair (#50)", () => {
  it("repairs a fenced reply without spending the LLM repair round", async () => {
    const { llm, askStructured } = fakeLLM({
      agentReply: "Here is the plan:\n\n```json\n" + JSON.stringify(VALID_PLAN) + "\n```\n\nHope that helps!",
    });
    const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm });
    expect(plan).toEqual(VALID_PLAN);
    expect(askStructured).not.toHaveBeenCalled();
  });

  it("repairs trailing commas without spending the LLM repair round", async () => {
    const { llm, askStructured } = fakeLLM({
      agentReply: JSON.stringify(VALID_PLAN).replace(/}$/, ",}"),
    });
    const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm });
    expect(plan).toEqual(VALID_PLAN);
    expect(askStructured).not.toHaveBeenCalled();
  });

  it("still pays for the repair round when the JSON is valid but the content is not", async () => {
    const { llm, askStructured } = fakeLLM({
      agentReply: '{"summary":"missing every other field"}',
      structuredReply: VALID_PLAN,
    });
    const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm });
    expect(plan).toEqual(VALID_PLAN);
    expect(askStructured).toHaveBeenCalledTimes(1);
  });
});

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
    expect(agentOpts.maxTurns).toBe(300);
    expect(prompt).toContain("Add retry to the poller");
    expect(prompt).toContain("The poller should retry on 429");
    expect(prompt).toContain("estimatedSize");
  });

  it("forwards hardTimeoutMs to the primary agent call and omits it otherwise (#194)", async () => {
    const withBudget = fakeLLM({ agentReply: JSON.stringify(VALID_PLAN) });
    await generatePlan({ issue: ISSUE, repoPath: "/repo", llm: withBudget.llm, hardTimeoutMs: 900_000 });
    const [, budgetOpts] = withBudget.agent.mock.calls[0] as [string, AgentOptions];
    expect(budgetOpts.hardTimeoutMs).toBe(900_000);

    const without = fakeLLM({ agentReply: JSON.stringify(VALID_PLAN) });
    await generatePlan({ issue: ISSUE, repoPath: "/repo", llm: without.llm });
    const [, plainOpts] = without.agent.mock.calls[0] as [string, AgentOptions];
    expect(plainOpts.hardTimeoutMs).toBeUndefined();
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
      /planning needs a provider with agent mode/,
    );
  });
});

describe("generatePlan — max-turns salvage round", () => {
  const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function salvageLLM(agentImpl: (opts: AgentOptions) => Promise<LLMResponse>): {
    llm: LLMProviderInterface;
    agent: ReturnType<typeof vi.fn>;
  } {
    const agent = vi.fn(async (_prompt: string, opts: AgentOptions = {}) => agentImpl(opts));
    const llm = {
      name: "claude-cli",
      ask: async (): Promise<LLMResponse> => ({ text: "" }),
      askStructured: vi.fn(),
      agent,
    } as unknown as LLMProviderInterface;
    return { llm, agent };
  }

  it("resumes the session and emits the plan when the primary run hits max-turns", async () => {
    const { llm, agent } = salvageLLM(async (opts) => {
      if (opts.resumeSessionId) return { text: JSON.stringify(VALID_PLAN) };
      throw new ClaudeCliError("agent hit the max-turns limit", "error_max_turns", 41);
    });
    const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm, sessionId: SESSION });
    expect(plan).toEqual(VALID_PLAN);
    expect(agent).toHaveBeenCalledTimes(2);
    const [, salvageOpts] = agent.mock.calls[1] as [string, AgentOptions];
    expect(salvageOpts.resumeSessionId).toBe(SESSION);
    expect(salvageOpts.maxTurns).toBe(4);
  });

  it("rejects with the original error and skips salvage when no session was persisted", async () => {
    const { llm, agent } = salvageLLM(async () => {
      throw new ClaudeCliError("agent hit the max-turns limit", "error_max_turns", 41);
    });
    await expect(generatePlan({ issue: ISSUE, repoPath: "/repo", llm })).rejects.toThrow(
      /max-turns limit/,
    );
    expect(agent).toHaveBeenCalledOnce();
  });

  it("does not salvage a non-max-turns ClaudeCliError", async () => {
    const { llm, agent } = salvageLLM(async () => {
      throw new ClaudeCliError("failed", "error_during_execution");
    });
    await expect(
      generatePlan({ issue: ISSUE, repoPath: "/repo", llm, sessionId: SESSION }),
    ).rejects.toThrow(/failed/);
    expect(agent).toHaveBeenCalledOnce();
  });

  it.each(["error_hard_timeout", "error_inactivity"] as const)(
    "salvages a %s death, resuming with the salvage budget (#194)",
    async (subtype) => {
      const { llm, agent } = salvageLLM(async (opts) => {
        if (opts.resumeSessionId) return { text: JSON.stringify(VALID_PLAN) };
        throw new ClaudeCliError("agent run hit the time budget", subtype);
      });
      const plan = await generatePlan({ issue: ISSUE, repoPath: "/repo", llm, sessionId: SESSION });
      expect(plan).toEqual(VALID_PLAN);
      expect(agent).toHaveBeenCalledTimes(2);
      const [, salvageOpts] = agent.mock.calls[1] as [string, AgentOptions];
      expect(salvageOpts.resumeSessionId).toBe(SESSION);
      expect(salvageOpts.maxTurns).toBe(4);
      expect(salvageOpts.hardTimeoutMs).toBe(300_000);
    },
  );

  it("rejects with the original max-turns error when salvage also throws", async () => {
    const { llm, agent } = salvageLLM(async (opts) => {
      if (opts.resumeSessionId) throw new ClaudeCliError("salvage boom", "error_max_turns", 4);
      throw new ClaudeCliError("original max-turns", "error_max_turns", 41);
    });
    await expect(
      generatePlan({ issue: ISSUE, repoPath: "/repo", llm, sessionId: SESSION }),
    ).rejects.toThrow(/original max-turns/);
    expect(agent).toHaveBeenCalledTimes(2);
  });
});
