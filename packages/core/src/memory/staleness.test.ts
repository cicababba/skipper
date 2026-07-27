import { describe, expect, it } from "vitest";
import type { SolutionRecord, StoredPlan } from "@skipper/shared";
import { recordFilesTouched, stalenessFraction } from "./staleness";

// Staleness (#256): the pure half — which files a record claims, and how many of
// them are gone at the base ref. The git tree that feeds `existing` is the
// desktop sweep's business.

const REPO = { owner: "acme", name: "rocket" };

function planWith(files: string[]): StoredPlan {
  return {
    version: 2,
    itemId: "github:1",
    repo: REPO,
    generatedAt: "2026-07-01T00:00:00.000Z",
    model: "test",
    plan: {
      summary: "s",
      files: files.map((path) => ({ path, reason: "touched" })),
      steps: [],
      acceptance: [],
      risks: [],
      openQuestions: [],
      estimatedSize: "s",
    },
  };
}

function makeRecord(overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 2,
    itemId: "github:1",
    repo: REPO,
    title: "fix oauth token refresh",
    url: "https://example.test/7",
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("recordFilesTouched", () => {
  it("prefers the captured diff's files", () => {
    const rec = makeRecord({
      diffStats: { filesChanged: 1, totalChangedLines: 3, files: ["src/a.ts"] },
      plan: planWith(["src/planned.ts"]),
    });
    expect(recordFilesTouched(rec)).toEqual(["src/a.ts"]);
  });

  it("falls back to the plan's files when no diff was captured", () => {
    expect(recordFilesTouched(makeRecord({ plan: planWith(["src/planned.ts"]) }))).toEqual([
      "src/planned.ts",
    ]);
  });

  it("falls back to a note's linked files", () => {
    const rec = makeRecord({ kind: "note", note: { body: "b", files: ["src/terminal.ts"] } });
    expect(recordFilesTouched(rec)).toEqual(["src/terminal.ts"]);
  });

  it("returns [] when the record claims nothing", () => {
    expect(recordFilesTouched(makeRecord())).toEqual([]);
    expect(recordFilesTouched(makeRecord({ kind: "note", note: { body: "b" } }))).toEqual([]);
  });

  it("prefers an empty diff file list over the plan — the diff is the truth", () => {
    const rec = makeRecord({
      diffStats: { filesChanged: 0, totalChangedLines: 0, files: [] },
      plan: planWith(["src/planned.ts"]),
    });
    expect(recordFilesTouched(rec)).toEqual([]);
  });
});

describe("stalenessFraction", () => {
  const tree = new Set(["src/a.ts", "src/b.ts"]);

  it("is undefined when there is nothing to measure", () => {
    expect(stalenessFraction([], tree)).toBeUndefined();
  });

  it("is 0 when every file is still there", () => {
    expect(stalenessFraction(["src/a.ts", "src/b.ts"], tree)).toBe(0);
  });

  it("is 1 when every file is gone", () => {
    expect(stalenessFraction(["src/gone.ts", "src/also-gone.ts"], tree)).toBe(1);
  });

  it("is the missing fraction in between", () => {
    expect(stalenessFraction(["src/a.ts", "src/gone.ts"], tree)).toBe(0.5);
    expect(stalenessFraction(["src/a.ts", "src/b.ts", "src/gone.ts"], tree)).toBeCloseTo(1 / 3, 10);
  });

  it("counts a duplicated file once", () => {
    expect(stalenessFraction(["src/gone.ts", "src/gone.ts", "src/a.ts"], tree)).toBe(0.5);
  });

  it("is 1 against an empty tree", () => {
    expect(stalenessFraction(["src/a.ts"], new Set())).toBe(1);
  });
});
