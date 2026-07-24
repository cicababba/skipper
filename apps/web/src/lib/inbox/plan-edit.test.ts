import { describe, expect, it } from "vitest";
import type { IssuePlan } from "@skipper/shared";
import { applySection, draftFor, sectionIsValid, splitLines } from "./plan-edit";

const plan: IssuePlan = {
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

describe("splitLines", () => {
  it("trims and drops blanks", () => {
    expect(splitLines(" a.ts \n\n  b.ts\n")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("draftFor / applySection round-trip", () => {
  it("is identity for every section when nothing changes", () => {
    for (const section of [
      "summary",
      "context",
      "files",
      "steps",
      "outOfScope",
      "acceptance",
      "risks",
      "verificationCommands",
      "manualChecks",
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

  it("steps draft round-trip preserves createdSymbols", () => {
    const withCreated: IssuePlan = {
      ...plan,
      steps: [
        { title: "wire", detail: "", files: ["src/a.ts"], symbols: ["main"], createdSymbols: ["newFn"] },
      ],
    };
    const draft = draftFor(withCreated, "steps");
    if (draft.section !== "steps") throw new Error("wrong draft");
    expect(draft.steps[0].createdSymbolsText).toBe("newFn");
    expect(applySection(withCreated, draft)).toEqual(withCreated);
  });

  it("absent createdSymbols stays absent after a steps round-trip", () => {
    const draft = draftFor(plan, "steps");
    if (draft.section !== "steps") throw new Error("wrong draft");
    expect(draft.steps[0].createdSymbolsText).toBe("");
    const next = applySection(plan, draft);
    expect(next.steps.every((s) => !("createdSymbols" in s))).toBe(true);
    expect(next).toEqual(plan);
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

describe("old stored plan without the new optional fields", () => {
  const oldPlan: IssuePlan = {
    summary: "legacy",
    files: [{ path: "src/a.ts", reason: "entry" }],
    steps: [{ title: "step", detail: "", files: [], symbols: [] }],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
  };

  it("draftFor returns empty lines for each new section", () => {
    for (const section of [
      "context",
      "outOfScope",
      "verificationCommands",
      "manualChecks",
    ] as const) {
      const draft = draftFor(oldPlan, section);
      if (!("lines" in draft)) throw new Error("wrong draft");
      expect(draft.lines).toEqual([]);
    }
  });

  it("applySection writes the field as [] without touching other fields", () => {
    const next = applySection(oldPlan, { section: "context", lines: [] });
    expect(next.context).toEqual([]);
    expect(next).toEqual({ ...oldPlan, context: [] });
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
        steps: [{ title: "", detail: "", filesText: "", symbolsText: "", createdSymbolsText: "" }],
      }),
    ).toBe(false);
    expect(
      sectionIsValid({
        section: "steps",
        steps: [{ title: "t", detail: "", filesText: "", symbolsText: "", createdSymbolsText: "" }],
      }),
    ).toBe(true);
    expect(sectionIsValid({ section: "risks", lines: [] })).toBe(true);
    expect(sectionIsValid({ section: "acceptance", acceptance: [] })).toBe(true);
  });
});
