import { describe, expect, it } from "vitest";
import type { WorktreeFileChange, WorktreeStatusResult } from "@skipper/shared";
import { changeForRelPath, presentDirtyFiles, worktreeRelPath } from "./worktree";

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

describe("presentDirtyFiles", () => {
  const ok = (extra: Partial<Extract<WorktreeStatusResult, { ok: true }>>): WorktreeStatusResult => ({
    ok: true,
    path: "/wt",
    branch: "feature/issue-204",
    present: true,
    ...extra,
  });

  it("returns null for a null status", () => {
    expect(presentDirtyFiles(null)).toBeNull();
  });

  it("returns null for an error status", () => {
    expect(presentDirtyFiles({ ok: false, error: "boom" })).toBeNull();
  });

  it("returns null when the worktree is absent", () => {
    expect(presentDirtyFiles(ok({ present: false, dirtyFiles: ["a.ts"] }))).toBeNull();
  });

  it("returns null when the probe could not run (dirtyFiles null)", () => {
    expect(presentDirtyFiles(ok({ dirtyFiles: null }))).toBeNull();
  });

  it("returns null for a clean worktree (empty dirtyFiles)", () => {
    expect(presentDirtyFiles(ok({ dirtyFiles: [] }))).toBeNull();
  });

  it("returns the paths when the worktree is dirty", () => {
    expect(presentDirtyFiles(ok({ dirtyFiles: ["a.ts", "b.ts"] }))).toEqual(["a.ts", "b.ts"]);
  });
});
