import { describe, it, expect } from "vitest";
import type { IssueComment } from "../src/adapters/types";
import type { PlanIssueInput } from "../src/planner/generate";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerPrompt,
  renderCommentsBlock,
  renderDependenciesBlock,
  renderDirtyFilesBlock,
} from "../src/planner/prompt";
import { INSTRUCTIONS_SYSTEM_PROMPT } from "../src/instructions/generate";

const SCHEMA = { type: "object" };

function baseIssue(over: Partial<PlanIssueInput> = {}): PlanIssueInput {
  return {
    key: "42",
    title: "Add retry",
    url: "https://github.com/o/r/issues/42",
    labels: ["enhancement"],
    body: "Retry on 429.",
    ...over,
  };
}

function comment(author: string, body: string, createdAt: string): IssueComment {
  return { author, body, createdAt };
}

describe("buildPlannerPrompt — comments", () => {
  it("renders the comments block between the body and the schema", () => {
    const prompt = buildPlannerPrompt(
      baseIssue({ comments: [comment("alice", "please handle 503 too", "2026-07-01T01:00:00Z")] }),
      SCHEMA,
    );
    const bodyEnd = prompt.indexOf("--- End issue body ---");
    const block = prompt.indexOf("--- Issue comments (newest last) ---");
    const schema = prompt.indexOf("Schema:");
    expect(block).toBeGreaterThan(bodyEnd);
    expect(schema).toBeGreaterThan(block);
    expect(prompt).toContain("alice (2026-07-01T01:00:00Z):\nplease handle 503 too");
  });

  it("omits the block when there are no comments", () => {
    const prompt = buildPlannerPrompt(baseIssue(), SCHEMA);
    expect(prompt).not.toContain("Issue comments");
  });
});

describe("buildPlannerPrompt — pre-existing changes", () => {
  it("renders the dirty-files block after the comments and before the schema", () => {
    const prompt = buildPlannerPrompt(
      baseIssue({ comments: [comment("alice", "please handle 503 too", "2026-07-01T01:00:00Z")] }),
      SCHEMA,
      [" M github/close.ts", "?? github/new-helper.ts"],
    );
    const bodyEnd = prompt.indexOf("--- End issue body ---");
    const comments = prompt.indexOf("--- Issue comments (newest last) ---");
    const block = prompt.indexOf("--- Pre-existing uncommitted changes ---");
    const schema = prompt.indexOf("Schema:");
    expect(block).toBeGreaterThan(bodyEnd);
    expect(block).toBeGreaterThan(comments);
    expect(schema).toBeGreaterThan(block);
    expect(prompt).toContain(" M github/close.ts");
    expect(prompt).toContain("?? github/new-helper.ts");
  });

  it("omits the block when no pre-existing changes are passed", () => {
    const prompt = buildPlannerPrompt(baseIssue(), SCHEMA);
    expect(prompt).not.toContain("Pre-existing uncommitted changes");
  });
});

// #307: prerequisites that reach planning (waived or untracked) must be declared,
// or the plan absorbs the blocker's work instead of planning against it.
describe("buildPlannerPrompt — prerequisites", () => {
  it("renders the block after the body and before the schema", () => {
    const prompt = buildPlannerPrompt(
      baseIssue({ blockedBy: [{ key: "ISSUE-3", title: "add a status filter", state: "planning" }] }),
      SCHEMA,
    );
    const bodyEnd = prompt.indexOf("--- End issue body ---");
    const block = prompt.indexOf("--- Prerequisites ---");
    const schema = prompt.indexOf("Schema:");
    expect(block).toBeGreaterThan(bodyEnd);
    expect(schema).toBeGreaterThan(block);
    expect(prompt).toContain('- ISSUE-3 — "add a status filter" (planning)');
  });

  it("omits the block when the issue declares no prerequisites", () => {
    expect(buildPlannerPrompt(baseIssue(), SCHEMA)).not.toContain("Prerequisites");
    expect(buildPlannerPrompt(baseIssue({ blockedBy: [] }), SCHEMA)).not.toContain("Prerequisites");
  });
});

describe("renderDependenciesBlock", () => {
  it("returns undefined for empty or undefined input", () => {
    expect(renderDependenciesBlock(undefined)).toBeUndefined();
    expect(renderDependenciesBlock([])).toBeUndefined();
  });

  it("renders key, title and state, prefixing a numeric key", () => {
    const block = renderDependenciesBlock([{ key: "7", title: "parser rewrite", state: "coding" }])!;
    expect(block).toContain("--- Prerequisites ---");
    expect(block).toContain('- #7 — "parser rewrite" (coding)');
    expect(block).toContain("--- End prerequisites ---");
  });

  it("renders an untracked prerequisite as the bare key", () => {
    expect(renderDependenciesBlock([{ key: "ISSUE-9" }])!).toContain("- ISSUE-9\n");
  });

  it("forbids implementing the prerequisite's work", () => {
    const block = renderDependenciesBlock([{ key: "1" }])!;
    expect(block).toContain("are NOT merged yet");
    expect(block).toMatch(/Do NOT implement,\nre-implement or "unblock" a prerequisite's work/);
    expect(block).toContain("openQuestions");
  });
});

describe("renderDirtyFilesBlock", () => {
  it("returns undefined for empty or undefined input", () => {
    expect(renderDirtyFilesBlock(undefined)).toBeUndefined();
    expect(renderDirtyFilesBlock([])).toBeUndefined();
  });

  it("renders the porcelain lines inside a fenced block", () => {
    const block = renderDirtyFilesBlock([" M src/a.ts", "?? src/b.ts"])!;
    expect(block).toContain("--- Pre-existing uncommitted changes ---");
    expect(block).toContain(" M src/a.ts");
    expect(block).toContain("?? src/b.ts");
    expect(block).toContain('never mark a file that exists on disk as "new"');
    expect(block).toContain("--- End pre-existing uncommitted changes ---");
  });
});

describe("renderCommentsBlock", () => {
  it("returns undefined for empty or undefined input", () => {
    expect(renderCommentsBlock(undefined)).toBeUndefined();
    expect(renderCommentsBlock([])).toBeUndefined();
  });

  it("keeps the newest 30 and reports the omitted count", () => {
    const comments = Array.from({ length: 35 }, (_, i) =>
      comment(`u${i}`, `comment ${i}`, `2026-07-01T00:${String(i).padStart(2, "0")}:00Z`),
    );
    const block = renderCommentsBlock(comments)!;
    expect(block).toContain("[... 5 earlier comments omitted ...]");
    expect(block).toContain("comment 34"); // newest kept
    expect(block).toContain("comment 5"); // oldest kept
    expect(block).not.toContain("comment 0"); // oldest dropped
  });

  it("drops oldest first under the 15k total budget but always keeps the newest", () => {
    // Each entry is ~4k after per-comment truncation; four of them exceed the 15k
    // total, so the oldest is dropped and the three newest survive.
    const comments = Array.from({ length: 4 }, (_, i) =>
      comment(`author-${i}`, `MARK${i} ${"x".repeat(5_000)}`, `2026-07-01T0${i}:00:00Z`),
    );
    const block = renderCommentsBlock(comments)!;
    expect(block).toContain("[... 1 earlier comment omitted ...]");
    expect(block).toContain("MARK3"); // newest kept
    expect(block).not.toContain("MARK0"); // oldest dropped
  });

  it("truncates a single oversized comment at 4k", () => {
    const block = renderCommentsBlock([comment("alice", "z".repeat(10_000), "2026-07-01T01:00:00Z")])!;
    expect(block).toContain("[... comment truncated ...]");
    expect(block.length).toBeLessThan(5_000);
  });
});

// Runtime-neutral wording (#280): both prompts are shared by every runtime, so
// they may name no CLI's tools while keeping their prohibitions in force.
describe("runtime-neutral tool wording", () => {
  for (const [label, prompt] of [
    ["planner", PLANNER_SYSTEM_PROMPT],
    ["instructions", INSTRUCTIONS_SYSTEM_PROMPT],
  ] as const) {
    describe(label, () => {
      it("names no claude tool", () => {
        expect(prompt).not.toMatch(/\bRead\b|\bGrep\b|\bGlob\b|\bBash\b/);
      });

      it("keeps the stay-inside-cwd prohibition", () => {
        expect(prompt).toContain(
          "never modify any files anywhere, including via your shell",
        );
      });

      it("still demands exploration before writing", () => {
        expect(prompt).toMatch(/Explore the repository — read, search and list its files —/);
      });
    });
  }
});
