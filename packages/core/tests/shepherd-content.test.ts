import { describe, it, expect } from "vitest";
import type { IssuePlan } from "@skipper/shared";
import { buildCommitMessage, buildPrBody, buildPrTitle } from "../src/shepherd";

const plan: IssuePlan = {
  summary: "Introduce a theme context and toggle.",
  files: [{ path: "src/theme.ts", reason: "new theme context", status: "new" }],
  steps: [{ title: "Create theme context", detail: "d", files: [], symbols: [] }],
  acceptance: [
    { criterion: "toggle persists", addressedBy: "localStorage" },
    { criterion: "no FOUC", addressedBy: "inline script" },
  ],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
};

describe("buildCommitMessage", () => {
  it("uses the issue title and number", () => {
    expect(buildCommitMessage({ title: "Add dark mode", key: "42" })).toBe("Add dark mode (#42)");
  });
});

describe("buildPrTitle", () => {
  it("is the issue title", () => {
    expect(buildPrTitle({ title: "Add dark mode" })).toBe("Add dark mode");
  });
});

describe("buildPrBody", () => {
  it("includes the issue link, the plan summary and acceptance criteria", () => {
    const body = buildPrBody({ issueLink: "Closes #42", plan });
    expect(body).toContain("Closes #42");
    expect(body).toContain("Introduce a theme context and toggle.");
    expect(body).toContain("- toggle persists");
    expect(body).toContain("- no FOUC");
  });

  it("works without a plan", () => {
    const body = buildPrBody({ issueLink: "Closes #42" });
    expect(body).toContain("Closes #42");
    expect(body).not.toContain("## Plan");
  });
});
