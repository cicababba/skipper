import { describe, it, expect, vi } from "vitest";
import type { ConfidenceReport, IssuePlan, PlanChatMessage } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { AgentRuntime } from "../src/runtime";
import {
  PLAN_CHAT_SYSTEM_PROMPT,
  discussPlan,
  applyPlanFromDiscussion,
  renderConfidenceBlock,
  type PlanIssueInput,
} from "../src/planner";

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

const REPORT: ConfidenceReport = {
  version: 1,
  composite: 0.7,
  weights: { groundedness: 0.47, convergence: 0, critic: 0.4, clarity: 0.13 },
  signals: {
    groundedness: {
      score: 0.96,
      filesChecked: 8,
      filesFound: 8,
      symbolsChecked: 33,
      symbolsFound: 29,
      missingFiles: [],
      missingSymbols: ["DESTRUCTIVE_ACTION_IDS", "pollNow"],
      newFiles: [],
    },
    critic: {
      score: 0.4,
      verdict: "concerns",
      objections: [
        { kind: "wrong-approach", detail: "x".repeat(600), blocking: true },
        { kind: "underspecified", detail: "the backoff ceiling is unspecified", blocking: false },
      ],
    },
    clarity: {
      score: 0.6,
      criteria: "partial",
      ambiguities: [
        {
          detail: "whether the counter still renders once every todo is done",
          resolvableFromRepo: false,
          flaggedByPlan: false,
        },
        {
          detail: "exact placement of the counter in the header",
          resolvableFromRepo: true,
          flaggedByPlan: false,
        },
      ],
      openQuestions: [],
      rationale: "outcomes are checkable, the all-done case is not",
    },
  },
  convergenceSkipped: { reason: "decisive", detail: "composite decisive for any convergence value" },
  errors: [],
  computedAt: "2026-07-21T00:00:00.000Z",
};

const HISTORY: PlanChatMessage[] = [
  { role: "user", text: "Why exponential backoff?", at: "2026-07-21T00:00:00.000Z" },
  { role: "assistant", text: "To avoid hammering the API on 429.", at: "2026-07-21T00:00:01.000Z" },
];

interface FakeOpts {
  agentReply?: string;
  structuredReply?: unknown;
  askReply?: string;
  /** Omit the runtime — no agentic path, discuss degrades to ask() (#238). */
  noAgent?: boolean;
}

function fakeLLM(opts: FakeOpts): {
  llm: LLMProviderInterface;
  runtime: AgentRuntime | undefined;
  agent: ReturnType<typeof vi.fn>;
  structured: ReturnType<typeof vi.fn>;
  ask: ReturnType<typeof vi.fn>;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const agent = vi.fn(
    async (_prompt: string, _o?: AgentOptions): Promise<LLMResponse> => ({
      text: opts.agentReply ?? "",
      sessionId: "resolved-session",
    }),
  );
  const structured = vi.fn(async (): Promise<unknown> => opts.structuredReply);
  const ask = vi.fn(async (): Promise<LLMResponse> => ({ text: opts.askReply ?? "" }));
  const askStructured = vi.fn(async (): Promise<unknown> => opts.structuredReply);
  const llm = {
    name: "claude-cli",
    ask,
    askStructured,
  } as unknown as LLMProviderInterface;
  const runtime = opts.noAgent
    ? undefined
    : ({ id: "claude-cli", agent, structured } as unknown as AgentRuntime);
  return { llm, runtime, agent, structured, ask, askStructured };
}

describe("renderConfidenceBlock", () => {
  it("renders composite, present signals and objections", () => {
    const block = renderConfidenceBlock(REPORT);
    expect(block).toContain("Composite: 0.70");
    expect(block).toContain("weights: groundedness 0.47, critic 0.40, clarity 0.13");
    expect(block).not.toContain("convergence 0.00"); // absent signal omitted from weights
    expect(block).toContain("- groundedness 0.96 — files 8/8; symbols 29/33");
    expect(block).toContain("missing symbols: DESTRUCTIVE_ACTION_IDS, pollNow");
    expect(block).toContain('- critic 0.40 — verdict "concerns", 2 objections:');
    expect(block).toContain("1. [wrong-approach] (blocking)");
    expect(block).toContain("2. [underspecified] the backoff ceiling is unspecified");
    expect(block).toContain('- clarity 0.60 — acceptance criteria "partial"');
    expect(block).toContain("- convergence: skipped (decisive)");
  });

  it("omits absent signals", () => {
    const block = renderConfidenceBlock({
      ...REPORT,
      signals: { clarity: REPORT.signals.clarity },
      convergenceSkipped: undefined,
    });
    expect(block).toContain("- clarity 0.60");
    expect(block).not.toContain("groundedness");
    expect(block).not.toContain("critic");
  });

  // #309: the semantic judgment replaced the structural heuristic, so the block
  // reports what the issue leaves open — and which of it the plan decided alone.
  it("counts only unresolved ambiguities and marks the silent ones", () => {
    const block = renderConfidenceBlock(REPORT);
    expect(block).toContain("1 unresolved ambiguity (1 decided silently by the plan)");
    expect(block).toContain(
      "1. [decided silently] whether the counter still renders once every todo is done",
    );
    expect(block).not.toContain("exact placement of the counter in the header");
    expect(block).toContain("outcomes are checkable, the all-done case is not");
  });

  it("marks a flagged ambiguity as flagged and reports repo-answerable questions", () => {
    const block = renderConfidenceBlock({
      ...REPORT,
      signals: {
        clarity: {
          score: 0.35,
          criteria: "vague",
          ambiguities: [
            { detail: "which priority levels", resolvableFromRepo: false, flaggedByPlan: true },
          ],
          openQuestions: [{ question: "where does the list live?", kind: "repo-knowledge" }],
          rationale: "the plan raised the one real question",
        },
      },
    });
    expect(block).toContain("1. [flagged] which priority levels");
    expect(block).toContain("1 open question(s) answerable from the repo");
  });

  it("still renders a report scored before #309 from its legacy fields", () => {
    const block = renderConfidenceBlock({
      ...REPORT,
      signals: {
        clarity: {
          score: 0.85,
          bodyPresent: true,
          hasAcceptanceCriteria: true,
          hasReproSteps: false,
          openQuestionCount: 2,
        },
      },
    });
    expect(block).toContain(
      "- clarity 0.85 — issue body present: yes, acceptance criteria: yes, repro steps: no, open questions: 2",
    );
  });

  it("renders the veto ahead of the signals", () => {
    const block = renderConfidenceBlock({
      ...REPORT,
      veto: { signal: "groundedness", detail: "3 cited files and 1 symbol are absent from the repo" },
    });
    expect(block).toContain(
      "- VETO (groundedness): 3 cited files and 1 symbol are absent from the repo — needs-input regardless of the composite",
    );
  });

  it("renders no veto line when the report carries none", () => {
    expect(renderConfidenceBlock(REPORT)).not.toContain("VETO");
  });

  it("truncates long objection detail", () => {
    const block = renderConfidenceBlock(REPORT);
    const line = block.split("\n").find((l) => l.includes("[wrong-approach]"))!;
    expect(line).toContain("…");
    // 400 chars of detail + prefix + ellipsis, never the full 600.
    expect(line).not.toContain("x".repeat(500));
  });
});

describe("discussPlan", () => {
  it("resume path: prompt carries the message, no plan JSON, and resumeSessionId is threaded", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: "Because 429 means back off." });
    const res = await discussPlan({
      message: "Why backoff?",
      llm,
      runtime,
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
    const { llm, runtime, agent } = fakeLLM({ agentReply: "answer" });
    await discussPlan({
      message: "Is the scheduler affected?",
      llm,
      runtime,
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

  it("fallback path: injects the confidence block when context.confidence is set", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: "answer" });
    await discussPlan({
      message: "why is the score so low?",
      llm,
      runtime,
      cwd: "/wt",
      context: { issue: ISSUE, plan: PLAN, history: [], confidence: REPORT },
    });
    const [prompt] = agent.mock.calls[0] as [string];
    expect(prompt).toContain("--- Confidence report");
    expect(prompt).toContain("Composite: 0.70");
  });

  it("fallback path: no confidence block when context.confidence is absent", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: "answer" });
    await discussPlan({
      message: "q",
      llm,
      runtime,
      cwd: "/wt",
      context: { issue: ISSUE, plan: PLAN, history: [] },
    });
    const [prompt] = agent.mock.calls[0] as [string];
    expect(prompt).not.toContain("Confidence report");
  });

  it("resume path: injects the confidence block when confidence is set", async () => {
    const { llm, runtime, agent } = fakeLLM({ agentReply: "answer" });
    await discussPlan({
      message: "why so low?",
      llm,
      runtime,
      cwd: "/wt",
      resumeSessionId: "sess-1",
      confidence: REPORT,
    });
    const [prompt] = agent.mock.calls[0] as [string];
    expect(prompt).toContain("--- Confidence report");
    expect(prompt).toContain('verdict "concerns"');
  });

  it("degrades to ask() when there is no runtime", async () => {
    const { llm, runtime, ask } = fakeLLM({ noAgent: true, askReply: "degraded answer" });
    const res = await discussPlan({
      message: "q",
      llm,
      runtime,
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
    const { llm, runtime, agent, structured } = fakeLLM({ agentReply: JSON.stringify(amended) });
    const res = await applyPlanFromDiscussion({
      llm,
      runtime,
      cwd: "/wt",
      plan: PLAN,
      resumeSessionId: "sess-1",
    });
    expect(res.plan).toEqual(amended);
    expect(res.sessionId).toBe("resolved-session");
    expect(structured).not.toHaveBeenCalled();
    const [prompt] = agent.mock.calls[0] as [string];
    expect(prompt).toContain("Add retry with backoff to the poller"); // current plan embedded
    expect(prompt).toContain("Schema:");
  });

  it("resume path: spends the repair round on the runtime, not the provider", async () => {
    const amended = { ...PLAN, summary: "repaired" };
    const { llm, runtime, structured, askStructured } = fakeLLM({
      agentReply: JSON.stringify({ ...amended, steps: [] }),
      structuredReply: amended,
    });
    const res = await applyPlanFromDiscussion({
      llm,
      runtime,
      cwd: "/wt",
      plan: PLAN,
      resumeSessionId: "sess-1",
    });
    expect(res.plan).toEqual(amended);
    expect(structured).toHaveBeenCalledOnce();
    expect(askStructured).not.toHaveBeenCalled();
    const [, , structuredOpts] = structured.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { tools: string },
    ];
    expect(structuredOpts.tools).toBe("");
  });

  it("no-runtime path: the repair round stays on the completions provider", async () => {
    const amended = { ...PLAN, summary: "repaired" };
    const { llm, runtime, askStructured } = fakeLLM({ noAgent: true });
    askStructured
      .mockResolvedValueOnce({ ...amended, steps: [] })
      .mockResolvedValueOnce(amended);
    const res = await applyPlanFromDiscussion({
      llm,
      runtime,
      cwd: "/wt",
      plan: PLAN,
      issue: ISSUE,
      history: HISTORY,
    });
    expect(res.plan).toEqual(amended);
    expect(askStructured).toHaveBeenCalledTimes(2);
  });

  it("throws when no session and no fallback context", async () => {
    const { llm } = fakeLLM({});
    await expect(applyPlanFromDiscussion({ llm, cwd: "/wt", plan: PLAN })).rejects.toThrow(
      /needs issue \+ history/,
    );
  });
});

// Runtime-neutral wording (#280): the prompt is shared by every runtime, so it
// may name no CLI's tools. The plan chat keeps its read-only affordances — it
// gains no shell here.
describe("PLAN_CHAT_SYSTEM_PROMPT wording", () => {
  it("names no claude tool", () => {
    expect(PLAN_CHAT_SYSTEM_PROMPT).not.toMatch(/\bRead\b|\bGrep\b|\bGlob\b|\bBash\b/);
  });

  it("keeps the prohibitions verbatim in force", () => {
    expect(PLAN_CHAT_SYSTEM_PROMPT).toContain("Do NOT modify any files, including via your shell");
    expect(PLAN_CHAT_SYSTEM_PROMPT).toContain(
      "never touch anything outside your working directory",
    );
  });

  it("grants no shell affordance", () => {
    expect(PLAN_CHAT_SYSTEM_PROMPT).toMatch(/You may read, search and list files/);
    expect(PLAN_CHAT_SYSTEM_PROMPT).not.toMatch(/run .*shell commands/);
  });
});
