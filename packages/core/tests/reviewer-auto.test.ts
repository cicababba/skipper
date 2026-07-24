import { describe, it, expect } from "vitest";
import {
  resolveReviewMode,
  AUTO_MAX_CHANGED_LINES,
  AUTO_MAX_FILES,
  type DiffStats,
} from "../src/reviewer";

const smallStats: DiffStats = {
  filesChanged: 2,
  totalChangedLines: 23,
  files: ["src/a.ts", "src/b.ts"],
};

function input(overrides: Partial<Parameters<typeof resolveReviewMode>[0]> = {}) {
  return {
    mode: "auto" as const,
    stats: smallStats,
    planConfidence: 0.91,
    highThreshold: 0.85,
    ...overrides,
  };
}

describe("resolveReviewMode", () => {
  it("always reviews in on mode", () => {
    expect(resolveReviewMode(input({ mode: "on" }))).toEqual({
      review: true,
      reason: "review: on",
    });
  });

  it("never reviews in off mode", () => {
    expect(resolveReviewMode(input({ mode: "off" }))).toEqual({
      review: false,
      reason: "review skipped (mode: off)",
    });
  });

  // on/off bypass the heuristic entirely — the small clean diff below would be
  // skipped by auto, and the risky path would be reviewed by auto.
  it("on reviews a diff that auto would skip", () => {
    expect(resolveReviewMode(input({ mode: "on" })).review).toBe(true);
  });

  it("off skips a diff that auto would review", () => {
    const risky = { filesChanged: 9, totalChangedLines: 412, files: [".github/workflows/ci.yml"] };
    expect(resolveReviewMode(input({ mode: "off", stats: risky })).review).toBe(false);
  });

  it("auto skips when all conditions hold, with the numbers in the reason", () => {
    const result = resolveReviewMode(input());
    expect(result.review).toBe(false);
    expect(result.reason).toContain("0.91 >= 0.85");
    expect(result.reason).toContain("23 changed lines in 2 files");
  });

  it("auto reviews on low confidence", () => {
    const result = resolveReviewMode(input({ planConfidence: 0.7 }));
    expect(result.review).toBe(true);
    expect(result.reason).toContain("0.70 < 0.85");
  });

  it("auto reviews on missing confidence", () => {
    const result = resolveReviewMode(input({ planConfidence: undefined }));
    expect(result.review).toBe(true);
    expect(result.reason).toContain("plan confidence unavailable");
  });

  it("auto reviews on a big diff", () => {
    const result = resolveReviewMode(
      input({ stats: { ...smallStats, totalChangedLines: 412 } }),
    );
    expect(result.review).toBe(true);
    expect(result.reason).toContain(`412 changed lines > ${AUTO_MAX_CHANGED_LINES}`);
  });

  it("auto reviews on too many files", () => {
    const files = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`);
    const result = resolveReviewMode(
      input({ stats: { filesChanged: 6, totalChangedLines: 10, files } }),
    );
    expect(result.review).toBe(true);
    expect(result.reason).toContain(`6 files > ${AUTO_MAX_FILES}`);
  });

  it.each([
    ".github/workflows/ci.yml",
    "db/migrations/001-init.sql",
    "src/auth/tokens.ts",
    "Dockerfile",
    "package.json",
  ])("auto reviews on risky path %s", (risky) => {
    const result = resolveReviewMode(
      input({ stats: { filesChanged: 1, totalChangedLines: 5, files: [risky] } }),
    );
    expect(result.review).toBe(true);
    expect(result.reason).toContain(`risky path ${risky}`);
  });
});
