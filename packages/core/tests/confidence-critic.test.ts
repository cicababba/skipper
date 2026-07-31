import { describe, it, expect, vi } from "vitest";
import type { CriticObjection, IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { AgentRuntime } from "../src/runtime";
import type { PlanIssueInput } from "../src/planner";
import {
  buildCriticPrompt,
  critiquePlan,
  runCritic,
  CriticError,
  type CriticPriorRound,
} from "../src/confidence";

const ISSUE: PlanIssueInput = {
  key: "42",
  title: "Add retry to the poller",
  url: "https://github.com/o/r/issues/42",
  labels: ["enhancement"],
  body: "The poller should retry on 429 with backoff.",
};

const PLAN: IssuePlan = {
  summary: "Add retry with backoff",
  files: [{ path: "src/poller.ts", reason: "poll loop" }],
  steps: [{ title: "t", detail: "d", files: ["src/poller.ts"], symbols: ["pollNow"] }],
  acceptance: [],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
};

function fakeLLM(structuredReply: unknown): {
  llm: LLMProviderInterface;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const askStructured = vi.fn(async (): Promise<unknown> => structuredReply);
  const llm = {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "" }),
    askStructured,
  } as unknown as LLMProviderInterface;
  return { llm, askStructured };
}

const objection = (blocking: boolean) => ({
  kind: "risk" as const,
  detail: "could break backoff",
  blocking,
});

describe("runCritic / critiquePlan", () => {
  it("derives 1.0 from approve with no objections", async () => {
    const { llm } = fakeLLM({ verdict: "approve", objections: [] });
    const s = await critiquePlan(PLAN, ISSUE, llm);
    expect(s.score).toBe(1);
    expect(s.verdict).toBe("approve");
  });

  it("derives 0.6 from concerns and keeps objections", async () => {
    const { llm } = fakeLLM({ verdict: "concerns", objections: [objection(false)] });
    const s = await critiquePlan(PLAN, ISSUE, llm);
    expect(s.score).toBeCloseTo(0.6);
    expect(s.objections).toHaveLength(1);
  });

  it("penalizes blocking objections and floors at 0", async () => {
    const { llm } = fakeLLM({
      verdict: "reject",
      objections: [objection(true), objection(true), objection(true)],
    });
    const s = await critiquePlan(PLAN, ISSUE, llm);
    expect(s.score).toBe(0);
    expect(s.verdict).toBe("reject");
  });

  it("throws CriticError on a malformed verdict", async () => {
    const { llm } = fakeLLM({ verdict: "meh", objections: "none" });
    await expect(critiquePlan(PLAN, ISSUE, llm)).rejects.toThrow(CriticError);
  });

  it("sends the artifact, context and adversarial framing to askStructured", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [] });
    await critiquePlan(PLAN, ISSUE, llm);
    const [prompt, schema] = askStructured.mock.calls[0] as [string, Record<string, unknown>];
    expect(prompt).toContain("DEMOLISH");
    expect(prompt).toContain("src/poller.ts");
    expect(prompt).toContain("retry on 429");
    expect(prompt).toContain("issue #42");
    expect(schema).toHaveProperty("properties");
  });

  it("mounts on a diff without plan knowledge (the #10 contract)", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [] });
    await runCritic(
      {
        artifactKind: "diff",
        artifactLabel: "diff for PR #7",
        artifact: "--- a/x.ts\n+++ b/x.ts",
        context: "Issue #7: fix x",
      },
      llm,
    );
    const [prompt] = askStructured.mock.calls[0] as [string];
    expect(prompt).toContain("diff");
    expect(prompt).toContain("--- a/x.ts");
    expect(prompt).toContain("Issue #7: fix x");
  });

  // Runtime-first: the plan critic runs on the role's own CLI when it has one,
  // so a non-Claude default agent never spawns the claude binary for it.
  it("runs the plan critic on the runtime with no tools when one is present", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [] });
    const structured = vi.fn(async (): Promise<unknown> => ({ verdict: "approve", objections: [] }));
    const runtime = { id: "codex-cli", structured } as unknown as AgentRuntime;
    const s = await critiquePlan(PLAN, ISSUE, llm, { runtime });
    expect(s.verdict).toBe("approve");
    expect(askStructured).not.toHaveBeenCalled();
    const [prompt, , opts] = structured.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { tools: string; cwd?: string; sessionId?: string; maxTurns?: number },
    ];
    expect(prompt).toContain("DEMOLISH");
    expect(opts.tools).toBe("");
    expect(opts.cwd).toBeUndefined();
    expect(opts.sessionId).toBeUndefined();
    expect(opts.maxTurns).toBeUndefined();
  });

  it("keeps the tools-mode options on the repo-inspecting critic", async () => {
    const { llm } = fakeLLM({ verdict: "approve", objections: [] });
    const structured = vi.fn(async (): Promise<unknown> => ({ verdict: "approve", objections: [] }));
    const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
    await runCritic(
      {
        artifactKind: "diff",
        artifactLabel: "diff for PR #7",
        artifact: "--- a/x.ts",
        context: "Issue #7",
      },
      llm,
      { runtime, tools: "Read,Grep,Glob", cwd: "/wt", sessionId: "sess-1", maxTurns: 8 },
    );
    const [, , opts] = structured.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { tools: string; cwd?: string; sessionId?: string; maxTurns?: number },
    ];
    expect(opts).toMatchObject({
      tools: "Read,Grep,Glob",
      cwd: "/wt",
      sessionId: "sess-1",
      maxTurns: 8,
    });
  });

  it("includes the plan kind label in the prompt", () => {
    const prompt = buildCriticPrompt({
      artifactKind: "plan",
      artifactLabel: "plan for issue #1",
      artifact: "{}",
      context: "ctx",
    });
    expect(prompt).toContain("plan");
    expect(prompt).toContain("--- Plan ---");
  });
});

// #226: ground objections in what is shown, raise a blocking flag only for a
// concrete failure, and re-verify priors against the current context.
describe("critic grounding & blocking bar (#226)", () => {
  const base = {
    artifactKind: "diff" as const,
    artifactLabel: "diff for PR #7",
    artifact: "--- a/x.ts\n+++ b/x.ts",
    context: "Issue #7: fix x",
  };

  it("instructs the critic to ground objections and gate blocking on a concrete failure", () => {
    const prompt = buildCriticPrompt(base);
    expect(prompt).toContain("Ground every objection in what is verifiable");
    expect(prompt).toContain("must be raised as a non-blocking question, never as blocking");
    expect(prompt).toContain("Mark blocking only when the objection names the concrete failure");
    expect(prompt).toContain('"Suspicious styling" or a convention hunch does not clear that bar');
  });

  it("adds the re-verify sentence on a continuity round", () => {
    const prompt = buildCriticPrompt({
      ...base,
      prior: { objections: [{ kind: "risk", detail: "P-one", blocking: true }], deliveredToCoder: true },
    });
    expect(prompt).toContain("Re-verify each persisting objection against the current artifact");
    expect(prompt).toContain("drop a prior the provided context refutes rather than escalating it");
  });

  it("adds the inspect-repo instruction only when canInspectRepo is set", () => {
    expect(buildCriticPrompt(base)).not.toContain(
      "You can read, search and list files across the working tree.",
    );
    expect(buildCriticPrompt({ ...base, canInspectRepo: true })).toContain(
      "You can read, search and list files across the working tree.",
    );
  });

  // The critic runs on the role's own runtime (#280), so its wording may name no
  // CLI's tools.
  it("names no claude tool", () => {
    expect(buildCriticPrompt({ ...base, canInspectRepo: true })).not.toMatch(
      /\bRead\b|\bGrep\b|\bGlob\b|\bBash\b/,
    );
  });
});

// #205: a continuity round classifies its objections against the prior round.
describe("runCritic continuity (#205)", () => {
  const priorObjections: CriticObjection[] = [
    { kind: "risk", detail: "P-one detail", blocking: true },
    { kind: "acceptance-gap", detail: "P-two detail", blocking: false },
    { kind: "other", detail: "P-three detail", blocking: false },
  ];

  const diffInput = (prior?: CriticPriorRound) => ({
    artifactKind: "diff" as const,
    artifactLabel: "diff for PR #7",
    artifact: "--- a/x.ts\n+++ b/x.ts",
    context: "Issue #7: fix x",
    ...(prior ? { prior } : {}),
  });

  it("hands the continuity schema to askStructured only when a prior is set", async () => {
    const { llm: base, askStructured: baseAsk } = fakeLLM({ verdict: "approve", objections: [] });
    await runCritic(diffInput(), base);
    const baseSchema = baseAsk.mock.calls[0][1] as { properties: Record<string, unknown> };
    expect(baseSchema.properties).not.toHaveProperty("resolved");

    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [], resolved: [] });
    await runCritic(diffInput({ objections: priorObjections, deliveredToCoder: true }), llm);
    const schema = askStructured.mock.calls[0][1] as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("resolved");
  });

  it("renders the P-labelled priors plus the status/resolved instructions", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [], resolved: [] });
    await runCritic(diffInput({ objections: priorObjections, deliveredToCoder: true }), llm);
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain("--- Previous review round ---");
    expect(prompt).toContain("P1. [risk] (blocking) P-one detail");
    expect(prompt).toContain("P2. [acceptance-gap] P-two detail");
    expect(prompt).toContain('status: "persisting"');
    expect(prompt).toContain('In "resolved", list the labels');
  });

  it("switches the priors phrasing on deliveredToCoder", async () => {
    const { llm: handed, askStructured: handedAsk } = fakeLLM({
      verdict: "approve",
      objections: [],
      resolved: [],
    });
    await runCritic(diffInput({ objections: priorObjections, deliveredToCoder: true }), handed);
    expect(handedAsk.mock.calls[0][0] as string).toContain("specifically instructed to address");

    const { llm: notHanded, askStructured: notHandedAsk } = fakeLLM({
      verdict: "approve",
      objections: [],
      resolved: [],
    });
    await runCritic(diffInput({ objections: priorObjections, deliveredToCoder: false }), notHanded);
    expect(notHandedAsk.mock.calls[0][0] as string).toContain("NOT explicitly handed to the coder");
  });

  it("maps resolved labels tolerantly: first digit, 1-based, bounded, deduped", async () => {
    const { llm } = fakeLLM({
      verdict: "concerns",
      objections: [],
      resolved: ["P1", "p2", "3.", "P99", "P1", "nonsense"],
    });
    const signal = await runCritic(
      diffInput({ objections: priorObjections, deliveredToCoder: true }),
      llm,
    );
    // P99 (out of bounds) and "nonsense" (no digit) dropped; duplicate P1 deduped.
    expect(signal.resolved).toEqual([priorObjections[0], priorObjections[1], priorObjections[2]]);
  });

  it("keeps the objection status through to the signal", async () => {
    const { llm } = fakeLLM({
      verdict: "reject",
      objections: [{ kind: "risk", detail: "still here", blocking: true, status: "persisting" }],
      resolved: [],
    });
    const signal = await runCritic(
      diffInput({ objections: priorObjections, deliveredToCoder: true }),
      llm,
    );
    expect(signal.objections[0]).toMatchObject({ status: "persisting" });
    expect(signal.resolved).toEqual([]);
  });

  it("throws CriticError on a malformed continuity reply", async () => {
    const { llm } = fakeLLM({ verdict: "approve", objections: [], resolved: "not-an-array" });
    await expect(
      runCritic(diffInput({ objections: priorObjections, deliveredToCoder: true }), llm),
    ).rejects.toThrow(CriticError);
  });
});
