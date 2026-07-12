import { describe, it, expect } from "vitest";
import type { IssuePlan } from "@nestbrain/shared";
import { CODER_SYSTEM_PROMPT, buildCoderPrompt, buildResumePrompt } from "../src/coder";

const issue = {
  number: 42,
  title: "Add dark mode",
  url: "https://github.com/o/r/issues/42",
  labels: ["enhancement"],
  body: "Please add dark mode.",
};

const plan: IssuePlan = {
  summary: "Introduce a theme context and toggle.",
  files: [
    { path: "src/theme.ts", reason: "new theme context", status: "new" },
    { path: "src/app.tsx", reason: "wire the provider" },
  ],
  steps: [
    {
      title: "Create theme context",
      detail: "React context with light/dark",
      files: ["src/theme.ts"],
      symbols: ["ThemeProvider"],
    },
    { title: "Wire provider", detail: "wrap the app", files: ["src/app.tsx"], symbols: [] },
  ],
  acceptance: [{ criterion: "toggle persists", addressedBy: "localStorage in ThemeProvider" }],
  risks: ["FOUC on load"],
  openQuestions: [],
  estimatedSize: "s",
};

describe("CODER_SYSTEM_PROMPT", () => {
  it("forbids commit/push/branch operations", () => {
    expect(CODER_SYSTEM_PROMPT).toMatch(/do not run git commit/i);
    expect(CODER_SYSTEM_PROMPT).toMatch(/uncommitted working-tree/i);
  });
});

describe("buildCoderPrompt", () => {
  it("renders issue header and all plan sections", () => {
    const prompt = buildCoderPrompt(issue, plan);
    expect(prompt).toContain("Issue #42: Add dark mode");
    expect(prompt).toContain("Labels: enhancement");
    expect(prompt).toContain("Please add dark mode.");
    expect(prompt).toContain("Summary: Introduce a theme context and toggle.");
    expect(prompt).toContain("- src/theme.ts (new) — new theme context");
    expect(prompt).toContain("- src/app.tsx — wire the provider");
    expect(prompt).toContain(
      "1. Create theme context — React context with light/dark (files: src/theme.ts; symbols: ThemeProvider)",
    );
    expect(prompt).toContain("- toggle persists (addressed by: localStorage in ThemeProvider)");
    expect(prompt).toContain("- FOUC on load");
  });

  it("truncates a huge issue body", () => {
    const prompt = buildCoderPrompt({ ...issue, body: "x".repeat(30_000) }, plan);
    expect(prompt).toContain("[... issue body truncated ...]");
    expect(prompt.length).toBeLessThan(25_000);
  });

  it("handles a missing body", () => {
    const prompt = buildCoderPrompt({ ...issue, body: undefined }, plan);
    expect(prompt).toContain("(The issue has no body.)");
  });
});

describe("buildResumePrompt", () => {
  it("asks to continue and inspect the working tree", () => {
    const prompt = buildResumePrompt(issue);
    expect(prompt).toContain("interrupted");
    expect(prompt).toContain("Issue #42: Add dark mode");
    expect(prompt).toMatch(/git status/);
  });
});
