import { describe, expect, it } from "vitest";
import type { IssuePlan } from "../src/plan";
import { acceptanceString, diffCount, diffPlans, sectionDiffCounts } from "../src/plan-diff";

const base: IssuePlan = {
  summary: "do the thing",
  context: ["a.ts:10 uses a global"],
  files: [
    { path: "src/a.ts", reason: "entry", status: "existing" },
    { path: "src/b.ts", reason: "new module", status: "new" },
  ],
  steps: [
    { title: "step one", detail: "details", files: ["src/a.ts"], symbols: ["main"] },
    { title: "step two", detail: "", files: [], symbols: [] },
  ],
  outOfScope: ["do not touch the poller"],
  acceptance: [{ criterion: "it works", addressedBy: "step one" }],
  risks: ["might break"],
  verificationCommands: ["pnpm test"],
  manualChecks: ["open the app"],
  openQuestions: [],
  estimatedSize: "m",
};

function clone(p: IssuePlan): IssuePlan {
  return JSON.parse(JSON.stringify(p));
}

describe("diffPlans", () => {
  it("reports no changes for identical plans", () => {
    const diff = diffPlans(base, clone(base));
    expect(diffCount(diff)).toBe(0);
    expect(diff.summary).toBeNull();
    expect(diff.size).toBeNull();
  });

  it("diffs string lists as added/removed", () => {
    const after = clone(base);
    after.risks = ["might break", "also this"];
    const diff = diffPlans(base, after);
    expect(diff.risks.added).toEqual(["also this"]);
    expect(diff.risks.removed).toEqual([]);
  });

  it("treats an undefined optional array as empty in both directions", () => {
    const noContext = clone(base);
    delete noContext.context;
    // base has context, after does not → removed
    expect(diffPlans(base, noContext).context.removed).toEqual(["a.ts:10 uses a global"]);
    // after has context, before does not → added
    expect(diffPlans(noContext, base).context.added).toEqual(["a.ts:10 uses a global"]);
  });

  it("diffs files added, removed, and modified by path", () => {
    const after = clone(base);
    after.files = [
      { path: "src/a.ts", reason: "changed reason", status: "existing" },
      { path: "src/c.ts", reason: "brand new", status: "new" },
    ];
    const diff = diffPlans(base, after);
    expect(diff.files.added.map((f) => f.path)).toEqual(["src/c.ts"]);
    expect(diff.files.removed.map((f) => f.path)).toEqual(["src/b.ts"]);
    expect(diff.files.modified).toHaveLength(1);
    expect(diff.files.modified[0].after.reason).toBe("changed reason");
  });

  it("flags a file status change as modified", () => {
    const after = clone(base);
    after.files[0].status = "new";
    const diff = diffPlans(base, after);
    expect(diff.files.modified).toHaveLength(1);
  });

  it("diffs a step modified per field", () => {
    const after = clone(base);
    after.steps[0].detail = "new details";
    after.steps[0].symbols = ["main", "helper"];
    const diff = diffPlans(base, after);
    expect(diff.steps.added).toEqual([]);
    expect(diff.steps.removed).toEqual([]);
    expect(diff.steps.modified).toHaveLength(1);
    expect(diff.steps.modified[0].after.detail).toBe("new details");
  });

  it("treats a retitled step as removed + added", () => {
    const after = clone(base);
    after.steps[0].title = "step one renamed";
    const diff = diffPlans(base, after);
    expect(diff.steps.added.map((s) => s.title)).toEqual(["step one renamed"]);
    expect(diff.steps.removed.map((s) => s.title)).toEqual(["step one"]);
    expect(diff.steps.modified).toEqual([]);
  });

  it("treats an acceptance addressedBy change as removed + added", () => {
    const after = clone(base);
    after.acceptance[0].addressedBy = "step two";
    const diff = diffPlans(base, after);
    expect(diff.acceptance.removed).toEqual(["it works — step one"]);
    expect(diff.acceptance.added).toEqual(["it works — step two"]);
  });

  it("diffs summary and size", () => {
    const after = clone(base);
    after.summary = "do a different thing";
    after.estimatedSize = "l";
    const diff = diffPlans(base, after);
    expect(diff.summary).toEqual({ before: "do the thing", after: "do a different thing" });
    expect(diff.size).toEqual({ before: "m", after: "l" });
  });

  it("aggregates every change into diffCount", () => {
    const after = clone(base);
    after.summary = "changed"; // +1
    after.estimatedSize = "l"; // +1
    after.risks = ["different"]; // +1 added, +1 removed
    after.steps[0].detail = "x"; // +1 modified
    const diff = diffPlans(base, after);
    expect(diffCount(diff)).toBe(5);
  });
});

describe("sectionDiffCounts", () => {
  it("reports zero for every section on an identical plan", () => {
    const counts = sectionDiffCounts(diffPlans(base, clone(base)));
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
      expect(counts[key]).toBe(0);
    }
  });

  it("scores summary and size as 0 or 1", () => {
    const after = clone(base);
    after.summary = "do a different thing";
    after.estimatedSize = "l";
    const counts = sectionDiffCounts(diffPlans(base, after));
    expect(counts.summary).toBe(1);
    expect(counts.size).toBe(1);
  });

  it("counts steps and files added + removed + modified", () => {
    const after = clone(base);
    after.steps[0].detail = "reworked"; // modified
    after.steps.push({ title: "step three", detail: "", files: [], symbols: [] }); // added
    after.files = [
      { path: "src/a.ts", reason: "entry", status: "existing" }, // unchanged
      { path: "src/c.ts", reason: "brand new", status: "new" }, // added (src/b.ts removed)
    ];
    const counts = sectionDiffCounts(diffPlans(base, after));
    expect(counts.steps).toBe(2); // 1 added + 1 modified
    expect(counts.files).toBe(2); // 1 added + 1 removed
  });

  it("sums to diffCount on a multi-section diff", () => {
    const after = clone(base);
    after.summary = "do a different thing"; // summary 1
    after.estimatedSize = "l"; // size 1
    after.steps[0].detail = "reworked"; // steps 1 (modified)
    after.steps.push({ title: "step three", detail: "", files: [], symbols: [] }); // steps 1 (added)
    after.files = [{ path: "src/c.ts", reason: "brand new", status: "new" }]; // files 2 (a+b removed, c added → 2 removed + 1 added = 3)
    after.acceptance[0].addressedBy = "step two"; // acceptance 2 (removed + added)
    after.risks = ["might break", "also this"]; // risks 1 (added)
    const diff = diffPlans(base, after);
    const counts = sectionDiffCounts(diff);
    const summed = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(summed).toBe(diffCount(diff));
  });
});

describe("acceptanceString", () => {
  it("formats a criterion and its addressedBy as the matching key", () => {
    expect(acceptanceString({ criterion: "it works", addressedBy: "step one" })).toBe(
      "it works — step one",
    );
  });
});
