import { describe, expect, it } from "vitest";
import type { StoredCoderReport } from "@skipper/shared";
import { worktreeMarkdown } from "./worktree-markdown";

const report: StoredCoderReport = {
  version: 1,
  itemId: "github:1",
  repo: { owner: "acme", name: "widget" },
  generatedAt: "2026-07-23T11:00:00.000Z",
  model: "claude-opus",
  report: { done: [{ path: "a.ts", summary: "s" }], deviations: [], verification: [], open: [] },
};

describe("worktreeMarkdown", () => {
  it("renders the report alone when there is no diff", () => {
    const md = worktreeMarkdown({ report, diff: null });
    expect(md).toContain("# Coder report");
    expect(md).not.toContain("# Diff");
  });

  it("renders the fenced diff alone when there is no report", () => {
    const md = worktreeMarkdown({ report: null, diff: "diff --git a b\n+x" });
    expect(md).toContain("# Diff");
    expect(md).toContain("```diff\ndiff --git a b\n+x\n```");
    expect(md).not.toContain("# Coder report");
  });

  it("renders both when present", () => {
    const md = worktreeMarkdown({ report, diff: "diff --git a b" });
    expect(md).toContain("# Coder report");
    expect(md).toContain("# Diff");
  });

  it("returns null when both are empty", () => {
    expect(worktreeMarkdown({ report: null, diff: null })).toBeNull();
    expect(worktreeMarkdown({ report: null, diff: "   " })).toBeNull();
  });

  it("escalates the fence when the diff contains a triple-backtick run", () => {
    const md = worktreeMarkdown({ report: null, diff: "+```\n+code" });
    expect(md).toContain("````diff");
  });
});
