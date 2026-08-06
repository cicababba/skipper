import { describe, it, expect } from "vitest";
import type { GroundednessSignal, IssuePlan, PlanStep } from "@skipper/shared";
import { newGroundednessMisses, overlappingPaths, planCitedPaths } from "../src/orchestrator";

function step(files: string[], overrides: Partial<PlanStep> = {}): PlanStep {
  return { title: "t", detail: "d", files, symbols: [], ...overrides };
}

function plan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "s",
    files: [],
    steps: [],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "m",
    ...overrides,
  };
}

function groundedness(overrides: Partial<GroundednessSignal> = {}): GroundednessSignal {
  return {
    score: 0.9,
    filesChecked: 2,
    filesFound: 2,
    symbolsChecked: 1,
    symbolsFound: 1,
    missingFiles: [],
    missingSymbols: [],
    newFiles: [],
    ...overrides,
  };
}

describe("planCitedPaths", () => {
  it("unions files[].path with steps[].files, deduped and sorted", () => {
    const p = plan({
      files: [
        { path: "src/b.ts", reason: "r" },
        { path: "src/a.ts", reason: "r" },
      ],
      steps: [step(["src/a.ts", "src/c.ts"]), step(["src/c.ts"])],
    });
    expect(planCitedPaths(p)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("normalizes ./ segments and backslashes onto one repo-relative form", () => {
    const p = plan({
      files: [{ path: "./src/a.ts", reason: "r" }],
      steps: [step(["src\\nested\\b.ts", "src/./a.ts"])],
    });
    expect(planCitedPaths(p)).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("rejects absolute paths and ../ escapes", () => {
    const p = plan({
      files: [
        { path: "/etc/passwd", reason: "r" },
        { path: "C:\\Windows\\hosts", reason: "r" },
        { path: "../outside.ts", reason: "r" },
        { path: "..", reason: "r" },
        { path: "src/keep.ts", reason: "r" },
      ],
    });
    expect(planCitedPaths(p)).toEqual(["src/keep.ts"]);
  });

  it("drops blank citations and bare dots", () => {
    const p = plan({
      files: [{ path: "  ", reason: "r" }],
      steps: [step([".", "", "src/a.ts"])],
    });
    expect(planCitedPaths(p)).toEqual(["src/a.ts"]);
  });

  it("returns nothing for a plan that cites nothing", () => {
    expect(planCitedPaths(plan())).toEqual([]);
  });
});

describe("overlappingPaths", () => {
  const p = plan({
    files: [{ path: "src/a.ts", reason: "r" }],
    steps: [step(["src/b.ts", "docs/readme.md"])],
  });

  it("returns the sorted intersection with the changed set", () => {
    expect(overlappingPaths(p, ["src/b.ts", "src/other.ts", "src/a.ts"])).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("is empty when the change set touches nothing the plan cites", () => {
    expect(overlappingPaths(p, ["src/other.ts"])).toEqual([]);
  });

  it("is empty when there is no textual evidence at all", () => {
    expect(overlappingPaths(p, [])).toEqual([]);
  });

  it("normalizes the changed paths before comparing", () => {
    expect(overlappingPaths(p, ["./src/a.ts", "docs\\readme.md"])).toEqual([
      "docs/readme.md",
      "src/a.ts",
    ]);
  });
});

describe("newGroundednessMisses", () => {
  it("reports only the misses the stored report did not already carry", () => {
    const before = groundedness({ missingFiles: ["src/gone.ts"], missingSymbols: ["oldSym"] });
    const after = groundedness({
      missingFiles: ["src/gone.ts", "src/fresh.ts"],
      missingSymbols: ["oldSym", "newSym"],
    });
    expect(newGroundednessMisses(before, after)).toEqual({
      files: ["src/fresh.ts"],
      symbols: ["newSym"],
    });
  });

  it("reports nothing when the fresh run misses the same things", () => {
    const signal = groundedness({ missingFiles: ["src/gone.ts"], missingSymbols: ["sym"] });
    expect(newGroundednessMisses(signal, signal)).toEqual({ files: [], symbols: [] });
  });

  it("reports nothing when the fresh run misses fewer things", () => {
    const before = groundedness({ missingFiles: ["src/gone.ts"], missingSymbols: ["sym"] });
    const after = groundedness({ missingFiles: [], missingSymbols: [] });
    expect(newGroundednessMisses(before, after)).toEqual({ files: [], symbols: [] });
  });

  it("treats every miss as new when there is no prior report to compare with", () => {
    const after = groundedness({ missingFiles: ["src/a.ts"], missingSymbols: ["sym"] });
    expect(newGroundednessMisses(undefined, after)).toEqual({
      files: ["src/a.ts"],
      symbols: ["sym"],
    });
  });

  it("reports nothing when a plan with no prior report resolves cleanly", () => {
    expect(newGroundednessMisses(undefined, groundedness())).toEqual({ files: [], symbols: [] });
  });
});
