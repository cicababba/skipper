import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfidenceReport, IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { PlanIssueInput } from "../src/planner";
import {
  computeConfidence,
  reachableBand,
  scoreClarity,
  DEFAULT_CONFIDENCE_WEIGHTS,
} from "../src/confidence";

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
    expect(report.convergenceSkipped?.reason).toBe("disabled");
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

describe("reachableBand", () => {
  it("bounds the composite over every convergence value in [0,1]", () => {
    const band = reachableBand({
      groundedness: { score: 1 },
      critic: { score: 1 },
      clarity: { score: 1 },
    } as ConfidenceReport["signals"]);
    expect(band.min).toBeCloseTo(0.75); // convergence = 0
    expect(band.max).toBeCloseTo(1); // convergence = 1
  });

  it("spans the full range when no other signal scored", () => {
    const band = reachableBand({});
    expect(band.min).toBe(0);
    expect(band.max).toBe(1);
  });

  it("contains the absent-convergence composite, so a decisive band is honest", () => {
    const signals = {
      groundedness: { score: 0.8 },
      critic: { score: 0.6 },
      clarity: { score: 0.4 },
    } as ConfidenceReport["signals"];
    const band = reachableBand(signals);
    const raw = 0.35 * 0.8 + 0.3 * 0.6 + 0.1 * 0.4;
    const renormalized = raw / (0.35 + 0.3 + 0.1);
    expect(renormalized).toBeGreaterThanOrEqual(band.min);
    expect(renormalized).toBeLessThanOrEqual(band.max);
  });
});

describe("computeConfidence — adaptive convergence (#50)", () => {
  it("skips the extra runs when no convergence value can move the gate", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      // Band for perfect signals is [0.75, 1]; both ends resolve to queued here.
      thresholds: { high: 0.6, low: 0.3 },
      deps: { generatePlan },
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.signals.convergence).toBeUndefined();
    expect(report.convergenceSkipped?.reason).toBe("decisive");
    expect(report.convergenceSkipped?.detail).toContain("queued");
    expect(report.weights.convergence).toBe(0);
    const w = report.weights;
    expect(w.groundedness + w.critic + w.clarity).toBeCloseTo(1);
  });

  it("skips when the plan is decisively bad, without paying for more plans", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan({
        files: [{ path: "src/ghost.ts", reason: "r" }],
        steps: [{ title: "t", detail: "d", files: ["src/ghost.ts"], symbols: ["noSuchSymbol"] }],
        openQuestions: ["a?", "b?", "c?"],
      }),
      issue: { ...ISSUE, body: undefined },
      repoPath: repo,
      llm: fakeLLM({ verdict: "reject", objections: [] }),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.convergenceSkipped?.reason).toBe("decisive");
    expect(report.convergenceSkipped?.detail).toContain("needs-input");
  });

  it("still pays for the runs under default thresholds, where the high band is reachable", async () => {
    // Groundedness+critic+clarity carry 0.75 total, so perfect cheap signals
    // bottom out at 0.75 — below the 0.85 gate. Convergence can still decide.
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
    expect(report.convergenceSkipped).toBeUndefined();
    expect(report.signals.convergence?.score).toBeCloseTo(1);
  });

  // #62: the skip is computed for the gate that will actually run. Under on/off the
  // queued/plan-gate choice is pinned, so a band that only clears the low floor is
  // already decisive — no reason to pay for two more agentic plan runs.
  it.each([
    ["on", "queued"],
    ["off", "plan-gate"],
  ] as const)("skips the extra runs when autoCoding is %s", async (autoCoding, target) => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      // Default thresholds: the [0.75, 1] band straddles high, so auto would pay.
      autoCoding,
      deps: { generatePlan },
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.convergenceSkipped?.reason).toBe("decisive");
    expect(report.convergenceSkipped?.detail).toContain(target);
  });

  it("still pays under on when the band straddles the low floor", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      // Band [0.75, 1] straddles low, so needs-input is still reachable — and the
      // floor outranks the mode.
      thresholds: { high: 0.99, low: 0.8 },
      autoCoding: "on",
      deps: { generatePlan },
    });
    expect(generatePlan).toHaveBeenCalledTimes(2);
    expect(report.convergenceSkipped).toBeUndefined();
  });

  it("runs convergence when every other signal failed", async () => {
    const generatePlan = vi.fn(async () => plan());
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
      repoPath: "/nonexistent-repo-path",
      llm,
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(generatePlan).toHaveBeenCalledTimes(2);
    expect(report.convergenceSkipped).toBeUndefined();
  });
});
