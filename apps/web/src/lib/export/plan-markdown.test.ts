import { describe, expect, it } from "vitest";
import type { ConfidenceReport, IssuePlan, StoredPlan } from "@skipper/shared";
import { planMarkdown } from "./plan-markdown";

function plan(over: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "Do the thing",
    files: [],
    steps: [],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
    ...over,
  };
}

function stored(over: Partial<StoredPlan> = {}, planOver: Partial<IssuePlan> = {}): StoredPlan {
  return {
    version: 2,
    itemId: "github:1",
    repo: { owner: "acme", name: "widget" },
    generatedAt: "2026-07-23T10:00:00.000Z",
    model: "claude-opus",
    plan: plan(planOver),
    ...over,
  };
}

const confidence: ConfidenceReport = {
  version: 1,
  composite: 0.87,
  weights: { convergence: 0, critic: 1, clarity: 0 },
  signals: {},
  errors: [],
  computedAt: "2026-07-23T10:00:00.000Z",
};

describe("planMarkdown", () => {
  it("renders only the header, metadata and summary for a minimal plan", () => {
    const md = planMarkdown(stored());
    expect(md).toContain("# Plan");
    expect(md).toContain("- **Generated:** 2026-07-23T10:00:00.000Z");
    expect(md).toContain("- **Model:** claude-opus");
    expect(md).toContain("- **Estimated size:** s");
    expect(md).toContain("## Summary\n\nDo the thing");
    // No confidence and no empty sections.
    expect(md).not.toContain("Confidence");
    expect(md).not.toContain("## Context");
    expect(md).not.toContain("## Files");
    expect(md).not.toContain("## Steps");
    expect(md).not.toContain("## Out of scope");
    expect(md).not.toContain("## Acceptance");
    expect(md).not.toContain("## Risks");
    expect(md).not.toContain("## Verification commands");
    expect(md).not.toContain("## Manual checks");
    expect(md).not.toContain("## Open questions");
  });

  it("renders confidence, context and file status markers on a partial plan", () => {
    const md = planMarkdown(
      stored(
        { confidence },
        {
          context: ["repo uses ESM"],
          files: [
            { path: "src/a.ts", reason: "edit here", status: "existing" },
            { path: "src/b.ts", reason: "create this", status: "new" },
          ],
          risks: ["might break x"],
        },
      ),
    );
    expect(md).toContain("- **Confidence:** 87%");
    expect(md).toContain("## Context\n\n- repo uses ESM");
    expect(md).toContain("- `src/a.ts` — edit here");
    expect(md).toContain("- `src/b.ts` — create this _(new)_");
    // Existing file carries no new-marker.
    expect(md).not.toContain("edit here _(new)_");
    expect(md).toContain("## Risks\n\n- might break x");
  });

  it("renders every section for a full plan", () => {
    const md = planMarkdown(
      stored(
        { confidence },
        {
          context: ["fact"],
          files: [{ path: "src/a.ts", reason: "r" }],
          steps: [
            {
              title: "First",
              detail: "do it",
              files: ["src/a.ts", "src/b.ts"],
              symbols: ["foo"],
              createdSymbols: ["bar"],
            },
          ],
          outOfScope: ["do not touch db"],
          acceptance: [{ criterion: "it works", addressedBy: "step 1" }],
          risks: ["risk1"],
          verificationCommands: ["pnpm test"],
          manualChecks: ["click it"],
          openQuestions: ["what about z"],
        },
      ),
    );
    expect(md).toContain("## Steps\n\n### 1. First");
    expect(md).toContain("do it");
    expect(md).toContain("Files: `src/a.ts`, `src/b.ts`");
    expect(md).toContain("Symbols: `foo`");
    expect(md).toContain("Creates: `bar`");
    expect(md).toContain("## Out of scope\n\n- do not touch db");
    expect(md).toContain("## Acceptance\n\n- it works — step 1");
    expect(md).toContain("## Verification commands\n\n- `pnpm test`");
    expect(md).toContain("## Manual checks\n\n- click it");
    expect(md).toContain("## Open questions\n\n- what about z");
  });
});
