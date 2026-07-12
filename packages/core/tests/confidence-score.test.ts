import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssuePlan } from "@nestbrain/shared";
import type { LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { PlanIssueInput } from "../src/planner";
import { computeConfidence, scoreClarity, DEFAULT_CONFIDENCE_WEIGHTS } from "../src/confidence";

const ISSUE: PlanIssueInput = {
  number: 42,
  title: "Add retry to the poller",
  url: "https://github.com/o/r/issues/42",
  labels: [],
  body: "The poller should retry on 429 with backoff.\n\nAcceptance criteria:\n- [ ] retries",
};

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "nb-score-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "poller.ts"), "export function pollNow() {}\n", "utf-8");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function plan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "s",
    files: [{ path: "src/poller.ts", reason: "r" }],
    steps: [{ title: "t", detail: "d", files: ["src/poller.ts"], symbols: ["pollNow"] }],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
    ...overrides,
  };
}

function fakeLLM(structuredReply: unknown): LLMProviderInterface {
  return {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "" }),
    askStructured: vi.fn(async (): Promise<unknown> => structuredReply),
  } as unknown as LLMProviderInterface;
}

const APPROVE = { verdict: "approve", objections: [] };

describe("scoreClarity", () => {
  it("rewards acceptance criteria, repro steps and a real body", () => {
    const s = scoreClarity(
      "Acceptance criteria:\n- [ ] works\n\nSteps to reproduce:\n1. run it. This body is long enough to count as present for the heuristic.",
      plan(),
    );
    expect(s.hasAcceptanceCriteria).toBe(true);
    expect(s.hasReproSteps).toBe(true);
    expect(s.bodyPresent).toBe(true);
    expect(s.score).toBe(1);
  });

  it("penalizes open questions and missing body", () => {
    const s = scoreClarity(undefined, plan({ openQuestions: ["a?", "b?", "c?"] }));
    expect(s.bodyPresent).toBe(false);
    expect(s.openQuestionCount).toBe(3);
    expect(s.score).toBeCloseTo(0.2);
  });
});

describe("computeConfidence", () => {
  it("runs all signals and weights them", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(generatePlan).toHaveBeenCalledTimes(2);
    expect(report.signals.groundedness?.score).toBeCloseTo(1);
    expect(report.signals.convergence?.score).toBeCloseTo(1);
    expect(report.signals.critic?.score).toBe(1);
    expect(report.signals.clarity).toBeDefined();
    expect(report.errors).toEqual([]);
    const w = report.weights;
    expect(w.groundedness + w.convergence + w.critic + w.clarity).toBeCloseTo(1);
    expect(report.composite).toBeGreaterThan(0.9);
  });

  it("omits convergence and renormalizes when all extra runs fail", async () => {
    const generatePlan = vi.fn(async () => {
      throw new Error("cli exploded");
    });
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(report.signals.convergence).toBeUndefined();
    expect(report.errors).toEqual(["convergence: 2/2 extra plan runs failed"]);
    expect(report.weights.convergence).toBe(0);
    const w = report.weights;
    expect(w.groundedness + w.critic + w.clarity).toBeCloseTo(1);
    expect(w.groundedness).toBeGreaterThan(DEFAULT_CONFIDENCE_WEIGHTS.groundedness);
  });

  it("captures a critic failure in errors and scores the rest", async () => {
    const llm = {
      name: "claude-cli",
      ask: async (): Promise<LLMResponse> => ({ text: "" }),
      askStructured: vi.fn(async () => {
        throw new Error("no cli");
      }),
    } as unknown as LLMProviderInterface;
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm,
      extraPlanRuns: 0,
    });
    expect(report.signals.critic).toBeUndefined();
    expect(report.errors).toEqual(["critic: no cli"]);
    expect(report.signals.groundedness).toBeDefined();
    expect(report.signals.clarity).toBeDefined();
    expect(report.composite).toBeGreaterThan(0);
  });

  it("skips convergence entirely when extraPlanRuns is 0", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 0,
      deps: { generatePlan },
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.signals.convergence).toBeUndefined();
    expect(report.errors).toEqual([]);
  });

  it("counts partial extra-run failures but still scores convergence", async () => {
    let calls = 0;
    const generatePlan = vi.fn(async () => {
      if (calls++ === 0) throw new Error("flaky");
      return plan();
    });
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(report.signals.convergence?.planCount).toBe(2);
    expect(report.errors).toEqual(["convergence: 1/2 extra plan runs failed"]);
  });
});
