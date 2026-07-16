import { describe, it, expect, vi } from "vitest";
import type { IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { PlanIssueInput } from "../src/planner";
import { buildCriticPrompt, critiquePlan, runCritic, CriticError } from "../src/confidence";

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
