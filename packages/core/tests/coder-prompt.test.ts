import { describe, it, expect } from "vitest";
import type { IssuePlan } from "@skipper/shared";
import {
  CODER_SYSTEM_PROMPT,
  buildCoderPrompt,
  buildCoderRecapPrompt,
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
    recap: () => buildCoderRecapPrompt(issue, { plan }),
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

  // #226: a factually wrong objection can be disputed instead of blindly obeyed.
  it("tells the coder to dispute a wrong objection in the report's open array", () => {
    const prompt = buildFixPrompt(issue, [{ kind: "risk", detail: "x", blocking: false }]);
    expect(prompt).toContain("Verify each objection against the working tree before acting on it.");
    expect(prompt).toContain("do not comply blindly");
    expect(prompt).toContain('record the evidence in the report\'s "open" array');
  });

  // #308: an objection the reviewer could not check is an open question, and the
  // coder must be told which ones those are.
  it("marks unverified objections and explains what the marker means", () => {
    const prompt = buildFixPrompt(issue, [
      { kind: "risk", detail: "vitest may not resolve", blocking: false, unverified: true },
      { kind: "acceptance-gap", detail: "toggle does not persist", blocking: true },
      { kind: "other", detail: "seen in the diff", blocking: false, unverified: false },
    ]);
    expect(prompt).toContain("- [UNVERIFIED] (risk) vitest may not resolve");
    expect(prompt).toContain("- [BLOCKING] (acceptance-gap) toggle does not persist");
    expect(prompt).toContain("- (other) seen in the diff");
    expect(prompt).toContain(
      "An [UNVERIFIED] objection is the reviewer's open question, not an established defect",
    );
  });

  it("emits both markers on a blocking objection the reviewer could not check", () => {
    const prompt = buildFixPrompt(issue, [
      { kind: "risk", detail: "x", blocking: true, unverified: true },
    ]);
    expect(prompt).toContain("- [BLOCKING] [UNVERIFIED] (risk) x");
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
    expect(buildCoderRecapPrompt(withComments, { plan })).toContain("also support system theme");
  });

  it("omits the block when there are no comments", () => {
    expect(buildCoderPrompt(issue, plan)).not.toContain("Issue comments");
    expect(buildFixPrompt(issue, objections)).not.toContain("Issue comments");
    expect(buildPrFixPrompt(issue, prComments)).not.toContain("Issue comments");
    expect(buildResumePrompt(issue)).not.toContain("Issue comments");
    expect(buildCoderRecapPrompt(issue, { plan })).not.toContain("Issue comments");
  });
});

// #240: a runtime switch mid-issue cannot resume the other CLI's session, so the
// fresh run is seeded from durable artifacts instead — the stored report, the
// pending feedback, the plan and the worktree's dirty set.
describe("buildCoderRecapPrompt (#240)", () => {
  const report = {
    done: [{ path: "src/theme.ts", summary: "added the context" }],
    deviations: ["skipped the toggle"],
    verification: [{ command: "pnpm test", passed: false, detail: "2 failing" }],
    open: ["is FOUC acceptable?"],
  };

  it("forbids restarting the work and renders the issue header and plan", () => {
    const prompt = buildCoderRecapPrompt(issue, { plan });
    expect(prompt).toContain("already in progress");
    expect(prompt).toContain("Do NOT restart the work from scratch");
    expect(prompt).toContain("Issue #42: Add dark mode");
    expect(prompt).toContain("Summary: Introduce a theme context and toggle.");
    expect(prompt).toContain("- src/theme.ts (new) — new theme context");
  });

  // The transcript belongs to the other runtime; saying so is what stops the
  // agent from assuming it can recall the session.
  it("states the previous session's transcript is unavailable", () => {
    expect(buildCoderRecapPrompt(issue, { plan })).toContain("transcript is unavailable");
  });

  it("renders every section of the stored report", () => {
    const prompt = buildCoderRecapPrompt(issue, { plan, report });
    expect(prompt).toContain("- src/theme.ts — added the context");
    expect(prompt).toContain("- skipped the toggle");
    expect(prompt).toContain("- pnpm test — FAILED: 2 failing");
    expect(prompt).toContain("- is FOUC acceptable?");
  });

  it("says so when no report survived", () => {
    const prompt = buildCoderRecapPrompt(issue, { plan });
    expect(prompt).toContain("No report from the previous session survived.");
    expect(prompt).not.toContain("Report from the previous session ---");
  });

  it("marks a passed verification as passed", () => {
    const prompt = buildCoderRecapPrompt(issue, {
      plan,
      report: { ...report, verification: [{ command: "pnpm lint", passed: true }] },
    });
    expect(prompt).toContain("- pnpm lint — passed");
  });

  it("lists the uncommitted paths and tells the agent to trust the tree", () => {
    const prompt = buildCoderRecapPrompt(issue, { plan, dirtyPaths: ["src/theme.ts", "src/app.tsx"] });
    expect(prompt).toContain("Files left uncommitted in the working tree");
    expect(prompt).toContain("- src/theme.ts");
    expect(prompt).toContain("- src/app.tsx");
    expect(prompt).toMatch(/git status/);
    expect(prompt).toContain("trust the tree");
  });

  it("says the tree is clean when nothing is dirty", () => {
    const prompt = buildCoderRecapPrompt(issue, { plan });
    expect(prompt).toContain("no uncommitted changes");
    expect(prompt).not.toContain("Files left uncommitted in the working tree");
  });

  // Same precedence as the coder driver: the human's PR feedback is the later
  // stage, so it outranks the critic's objections.
  it("renders PR feedback over reviewer objections when both are present", () => {
    const prompt = buildCoderRecapPrompt(issue, {
      plan,
      prComments: [{ author: "rev", path: "src/app.tsx", line: 7, body: "rename this" }],
      objections: [{ kind: "risk", detail: "stale objection", blocking: false }],
    });
    expect(prompt).toContain("- rev on src/app.tsx:7: rename this");
    expect(prompt).not.toContain("stale objection");
  });

  it("renders reviewer objections when there is no PR feedback", () => {
    const prompt = buildCoderRecapPrompt(issue, {
      plan,
      objections: [{ kind: "acceptance-gap", detail: "criterion not met", blocking: true }],
    });
    expect(prompt).toContain("[BLOCKING] (acceptance-gap) criterion not met");
  });

  it("carries no feedback block when neither source has anything", () => {
    const prompt = buildCoderRecapPrompt(issue, { plan, prComments: [], objections: [] });
    expect(prompt).not.toContain("Pending review feedback");
    expect(prompt).not.toContain("Pending reviewer objections");
  });

  it("keeps the no-git-operations rule", () => {
    expect(buildCoderRecapPrompt(issue, { plan })).toContain(
      "no git commit/push/branch operations",
    );
  });
});
