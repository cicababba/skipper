import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssuePlan } from "@skipper/shared";
import { computeConfidence } from "./score";
import type { LLMProviderInterface } from "../llm";
import type { PlanIssueInput } from "../planner";

const PLAN: IssuePlan = {
  summary: "do the thing",
  context: [],
  files: [{ path: "src/a.ts", reason: "hosts the change" }],
  steps: [{ title: "edit", detail: "do it", files: ["src/a.ts"], symbols: ["run"] }],
  outOfScope: [],
  acceptance: [{ criterion: "works", addressedBy: "the edit" }],
  risks: [],
  verificationCommands: [],
  manualChecks: [],
  openQuestions: [],
  estimatedSize: "s",
};

const ISSUE: PlanIssueInput = {
  key: "1",
  title: "issue 1",
  url: "https://example.com/1",
  labels: [],
  body: "the body",
};

/** Provider whose critic verdict resolves deterministically; ask/agent unused here. */
function fakeProvider(): LLMProviderInterface {
  return {
    name: "claude-cli",
    ask: async () => ({ text: "" }),
    askStructured: async () => ({ verdict: "approve", objections: [] }),
    agent: async () => ({ text: "" }),
  } as unknown as LLMProviderInterface;
}

let repoPath: string;
beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "nb-score-"));
  await writeFile(join(repoPath, "a.ts"), "export function run() {}\n", "utf-8");
});
afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe("computeConfidence skipConvergence (#164)", () => {
  it("skips the extra plan runs, records reason 'rescore', renormalizes weights", async () => {
    const generatePlan = vi.fn();
    const report = await computeConfidence({
      plan: PLAN,
      issue: ISSUE,
      repoPath,
      llm: fakeProvider(),
      skipConvergence: { reason: "rescore", detail: "plan revised via chat" },
      deps: { generatePlan },
    });

    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.convergenceSkipped).toEqual({
      reason: "rescore",
      detail: "plan revised via chat",
    });
    expect(report.signals.convergence).toBeUndefined();

    // Weights renormalize over the present signals; convergence carries none.
    expect(report.weights.convergence).toBe(0);
    const total =
      report.weights.groundedness + report.weights.critic + report.weights.clarity;
    expect(total).toBeCloseTo(1, 10);
  });

  it("wins over the decisive/disabled heuristic even when extraPlanRuns is 0", async () => {
    const generatePlan = vi.fn();
    const report = await computeConfidence({
      plan: PLAN,
      issue: ISSUE,
      repoPath,
      llm: fakeProvider(),
      extraPlanRuns: 0,
      skipConvergence: { reason: "rescore", detail: "plan revised via chat" },
      deps: { generatePlan },
    });

    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.convergenceSkipped?.reason).toBe("rescore");
  });
});
