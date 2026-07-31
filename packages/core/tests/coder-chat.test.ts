import { describe, it, expect, vi } from "vitest";
import type { CoderReport, IssuePlan, PlanChatMessage } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { AgentRuntime } from "../src/runtime";
import {
  CODER_CHAT_SYSTEM_PROMPT,
  discussCoder,
  distillCoderChatInstructions,
  renderReviewBlock,
  type CoderChatContext,
  type CoderChatReviewInfo,
  type PlanIssueInput,
} from "../src/coder";

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
  /** Omit the runtime — no agentic path, distill degrades to askStructured (#238). */
  noAgent?: boolean;
}

function fakeLLM(opts: FakeOpts): {
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

describe("distillCoderChatInstructions", () => {
  it("resume path: prompt demands JSON + schema, carries no issue/plan, threads resumeSessionId", async () => {
    const { llm, runtime, agent, structured } = fakeLLM({ agentReply: JSON.stringify(INSTRUCTIONS) });
    const res = await distillCoderChatInstructions({
      llm,
      runtime,
      cwd: "/wt",
      resumeSessionId: "sess-1",
    });
    expect(res.instructions).toEqual(INSTRUCTIONS.instructions);
    expect(res.sessionId).toBe("resolved-session");
    expect(structured).not.toHaveBeenCalled();
    const [prompt, o] = agent.mock.calls[0] as [string, AgentOptions];
    expect(prompt).toContain("Distill the conclusions of this discussion");
    expect(prompt).toContain("FINAL message must be ONLY a single JSON object");
    expect(prompt).toContain("Schema:");
    expect(prompt).not.toContain("estimatedSize"); // no plan JSON on the resume path
    expect(o.resumeSessionId).toBe("sess-1");
    expect(o.sessionId).toBeUndefined();
  });

  it("fallback path: prompt embeds the issue, plan JSON, report and history + the JSON demand", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: JSON.stringify(INSTRUCTIONS) });
    await distillCoderChatInstructions({
      llm,
      runtime,
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

  it("spends the repair round on the runtime, never on the completions provider", async () => {
    const { llm, runtime, agent, structured, askStructured } = fakeLLM({
      agentReply: "here you go: not json at all",
      structuredReply: { instructions: [{ body: "repaired instruction" }] },
    });
    const res = await distillCoderChatInstructions({ llm, runtime, cwd: "/wt", resumeSessionId: "sess-1" });
    expect(res.instructions).toEqual([{ body: "repaired instruction" }]);
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
      structuredReply: { instructions: [] }, // empty array is invalid
    });
    await expect(
      distillCoderChatInstructions({ llm, runtime, cwd: "/wt", resumeSessionId: "sess-1" }),
    ).rejects.toThrow(/failed validation/);
  });

  it("drops blank paths so an unscoped instruction carries no path", async () => {
    const { llm, runtime } = fakeLLM({
      agentReply: JSON.stringify({ instructions: [{ path: "  ", body: "do a thing" }] }),
    });
    const res = await distillCoderChatInstructions({ llm, runtime, cwd: "/wt", resumeSessionId: "sess-1" });
    expect(res.instructions).toEqual([{ body: "do a thing" }]);
  });

  it("degrades to askStructured when there is no runtime", async () => {
    const { llm, runtime, askStructured } = fakeLLM({
      noAgent: true,
      structuredReply: { instructions: [{ body: "from structured" }] },
    });
    const res = await distillCoderChatInstructions({
      llm,
      runtime,
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

  // #205: the distill fallback also carries the review block.
  it("distill fallback embeds the review block only when context.review is set", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: JSON.stringify(INSTRUCTIONS) });
    await distillCoderChatInstructions({
      llm,
      runtime,
      cwd: "/wt",
      sessionId: "mint-1",
      context: { issue: ISSUE, plan: PLAN, review: REVIEW, history: HISTORY },
    });
    expect(agent.mock.calls[0][0] as string).toContain("--- Review (round 2, reject) ---");

    const { llm: llm2, runtime: runtime2, agent: agent2 } = fakeLLM({ agentReply: JSON.stringify(INSTRUCTIONS) });
    await distillCoderChatInstructions({
      llm: llm2,
      runtime: runtime2,
      cwd: "/wt",
      sessionId: "mint-1",
      context: { issue: ISSUE, plan: PLAN, history: HISTORY },
    });
    expect(agent2.mock.calls[0][0] as string).not.toContain("--- Review (");
  });
});

// #203: the reviewer verdict is injected into the coder chat context.
const REVIEW: CoderChatReviewInfo = {
  outcome: "reject",
  rounds: 2,
  reason: "did not converge",
  objections: [
    { kind: "risk", detail: "the blocking one", blocking: true },
    { kind: "other", detail: "a minor nit", blocking: false },
  ],
};

describe("renderReviewBlock", () => {
  it("renders round, outcome, reason and blocking-tagged objections", () => {
    const block = renderReviewBlock(REVIEW);
    expect(block).toContain("--- Review (round 2, reject) ---");
    expect(block).toContain("Reason: did not converge");
    expect(block).toContain("Objections:");
    expect(block).toContain("- [BLOCKING] (risk) the blocking one");
    expect(block).toContain("- (other) a minor nit");
    expect(block).toContain("--- End review ---");
  });

  it("renders an explicit none when there are no objections", () => {
    const block = renderReviewBlock({ outcome: "approve", rounds: 1 });
    expect(block).toContain("Objections: none.");
  });

  it("caps a long objection detail", () => {
    const block = renderReviewBlock({
      outcome: "reject",
      rounds: 1,
      objections: [{ kind: "risk", detail: "x".repeat(500), blocking: true }],
    });
    expect(block).toContain("…");
    expect(block).not.toContain("x".repeat(401));
  });
});

describe("discussCoder review injection (#203)", () => {
  it("resume path injects the review block only when resumeReview is given", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: "an answer" });
    await discussCoder({ llm, runtime, cwd: "/wt", message: "fix point 1", resumeSessionId: "s", resumeReview: REVIEW });
    const prompt = agent.mock.calls[0][0] as string;
    expect(prompt).toContain("An independent reviewer has reviewed your changes");
    expect(prompt).toContain("--- Review (round 2, reject) ---");

    const { llm: llm2, runtime: runtime2, agent: agent2 } = fakeLLM({ agentReply: "an answer" });
    await discussCoder({ llm: llm2, runtime: runtime2, cwd: "/wt", message: "fix point 1", resumeSessionId: "s" });
    expect(agent2.mock.calls[0][0] as string).not.toContain("--- Review (");
  });

  it("fallback path embeds the review block only when context.review is set", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: "an answer" });
    await discussCoder({
      llm,
      runtime,
      cwd: "/wt",
      message: "why?",
      context: { issue: ISSUE, plan: PLAN, review: REVIEW, history: HISTORY },
    });
    expect(agent.mock.calls[0][0] as string).toContain("--- Review (round 2, reject) ---");

    const { llm: llm2, runtime: runtime2, agent: agent2 } = fakeLLM({ agentReply: "an answer" });
    await discussCoder({
      llm: llm2,
      runtime: runtime2,
      cwd: "/wt",
      message: "why?",
      context: { issue: ISSUE, plan: PLAN, history: HISTORY },
    });
    expect(agent2.mock.calls[0][0] as string).not.toContain("--- Review (");
  });
});

// Runtime-neutral wording (#280): the prompt is shared by every runtime, so it
// may name no CLI's tools, while keeping the read-only shell it already had.
describe("CODER_CHAT_SYSTEM_PROMPT wording", () => {
  it("names no claude tool", () => {
    expect(CODER_CHAT_SYSTEM_PROMPT).not.toMatch(/\bRead\b|\bGrep\b|\bGlob\b|\bBash\b/);
  });

  it("keeps the read-only shell affordance and the prohibitions", () => {
    expect(CODER_CHAT_SYSTEM_PROMPT).toContain("run read-only shell commands");
    expect(CODER_CHAT_SYSTEM_PROMPT).toContain("Do NOT modify any files, including via your shell");
    expect(CODER_CHAT_SYSTEM_PROMPT).toContain(
      "never touch anything outside your working directory",
    );
  });
});
