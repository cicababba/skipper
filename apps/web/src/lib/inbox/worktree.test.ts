import { describe, expect, it } from "vitest";
import type { WorktreeFileChange } from "@skipper/shared";
import { changeForRelPath, worktreeRelPath } from "./worktree";

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
