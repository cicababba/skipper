import { describe, it, expect } from "vitest";
import type { IssuePlan } from "@nestbrain/shared";
import { scoreConvergence } from "../src/confidence";

function plan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "s",
    files: [{ path: "src/a.ts", reason: "r" }],
    steps: [{ title: "t", detail: "d", files: ["src/a.ts"], symbols: [] }],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
    ...overrides,
  };
}

describe("scoreConvergence", () => {
  it("scores identical plans 1.0 and not divergent", () => {
    const s = scoreConvergence([plan(), plan(), plan()]);
    expect(s.score).toBeCloseTo(1);
    expect(s.divergent).toBe(false);
    expect(s.planCount).toBe(3);
    expect(s.sharedFiles).toEqual(["src/a.ts"]);
    expect(s.disputedFiles).toEqual([]);
  });

  it("scores disjoint file sets low and divergent, listing disputed files", () => {
    const a = plan();
    const b = plan({
      files: [{ path: "src/b.ts", reason: "r" }],
      steps: [{ title: "t", detail: "d", files: ["src/b.ts"], symbols: [] }],
      estimatedSize: "xl",
    });
    const s = scoreConvergence([a, b]);
    expect(s.fileJaccard).toBe(0);
    expect(s.divergent).toBe(true);
    expect(s.sharedFiles).toEqual([]);
    expect(s.disputedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("penalizes size spread", () => {
    const s = scoreConvergence([plan({ estimatedSize: "xs" }), plan({ estimatedSize: "xl" })]);
    expect(s.sizeAgreement).toBe(0);
    expect(s.fileJaccard).toBe(1);
  });

  it("penalizes step-count spread", () => {
    const twoSteps = plan({
      steps: [
        { title: "t1", detail: "d", files: ["src/a.ts"], symbols: [] },
        { title: "t2", detail: "d", files: ["src/a.ts"], symbols: [] },
      ],
    });
    const s = scoreConvergence([plan(), twoSteps]);
    expect(s.stepCountAgreement).toBe(0.5);
  });

  it("throws on fewer than 2 plans", () => {
    expect(() => scoreConvergence([plan()])).toThrow(/at least 2/);
    expect(() => scoreConvergence([])).toThrow(/at least 2/);
  });
});
