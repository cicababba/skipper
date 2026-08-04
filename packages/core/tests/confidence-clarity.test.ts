import { describe, it, expect, vi } from "vitest";
import type { IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { AgentRuntime, RuntimeStructuredOptions } from "../src/runtime";
import type { PlanIssueInput } from "../src/planner";
import {
  ClarityError,
  buildClarityPrompt,
  deriveClarityScore,
  scoreClarity,
  type ClarityJudgment,
} from "../src/confidence";

// Fixtures are the two issues from the dogfooding run behind #309 — the best and
// the worst-written of the set, which the structural heuristic scored identically.

const ISSUE_1: PlanIssueInput = {
  key: "ISSUE-1",
  title: "mostrare quanti todo restano",
  url: "https://example.com/todos/1",
  labels: [],
  body: [
    "Acceptance criteria",
    "",
    '- Con 3 todo di cui 1 fatto, la UI mostra "2 left".',
    '- Con esattamente 1 rimanente legge "1 left", non "1 lefts".',
    '- Senza todo il contatore non è renderizzato: resta il messaggio "nothing here yet".',
    "- Il conteggio si aggiorna subito su toggle, aggiunta, cancellazione.",
    "- Solo frontend: nessuna modifica ad API o shared.",
  ].join("\n"),
};

const PLAN_1: IssuePlan = {
  summary: "Render a remaining-todos counter in the list header",
  context: [],
  files: [{ path: "web/src/TodoList.tsx", reason: "hosts the header" }],
  steps: [
    {
      title: "Count the open todos",
      detail: "derive the count from the existing todos state",
      files: ["web/src/TodoList.tsx"],
      symbols: ["TodoList"],
    },
  ],
  outOfScope: ["API changes"],
  acceptance: [{ criterion: '3 todos, 1 done → "2 left"', addressedBy: "the header counter" }],
  risks: [],
  verificationCommands: [],
  manualChecks: [],
  openQuestions: [],
  estimatedSize: "s",
};

const ISSUE_2: PlanIssueInput = {
  key: "ISSUE-2",
  title: "todo priority",
  url: "https://example.com/todos/2",
  labels: [],
  body: [
    "Acceptance criteria",
    "",
    "- A todo has a priority.",
    "- The UI shows it and lets you change it.",
    "- Existing todos keep working.",
  ].join("\n"),
};

const PLAN_2: IssuePlan = {
  summary:
    'Add three priority levels (low, normal, high) defaulting to "normal", exposed as an inline <select> on each row; list ordering is left untouched',
  context: [],
  files: [{ path: "web/src/TodoRow.tsx", reason: "hosts the control" }],
  steps: [
    {
      title: "Add the priority field",
      detail: 'store "low" | "normal" | "high", default "normal"',
      files: ["web/src/TodoRow.tsx"],
      symbols: ["TodoRow"],
    },
  ],
  outOfScope: [],
  acceptance: [
    { criterion: "each todo carries a priority", addressedBy: "the new field" },
    { criterion: "the row renders a select to change it", addressedBy: "the inline select" },
  ],
  risks: [],
  verificationCommands: [],
  manualChecks: [],
  openQuestions: [],
  estimatedSize: "m",
};

// What the real judge produced against the real CLI on each issue.
const JUDGMENT_1: ClarityJudgment = {
  criteria: "partial",
  ambiguities: [
    {
      detail:
        "Whether the counter should still render (as \"0 left\") when all todos are done but the list isn't empty",
      resolvableFromRepo: false,
      flaggedByPlan: false,
    },
    {
      detail: "Exact placement/markup of the counter within the header",
      resolvableFromRepo: true,
      flaggedByPlan: false,
    },
  ],
  openQuestions: [],
  rationale: "Outcomes are stated and checkable, but the all-done case is left undecided.",
};

const JUDGMENT_2: ClarityJudgment = {
  criteria: "vague",
  ambiguities: [
    { detail: "Which priority levels exist", resolvableFromRepo: false, flaggedByPlan: false },
    { detail: "The default priority of a new todo", resolvableFromRepo: false, flaggedByPlan: false },
    { detail: "Which control changes the priority", resolvableFromRepo: false, flaggedByPlan: false },
    { detail: "Whether the list reorders by priority", resolvableFromRepo: false, flaggedByPlan: false },
    {
      detail: 'What "stand out" means visually',
      resolvableFromRepo: false,
      flaggedByPlan: false,
    },
  ],
  openQuestions: [],
  rationale: "Nothing here is objectively checkable; the plan settled five decisions on its own.",
};

function judgment(overrides: Partial<ClarityJudgment> = {}): ClarityJudgment {
  return {
    criteria: "verifiable",
    ambiguities: [],
    openQuestions: [],
    rationale: "r",
    ...overrides,
  };
}

function fakeLLM(reply: unknown): {
  llm: LLMProviderInterface;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const askStructured = vi.fn(async (): Promise<unknown> => reply);
  return {
    llm: {
      name: "claude-cli",
      ask: async (): Promise<LLMResponse> => ({ text: "" }),
      askStructured,
    } as unknown as LLMProviderInterface,
    askStructured,
  };
}

function fakeRuntime(reply: unknown): {
  runtime: AgentRuntime;
  structured: ReturnType<typeof vi.fn>;
} {
  const structured = vi.fn(async (): Promise<unknown> => reply);
  return { runtime: { id: "claude-cli", structured } as unknown as AgentRuntime, structured };
}

describe("scoreClarity — the two dogfooding issues (#309)", () => {
  it("separates the surgical issue from the vague one by 0.60", async () => {
    const { llm: llm1 } = fakeLLM(JUDGMENT_1);
    const { llm: llm2 } = fakeLLM(JUDGMENT_2);
    const s1 = await scoreClarity(ISSUE_1, PLAN_1, llm1);
    const s2 = await scoreClarity(ISSUE_2, PLAN_2, llm2);

    // 0.75 (partial) − 0.15 (one silent unresolved ambiguity); the second
    // ambiguity is resolvable from the repo, so it costs nothing.
    expect(s1.score).toBeCloseTo(0.6);
    // 0.5 (vague) − 5 × 0.15, clamped.
    expect(s2.score).toBe(0);
    expect(s1.score - s2.score).toBeCloseTo(0.6);
  });

  it("carries the judgment through to the signal", async () => {
    const { llm } = fakeLLM(JUDGMENT_1);
    const s = await scoreClarity(ISSUE_1, PLAN_1, llm);
    expect(s.criteria).toBe("partial");
    expect(s.ambiguities).toEqual(JUDGMENT_1.ambiguities);
    expect(s.openQuestions).toEqual([]);
    expect(s.rationale).toBe(JUDGMENT_1.rationale);
  });

  it("runs on the runtime with no tools when one is present", async () => {
    const { llm, askStructured } = fakeLLM(JUDGMENT_1);
    const { runtime, structured } = fakeRuntime(JUDGMENT_1);
    await scoreClarity(ISSUE_1, PLAN_1, llm, { runtime });
    expect(askStructured).not.toHaveBeenCalled();
    expect(structured).toHaveBeenCalledOnce();
    const [, , opts] = structured.mock.calls[0] as [string, object, RuntimeStructuredOptions];
    expect(opts.tools).toBe("");
    expect(opts.cwd).toBeUndefined();
  });

  it("falls back to the completions provider without a runtime", async () => {
    const { llm, askStructured } = fakeLLM(JUDGMENT_1);
    await scoreClarity(ISSUE_1, PLAN_1, llm);
    expect(askStructured).toHaveBeenCalledOnce();
  });

  it("throws ClarityError on a malformed judgment", async () => {
    const { llm } = fakeLLM({ criteria: "crystalline", ambiguities: [], openQuestions: [] });
    await expect(scoreClarity(ISSUE_1, PLAN_1, llm)).rejects.toThrow(ClarityError);
  });

  it("throws ClarityError when the judge answers with prose", async () => {
    const { llm } = fakeLLM("the issue seems fine");
    await expect(scoreClarity(ISSUE_1, PLAN_1, llm)).rejects.toBeInstanceOf(ClarityError);
  });
});

describe("deriveClarityScore", () => {
  it.each([
    ["verifiable", 1],
    ["partial", 0.75],
    ["vague", 0.5],
  ] as const)("bases the score on criteria %s", (criteria, expected) => {
    expect(deriveClarityScore(judgment({ criteria }))).toBeCloseTo(expected);
  });

  // The inverted incentive #309 exists to kill: the old term subtracted 0.1 per
  // open question, so raising the hand LOWERED the score. Now it costs a third.
  it("charges a silent ambiguity three times what a flagged one costs", () => {
    const detail = "which priority levels exist";
    const silent = deriveClarityScore(
      judgment({
        criteria: "vague",
        ambiguities: [{ detail, resolvableFromRepo: false, flaggedByPlan: false }],
      }),
    );
    const flagged = deriveClarityScore(
      judgment({
        criteria: "vague",
        ambiguities: [{ detail, resolvableFromRepo: false, flaggedByPlan: true }],
      }),
    );
    expect(silent).toBeCloseTo(0.35);
    expect(flagged).toBeCloseTo(0.45);
    expect(flagged).toBeGreaterThan(silent);
  });

  it("pins the per-ambiguity arithmetic away from the clamp", () => {
    const score = deriveClarityScore(
      judgment({
        criteria: "vague",
        ambiguities: [
          { detail: "a", resolvableFromRepo: false, flaggedByPlan: false },
          { detail: "b", resolvableFromRepo: false, flaggedByPlan: false },
        ],
      }),
    );
    expect(score).toBeCloseTo(0.2);
  });

  it("charges nothing for an ambiguity the repo settles", () => {
    const score = deriveClarityScore(
      judgment({
        criteria: "partial",
        ambiguities: [
          { detail: "markup of the counter", resolvableFromRepo: true, flaggedByPlan: false },
          { detail: "placement in the header", resolvableFromRepo: true, flaggedByPlan: true },
        ],
      }),
    );
    expect(score).toBeCloseTo(0.75);
  });

  it("charges 0.10 per repo-knowledge question and nothing for issue ambiguity", () => {
    const repoKnowledge = deriveClarityScore(
      judgment({
        openQuestions: [
          { question: "where does the list live?", kind: "repo-knowledge" },
          { question: "which component renders a row?", kind: "repo-knowledge" },
        ],
      }),
    );
    const issueAmbiguity = deriveClarityScore(
      judgment({
        openQuestions: [
          { question: "which levels?", kind: "issue-ambiguity" },
          { question: "what default?", kind: "issue-ambiguity" },
        ],
      }),
    );
    expect(repoKnowledge).toBeCloseTo(0.8);
    expect(issueAmbiguity).toBeCloseTo(1);
  });

  it("clamps at 1 when nothing is charged", () => {
    expect(deriveClarityScore(judgment())).toBe(1);
  });

  it("clamps at 0 when the penalties exceed the base", () => {
    const score = deriveClarityScore(
      judgment({
        criteria: "vague",
        ambiguities: Array.from({ length: 5 }, (_, i) => ({
          detail: `a${i}`,
          resolvableFromRepo: false,
          flaggedByPlan: false,
        })),
        openQuestions: [{ question: "q", kind: "repo-knowledge" }],
      }),
    );
    expect(score).toBe(0);
  });
});

describe("buildClarityPrompt", () => {
  it("carries the issue body, the plan and the plan's open questions", () => {
    const prompt = buildClarityPrompt(ISSUE_2, {
      ...PLAN_2,
      openQuestions: ["Which priority levels does the product want?"],
    });
    expect(prompt).toContain("ISSUE-2");
    expect(prompt).toContain("- The UI shows it and lets you change it.");
    expect(prompt).toContain(PLAN_2.summary);
    expect(prompt).toContain("Which priority levels does the product want?");
    expect(prompt).toContain("Judge the ISSUE, not the quality of the plan");
  });

  it("says so explicitly when the plan raised no questions", () => {
    const prompt = buildClarityPrompt(ISSUE_1, PLAN_1);
    expect(prompt).toContain("(none — the plan raised no questions)");
  });

  it("includes the comments, where ambiguity usually gets resolved", () => {
    const prompt = buildClarityPrompt(
      {
        ...ISSUE_2,
        comments: [
          {
            author: "maintainer",
            body: "three levels is fine",
            createdAt: "2026-07-21T00:00:00.000Z",
          },
        ],
      },
      PLAN_2,
    );
    expect(prompt).toContain("three levels is fine");
  });

  it("survives an issue with no body", () => {
    const prompt = buildClarityPrompt({ ...ISSUE_1, body: undefined }, PLAN_1);
    expect(prompt).toContain("(The issue has no body.)");
  });
});
