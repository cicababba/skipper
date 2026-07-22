import { describe, it, expect } from "vitest";
import type { IssuePlan } from "@skipper/shared";
import {
  CODER_SYSTEM_PROMPT,
  buildCoderPrompt,
  buildCoderSalvagePrompt,
  buildFixPrompt,
  buildPrFixPrompt,
  buildResumePrompt,
} from "../src/coder";

const issue = {
  key: "42",
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

  it("mandates the structured JSON report (#146)", () => {
    expect(CODER_SYSTEM_PROMPT).toMatch(/single JSON object/i);
    expect(CODER_SYSTEM_PROMPT).toContain('"deviations"');
  });
});

describe("structured report contract in every builder (#146)", () => {
  const builders = {
    coder: () => buildCoderPrompt(issue, plan),
    fix: () => buildFixPrompt(issue, [{ kind: "risk", detail: "x", blocking: false }]),
    prFix: () => buildPrFixPrompt(issue, [{ body: "please rename" }]),
    resume: () => buildResumePrompt(issue),
  };

  for (const [name, build] of Object.entries(builders)) {
    it(`${name} appends the single-JSON clause, deviations field, and schema`, () => {
      const prompt = build();
      expect(prompt).toContain("Your FINAL message must be ONLY a single JSON object");
      expect(prompt).toContain('"deviations"');
      expect(prompt).toContain("Schema:");
    });
  }
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

  it("renders context, out of scope and verification sections when present", () => {
    const rich: IssuePlan = {
      ...plan,
      context: ["src/app.tsx:3 wraps everything in Providers"],
      outOfScope: ["the routing layer"],
      verificationCommands: ["pnpm test", "pnpm lint"],
      manualChecks: ["toggle dark mode and reload"],
    };
    const prompt = buildCoderPrompt(issue, rich);
    expect(prompt).toContain("Context (verified repo facts):");
    expect(prompt).toContain("- src/app.tsx:3 wraps everything in Providers");
    expect(prompt).toContain("Out of scope — do NOT touch:");
    expect(prompt).toContain("- the routing layer");
    expect(prompt).toContain("Before reporting done, run these commands and make sure they pass:");
    expect(prompt).toContain("- pnpm lint");
    expect(prompt).toContain("Manual checks (for the human reviewer):");
    expect(prompt).toContain("- toggle dark mode and reload");
  });

  it("omits the new sections when the fields are absent or empty", () => {
    const prompt = buildCoderPrompt(issue, {
      ...plan,
      context: [],
      outOfScope: undefined,
      verificationCommands: [],
      manualChecks: undefined,
    });
    expect(prompt).not.toContain("Context (verified repo facts):");
    expect(prompt).not.toContain("Out of scope");
    expect(prompt).not.toContain("Before reporting done");
    expect(prompt).not.toContain("Manual checks");
  });
});

describe("buildFixPrompt", () => {
  it("lists objections and flags blocking ones", () => {
    const prompt = buildFixPrompt(issue, [
      { kind: "acceptance-gap", detail: "toggle does not persist", blocking: true },
      { kind: "risk", detail: "FOUC possible", blocking: false },
    ]);
    expect(prompt).toContain("independent reviewer");
    expect(prompt).toContain("Issue #42: Add dark mode");
    expect(prompt).toContain("- [BLOCKING] (acceptance-gap) toggle does not persist");
    expect(prompt).toContain("- (risk) FOUC possible");
    expect(prompt).toMatch(/no git commit\/push\/branch/);
  });
});

describe("buildPrFixPrompt", () => {
  it("renders author, path:line and body for each comment", () => {
    const prompt = buildPrFixPrompt(issue, [
      { author: "rev", path: "src/theme.ts", line: 12, body: "rename this" },
      { author: "rev", body: "Overall: please add tests" },
      { body: "anonymous note" },
    ]);
    expect(prompt).toContain("requested changes on the pull request");
    expect(prompt).toContain("Issue #42: Add dark mode");
    expect(prompt).toContain("- rev on src/theme.ts:12: rename this");
    expect(prompt).toContain("- rev: Overall: please add tests");
    expect(prompt).toContain("- reviewer: anonymous note");
    expect(prompt).toMatch(/no git commit\/push\/branch/);
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

describe("buildCoderSalvagePrompt (#194)", () => {
  it("carries the report contract and forbids further changes", () => {
    const prompt = buildCoderSalvagePrompt();
    expect(prompt).toContain("Your FINAL message must be ONLY a single JSON object");
    expect(prompt).toContain('"deviations"');
    expect(prompt).toContain("Schema:");
    expect(prompt).toContain("Do NOT");
    expect(prompt).toMatch(/git status/);
  });

  it("has no issue header — the resumed session already holds the context", () => {
    const prompt = buildCoderSalvagePrompt();
    expect(prompt).not.toContain("Issue #42");
    expect(prompt).not.toContain("Issue comments");
  });
});

describe("issue comments in every builder", () => {
  const withComments = {
    ...issue,
    comments: [{ author: "alice", body: "also support system theme", createdAt: "2026-07-01T01:00:00Z" }],
  };
  const objections = [{ kind: "acceptance-gap", detail: "x", blocking: true } as const];
  const prComments = [{ body: "please rename" }];

  it("includes the comments block when comments are set", () => {
    expect(buildCoderPrompt(withComments, plan)).toContain("also support system theme");
    expect(buildFixPrompt(withComments, objections)).toContain("also support system theme");
    expect(buildPrFixPrompt(withComments, prComments)).toContain("also support system theme");
    expect(buildResumePrompt(withComments)).toContain("also support system theme");
  });

  it("omits the block when there are no comments", () => {
    expect(buildCoderPrompt(issue, plan)).not.toContain("Issue comments");
    expect(buildFixPrompt(issue, objections)).not.toContain("Issue comments");
    expect(buildPrFixPrompt(issue, prComments)).not.toContain("Issue comments");
    expect(buildResumePrompt(issue)).not.toContain("Issue comments");
  });
});
