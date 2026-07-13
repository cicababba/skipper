import { describe, expect, it } from "vitest";
import type { IssuePlan } from "@nestbrain/shared";
import { applySection, draftFor, sectionIsValid, splitLines } from "./plan-edit";

const plan: IssuePlan = {
  summary: "do the thing",
  files: [
    { path: "src/a.ts", reason: "entry", status: "existing" },
    { path: "src/b.ts", reason: "new module", status: "new" },
  ],
  steps: [
    { title: "step one", detail: "details", files: ["src/a.ts"], symbols: ["main"] },
    { title: "step two", detail: "", files: [], symbols: [] },
  ],
  acceptance: [{ criterion: "it works", addressedBy: "step one" }],
  risks: ["might break"],
  openQuestions: [],
  estimatedSize: "m",
};

describe("splitLines", () => {
  it("trims and drops blanks", () => {
    expect(splitLines(" a.ts \n\n  b.ts\n")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("draftFor / applySection round-trip", () => {
  it("is identity for every section when nothing changes", () => {
    for (const section of [
      "summary",
      "files",
      "steps",
      "acceptance",
      "risks",
      "openQuestions",
      "size",
    ] as const) {
      expect(applySection(plan, draftFor(plan, section))).toEqual(plan);
    }
  });

  it("steps drafts join and re-split files/symbols one per line", () => {
    const draft = draftFor(plan, "steps");
    if (draft.section !== "steps") throw new Error("wrong draft");
    expect(draft.steps[0].filesText).toBe("src/a.ts");
    const edited = {
      ...draft,
      steps: [{ ...draft.steps[0], filesText: "src/a.ts\n src/c.ts \n" }],
    };
    const next = applySection(plan, edited);
    expect(next.steps).toEqual([
      { title: "step one", detail: "details", files: ["src/a.ts", "src/c.ts"], symbols: ["main"] },
    ]);
  });

  it("does not mutate the source plan", () => {
    const before = JSON.parse(JSON.stringify(plan));
    const draft = draftFor(plan, "files");
    if (draft.section !== "files") throw new Error("wrong draft");
    draft.files[0].path = "changed.ts";
    applySection(plan, draft);
    expect(plan).toEqual(before);
  });

  it("drops fully blank acceptance rows and blank lines", () => {
    const next = applySection(plan, {
      section: "acceptance",
      acceptance: [{ criterion: " ", addressedBy: "" }, ...plan.acceptance],
    });
    expect(next.acceptance).toEqual(plan.acceptance);
    expect(applySection(plan, { section: "risks", lines: ["", " ok "] }).risks).toEqual(["ok"]);
  });
});

describe("sectionIsValid", () => {
  it("mirrors the Zod min constraints", () => {
    expect(sectionIsValid({ section: "summary", text: " " })).toBe(false);
    expect(sectionIsValid({ section: "summary", text: "s" })).toBe(true);
    expect(sectionIsValid({ section: "files", files: [] })).toBe(false);
    expect(sectionIsValid({ section: "files", files: [{ path: " ", reason: "" }] })).toBe(false);
    expect(sectionIsValid({ section: "files", files: [{ path: "a.ts", reason: "" }] })).toBe(true);
    expect(sectionIsValid({ section: "steps", steps: [] })).toBe(false);
    expect(
      sectionIsValid({
        section: "steps",
        steps: [{ title: "", detail: "", filesText: "", symbolsText: "" }],
      }),
    ).toBe(false);
    expect(
      sectionIsValid({
        section: "steps",
        steps: [{ title: "t", detail: "", filesText: "", symbolsText: "" }],
      }),
    ).toBe(true);
    expect(sectionIsValid({ section: "risks", lines: [] })).toBe(true);
    expect(sectionIsValid({ section: "acceptance", acceptance: [] })).toBe(true);
  });
});
