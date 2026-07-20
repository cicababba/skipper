import { describe, expect, it } from "vitest";
import type { WorktreeFileChange } from "@skipper/shared";
import { buildClaudePrompt, changeForRelPath, shellQuote, worktreeRelPath } from "./worktree";

describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes with the '\\'' idiom", () => {
    expect(shellQuote("it's a test")).toBe("'it'\\''s a test'");
  });

  it("leaves double quotes untouched (single-quote context is literal)", () => {
    expect(shellQuote('say "hi"')).toBe(`'say "hi"'`);
  });

  it("handles multiple single quotes", () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

describe("worktreeRelPath", () => {
  it("maps an absolute POSIX path under the root to a relative path", () => {
    expect(worktreeRelPath("/home/u/wt", "/home/u/wt/src/index.ts")).toBe("src/index.ts");
  });

  it("normalizes Windows backslashes on both sides to a POSIX relative path", () => {
    expect(worktreeRelPath("C:\\wt", "C:\\wt\\src\\a.ts")).toBe("src/a.ts");
  });

  it("normalizes a mixed-separator root against a POSIX child", () => {
    expect(worktreeRelPath("C:\\wt", "C:/wt/src/a.ts")).toBe("src/a.ts");
  });

  it("returns a bare filename at the worktree root", () => {
    expect(worktreeRelPath("/home/u/wt", "/home/u/wt/README.md")).toBe("README.md");
  });
});

describe("changeForRelPath", () => {
  const changes: WorktreeFileChange[] = [
    { path: "src/a.ts", status: "modified" },
    { path: "src/new/b.ts", status: "added" },
    { path: "src/renamed.ts", oldPath: "src/old.ts", status: "renamed" },
  ];

  it("finds a change by its (new) relative path", () => {
    expect(changeForRelPath(changes, "src/new/b.ts")).toBe(changes[1]);
  });

  it("matches a rename on its new path, not the old path", () => {
    expect(changeForRelPath(changes, "src/renamed.ts")).toBe(changes[2]);
    expect(changeForRelPath(changes, "src/old.ts")).toBeUndefined();
  });

  it("returns undefined for an unchanged path", () => {
    expect(changeForRelPath(changes, "src/untouched.ts")).toBeUndefined();
  });
});

describe("buildClaudePrompt", () => {
  const base = { keyLabel: "#114", title: "worktree diff", branch: "feature/issue-114" };

  it("lists changed files inline", () => {
    const prompt = buildClaudePrompt({ ...base, changedFiles: ["a.ts", "b.ts"] });
    expect(prompt).toBe(
      `I'm working on #114 "worktree diff" on branch feature/issue-114.` +
        ` Changed files so far: a.ts, b.ts.` +
        ` Get up to speed on this worktree, then help me continue.`,
    );
  });

  it("reports no files when nothing changed", () => {
    const prompt = buildClaudePrompt({ ...base, changedFiles: [] });
    expect(prompt).toContain("No files changed yet.");
    expect(prompt).not.toContain("Changed files so far");
  });

  it("caps the list at 20 and appends the overflow count", () => {
    const files = Array.from({ length: 23 }, (_, i) => `f${i}.ts`);
    const prompt = buildClaudePrompt({ ...base, changedFiles: files });
    expect(prompt).toContain("f0.ts, f1.ts");
    expect(prompt).toContain("f19.ts (+3 more).");
    expect(prompt).not.toContain("f20.ts");
  });

  it("collapses whitespace in the title", () => {
    const prompt = buildClaudePrompt({ ...base, title: "  a\n  multiline   title ", changedFiles: [] });
    expect(prompt).toContain(`"a multiline title"`);
  });

  it("produces a single line whose apostrophe is escaped by shellQuote", () => {
    const prompt = buildClaudePrompt({ ...base, changedFiles: ["a.ts"] });
    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("I'm working");
    const quoted = shellQuote(prompt);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toContain("I'\\''m working");
  });
});
