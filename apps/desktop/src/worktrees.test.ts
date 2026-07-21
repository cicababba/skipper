import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRANCH_ISSUE_RE, issueBranchFor } from "@skipper/shared";
import {
  captureBranchDiff,
  captureWorktreeDiff,
  commitWorktree,
  deleteBranchForce,
  deleteBranchIfNoUniqueCommits,
  discardWorktree,
  ensureWorktree,
  listWorktreeChanges,
  listWorktrees,
  parseNameStatusZ,
  parseRemoteBranches,
  pushWorktreeBranch,
  readWorktreeFileVersions,
  refreshWorktreeBase,
  removeWorktree,
  resolveBaseRef,
  resolveInsideWorktree,
  worktreeDirFor,
  worktreeDirtyFiles,
  worktreeStatus,
  writeWorktreeFile,
} from "./worktrees";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-worktrees-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/** Local bare repo as origin + a clone with one commit on main. */
async function makeCloneWithOrigin(): Promise<{ origin: string; clone: string }> {
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  const clone = join(dir, "clone");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@t");
  git(clone, "config", "user.name", "t");
  await writeFile(join(clone, "README.md"), "hello\n");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "init");
  git(clone, "push", "-q", "origin", "main");
  git(clone, "remote", "set-head", "origin", "main");
  return { origin, clone };
}

describe("worktreeDirFor / issueBranchFor", () => {
  it("builds a sanitized per-issue path", () => {
    const path = worktreeDirFor("/root", { owner: "My Org", name: "a/b" }, "7");
    expect(path).toBe(join("/root", "My_Org-a_b", "issue-7"));
  });

  it("slugs tracker keys into the path", () => {
    const path = worktreeDirFor("/root", { owner: "o", name: "r" }, "PROJ-123");
    expect(path).toBe(join("/root", "o-r", "issue-proj-123"));
  });

  it("branch matches the reconcile heuristic", () => {
    expect(issueBranchFor("42")).toBe("feature/issue-42");
    expect(BRANCH_ISSUE_RE.exec(issueBranchFor("42"))?.[1]).toBe("42");
    expect(BRANCH_ISSUE_RE.exec(issueBranchFor("PROJ-123"))?.[1]).toBe("proj-123");
  });
});

describe("worktreeStatus", () => {
  it("errors when no worktree is recorded", async () => {
    await expect(worktreeStatus(undefined)).resolves.toEqual({
      ok: false,
      error: "no worktree recorded for item",
    });
  });

  it("reports a live directory with its record fields", async () => {
    await expect(
      worktreeStatus({ path: dir, branch: "feature/issue-7", sessionId: "abc-123" }),
    ).resolves.toEqual({
      ok: true,
      path: dir,
      branch: "feature/issue-7",
      sessionId: "abc-123",
      present: true,
    });
  });

  it("reports present=false for a pruned path", async () => {
    await expect(
      worktreeStatus({ path: join(dir, "gone"), branch: "feature/issue-7" }),
    ).resolves.toMatchObject({ ok: true, present: false });
  });

  it("reports present=false when the path is a file, not a directory", async () => {
    const filePath = join(dir, "not-a-dir");
    await writeFile(filePath, "");
    await expect(
      worktreeStatus({ path: filePath, branch: "feature/issue-7" }),
    ).resolves.toMatchObject({ ok: true, present: false });
  });
});

describe("resolveBaseRef", () => {
  it("resolves origin/HEAD via symbolic-ref", async () => {
    const { clone } = await makeCloneWithOrigin();
    await expect(resolveBaseRef(clone)).resolves.toBe("origin/main");
  });

  it("override wins and is origin-prefixed", async () => {
    const { clone } = await makeCloneWithOrigin();
    await expect(resolveBaseRef(clone, "develop")).resolves.toBe("origin/develop");
    await expect(resolveBaseRef(clone, "origin/develop")).resolves.toBe("origin/develop");
  });
});

describe("ensureWorktree", () => {
  it("creates branch + worktree from the base ref", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-1");
    const result = await ensureWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-1",
      baseRef: "origin/main",
    });
    expect(result).toEqual({ path: worktreePath, branch: "feature/issue-1", created: true });
    expect(git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/issue-1");
  });

  it("reuses an existing registration (re-entry)", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-1");
    const opts = { repoPath: clone, worktreePath, branch: "feature/issue-1", baseRef: "origin/main" };
    await ensureWorktree(opts);
    const again = await ensureWorktree(opts);
    expect(again.created).toBe(false);
  });

  it("attaches an existing branch without -b", async () => {
    const { clone } = await makeCloneWithOrigin();
    git(clone, "branch", "feature/issue-2");
    const worktreePath = join(dir, "wt", "issue-2");
    const result = await ensureWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-2",
      baseRef: "origin/main",
    });
    expect(result.created).toBe(true);
    expect(git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/issue-2");
  });

  it("prunes a stale registration and re-adds", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-3");
    const opts = { repoPath: clone, worktreePath, branch: "feature/issue-3", baseRef: "origin/main" };
    await ensureWorktree(opts);
    await rm(worktreePath, { recursive: true, force: true });
    const again = await ensureWorktree(opts);
    expect(again.created).toBe(true);
    expect(git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/issue-3");
  });

  it.skipIf(process.platform === "win32")(
    "matches the registration through a symlinked path (macOS /var → /private/var)",
    async () => {
      const { clone } = await makeCloneWithOrigin();
      await mkdir(join(dir, "real"));
      await symlink(join(dir, "real"), join(dir, "link"));
      const worktreePath = join(dir, "link", "issue-99");
      const opts = { repoPath: clone, worktreePath, branch: "feature/issue-99", baseRef: "origin/main" };
      await ensureWorktree(opts);
      const again = await ensureWorktree(opts); // reuse case
      expect(again.created).toBe(false);
      await rm(join(dir, "real", "issue-99"), { recursive: true, force: true });
      const readded = await ensureWorktree(opts); // stale/prune case
      expect(readded.created).toBe(true);
    },
  );

  it("throws when the branch is checked out elsewhere", async () => {
    const { clone } = await makeCloneWithOrigin();
    git(clone, "checkout", "-qb", "feature/issue-4");
    await expect(
      ensureWorktree({
        repoPath: clone,
        worktreePath: join(dir, "wt", "issue-4"),
        branch: "feature/issue-4",
        baseRef: "origin/main",
      }),
    ).rejects.toThrow(/worktree add failed/);
  });
});

describe("captureWorktreeDiff", () => {
  it("includes modified and untracked files in diff and stats", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-9");
    await ensureWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-9",
      baseRef: "origin/main",
    });
    await writeFile(join(worktreePath, "README.md"), "hello\nmodified\n");
    await writeFile(join(worktreePath, "new-file.ts"), "export const x = 1;\n");

    const { diff, stats } = await captureWorktreeDiff(worktreePath);

    expect(stats.filesChanged).toBe(2);
    expect(stats.files).toContain("README.md");
    expect(stats.files).toContain("new-file.ts");
    expect(stats.totalChangedLines).toBeGreaterThan(0);
    expect(diff).toContain("modified");
    expect(diff).toContain("export const x = 1;");
  });

  it("reports an empty diff for a clean worktree", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-10");
    await ensureWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-10",
      baseRef: "origin/main",
    });
    const { diff, stats } = await captureWorktreeDiff(worktreePath);
    expect(stats).toEqual({ filesChanged: 0, totalChangedLines: 0, files: [] });
    expect(diff).toBe("");
  });
});

describe("commitWorktree / pushWorktreeBranch / captureBranchDiff (#11)", () => {
  async function makeWorktree(n: number): Promise<{ clone: string; worktreePath: string }> {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", `issue-${n}`);
    await ensureWorktree({
      repoPath: clone,
      worktreePath,
      branch: `feature/issue-${n}`,
      baseRef: "origin/main",
    });
    return { clone, worktreePath };
  }

  it("stages and commits everything, reporting the new sha", async () => {
    const { worktreePath } = await makeWorktree(1);
    await writeFile(join(worktreePath, "new.txt"), "x\n");
    const result = await commitWorktree(worktreePath, "add dark mode (#1)");
    expect(result.committed).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(worktreePath, "log", "-1", "--format=%s")).toContain("add dark mode (#1)");
    expect(git(worktreePath, "status", "--porcelain")).toBe("");
  });

  it("returns committed:false with the HEAD sha on a clean tree", async () => {
    const { worktreePath } = await makeWorktree(2);
    const head = git(worktreePath, "rev-parse", "HEAD").trim();
    const result = await commitWorktree(worktreePath, "noop");
    expect(result).toEqual({ committed: false, sha: head });
  });

  it("pushes the branch to origin with upstream", async () => {
    const { clone, worktreePath } = await makeWorktree(3);
    await writeFile(join(worktreePath, "new.txt"), "x\n");
    await commitWorktree(worktreePath, "change (#3)");
    await pushWorktreeBranch(worktreePath, "feature/issue-3");
    expect(git(clone, "ls-remote", "--heads", "origin", "feature/issue-3")).toContain(
      "refs/heads/feature/issue-3",
    );
  });

  it("captureBranchDiff reports committed changes vs the base", async () => {
    const { worktreePath } = await makeWorktree(4);
    await writeFile(join(worktreePath, "new.txt"), "line\n");
    await commitWorktree(worktreePath, "change (#4)");
    const { diff, stats } = await captureBranchDiff(worktreePath, "origin/main");
    expect(stats.filesChanged).toBe(1);
    expect(stats.files).toContain("new.txt");
    expect(diff).toContain("+line");
    // uncommitted view is empty — the change is committed
    const clean = await captureWorktreeDiff(worktreePath);
    expect(clean.stats.filesChanged).toBe(0);
  });
});

describe("resolveInsideWorktree (#14)", () => {
  const root = join("/tmp", "wt");

  it("resolves a nested relative path", () => {
    expect(resolveInsideWorktree(root, join("src", "a.ts"))).toBe(join(root, "src", "a.ts"));
  });

  it("rejects escapes, absolute paths, .git and empty", () => {
    expect(() => resolveInsideWorktree(root, "../escape")).toThrow(/escapes/);
    expect(() => resolveInsideWorktree(root, join("src", "..", "..", "x"))).toThrow(/escapes/);
    expect(() => resolveInsideWorktree(root, "/etc/passwd")).toThrow(/absolute/);
    expect(() => resolveInsideWorktree(root, join(".git", "config"))).toThrow(/\.git/);
    expect(() => resolveInsideWorktree(root, "  ")).toThrow(/empty/);
  });
});

describe("parseNameStatusZ (#14)", () => {
  it("parses M/A/D entries", () => {
    expect(parseNameStatusZ("M\0a.ts\0A\0b.ts\0D\0c.ts\0")).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "added" },
      { path: "c.ts", status: "deleted" },
    ]);
  });

  it("parses renames with score and old path", () => {
    expect(parseNameStatusZ("R100\0old.ts\0new.ts\0")).toEqual([
      { path: "new.ts", oldPath: "old.ts", status: "renamed" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});

describe("parseRemoteBranches", () => {
  it("strips origin/, drops HEAD, dedupes and sorts", () => {
    expect(
      parseRemoteBranches("origin/main\norigin/HEAD\norigin/develop\norigin/main\n"),
    ).toEqual(["develop", "main"]);
  });

  it("ignores blank lines and returns [] for empty output", () => {
    expect(parseRemoteBranches("\n  \n")).toEqual([]);
    expect(parseRemoteBranches("")).toEqual([]);
  });
});

describe("worktree review IO (#14)", () => {
  async function makeReviewWorktree(): Promise<string> {
    const { clone } = await makeCloneWithOrigin();
    await writeFile(join(clone, "keep.txt"), "keep\n");
    await writeFile(join(clone, "gone.txt"), "gone\n");
    await writeFile(join(clone, "moved.txt"), "moved\n");
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "more files");
    git(clone, "push", "-q", "origin", "main");
    const worktreePath = join(dir, "wt", "issue-14");
    await ensureWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-14",
      baseRef: "origin/main",
    });
    return worktreePath;
  }

  it("lists modified, added, deleted and renamed files", async () => {
    const wt = await makeReviewWorktree();
    await writeFile(join(wt, "keep.txt"), "keep\nchanged\n");
    await writeFile(join(wt, "brand-new.ts"), "export const x = 1;\n");
    await rm(join(wt, "gone.txt"));
    git(wt, "mv", "moved.txt", "renamed.txt");

    const changes = await listWorktreeChanges(wt);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath["keep.txt"].status).toBe("modified");
    expect(byPath["brand-new.ts"].status).toBe("added");
    expect(byPath["gone.txt"].status).toBe("deleted");
    expect(byPath["renamed.txt"]).toEqual({
      path: "renamed.txt",
      oldPath: "moved.txt",
      status: "renamed",
    });
  });

  it("reads both sides of a modified file", async () => {
    const wt = await makeReviewWorktree();
    await writeFile(join(wt, "keep.txt"), "keep\nchanged\n");
    const file = await readWorktreeFileVersions(wt, "keep.txt");
    expect(file).toEqual({
      original: "keep\n",
      modified: "keep\nchanged\n",
      binary: false,
      tooLarge: false,
    });
  });

  it("added → original null; deleted → modified null", async () => {
    const wt = await makeReviewWorktree();
    await writeFile(join(wt, "brand-new.ts"), "x\n");
    await rm(join(wt, "gone.txt"));
    const added = await readWorktreeFileVersions(wt, "brand-new.ts");
    expect(added.original).toBeNull();
    expect(added.modified).toBe("x\n");
    const deleted = await readWorktreeFileVersions(wt, "gone.txt");
    expect(deleted.original).toBe("gone\n");
    expect(deleted.modified).toBeNull();
  });

  it("rename reads the HEAD side via oldPath", async () => {
    const wt = await makeReviewWorktree();
    git(wt, "mv", "moved.txt", "renamed.txt");
    const file = await readWorktreeFileVersions(wt, "renamed.txt", "moved.txt");
    expect(file.original).toBe("moved\n");
    expect(file.modified).toBe("moved\n");
  });

  it("flags binary and too-large files without shipping content", async () => {
    const wt = await makeReviewWorktree();
    await writeFile(join(wt, "bin.dat"), Buffer.from([1, 0, 2, 3]));
    const bin = await readWorktreeFileVersions(wt, "bin.dat");
    expect(bin).toEqual({ original: null, modified: null, binary: true, tooLarge: false });

    await writeFile(join(wt, "big.txt"), "x".repeat(1024 * 1024 + 1));
    const big = await readWorktreeFileVersions(wt, "big.txt");
    expect(big).toEqual({ original: null, modified: null, binary: false, tooLarge: true });
  });

  it("writeWorktreeFile writes existing files and refuses new paths", async () => {
    const wt = await makeReviewWorktree();
    await writeWorktreeFile(wt, "keep.txt", "edited\n");
    const file = await readWorktreeFileVersions(wt, "keep.txt");
    expect(file.modified).toBe("edited\n");
    await expect(writeWorktreeFile(wt, "nope.txt", "x")).rejects.toThrow(/not a file/);
    await expect(writeWorktreeFile(wt, "../outside.txt", "x")).rejects.toThrow(/escapes/);
  });
});

describe("listWorktrees / removeWorktree", () => {
  it("lists and removes", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-5");
    await ensureWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-5",
      baseRef: "origin/main",
    });
    const listed = await listWorktrees(clone);
    expect(listed.some((w) => w.branch === "feature/issue-5")).toBe(true);
    await removeWorktree(clone, worktreePath);
    const after = await listWorktrees(clone);
    expect(after.some((w) => w.branch === "feature/issue-5")).toBe(false);
  });
});

/** Push a new commit to origin/main from a throwaway second clone, then fetch it into `clone`. */
async function advanceOrigin(origin: string, clone: string): Promise<string> {
  const other = join(dir, `other-${Math.random().toString(36).slice(2)}`);
  execFileSync("git", ["clone", "-q", origin, other]);
  git(other, "config", "user.email", "t@t");
  git(other, "config", "user.name", "t");
  await writeFile(join(other, "NEXT.md"), "next\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "advance");
  git(other, "push", "-q", "origin", "main");
  git(clone, "fetch", "-q", "origin");
  return git(clone, "rev-parse", "origin/main").trim();
}

describe("refreshWorktreeBase (#110)", () => {
  it("fast-forwards a behind, clean worktree to the base", async () => {
    const { origin, clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-1");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-1", baseRef: "origin/main" });
    const advanced = await advanceOrigin(origin, clone);
    const result = await refreshWorktreeBase(worktreePath, "origin/main");
    expect(result).toEqual({ refreshed: true });
    expect(git(worktreePath, "rev-parse", "HEAD").trim()).toBe(advanced);
  });

  it("skips when the branch has its own commits", async () => {
    const { origin, clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-2");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-2", baseRef: "origin/main" });
    await writeFile(join(worktreePath, "own.md"), "own\n");
    git(worktreePath, "config", "user.email", "t@t");
    git(worktreePath, "config", "user.name", "t");
    git(worktreePath, "add", ".");
    git(worktreePath, "commit", "-qm", "own work");
    const before = git(worktreePath, "rev-parse", "HEAD").trim();
    await advanceOrigin(origin, clone);
    const result = await refreshWorktreeBase(worktreePath, "origin/main");
    expect(result).toEqual({ refreshed: false, skipped: "own-commits" });
    expect(git(worktreePath, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("skips a dirty worktree (untracked file)", async () => {
    const { origin, clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-3");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-3", baseRef: "origin/main" });
    await advanceOrigin(origin, clone);
    await writeFile(join(worktreePath, "stray.md"), "stray\n");
    const result = await refreshWorktreeBase(worktreePath, "origin/main");
    expect(result).toEqual({ refreshed: false, skipped: "dirty" });
  });

  it("skips a dirty worktree (modified tracked file)", async () => {
    const { origin, clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-4");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-4", baseRef: "origin/main" });
    await advanceOrigin(origin, clone);
    await writeFile(join(worktreePath, "README.md"), "changed\n");
    const result = await refreshWorktreeBase(worktreePath, "origin/main");
    expect(result).toEqual({ refreshed: false, skipped: "dirty" });
  });
});

describe("deleteBranchIfNoUniqueCommits (#110)", () => {
  it("deletes a branch with no unique commits", async () => {
    const { clone } = await makeCloneWithOrigin();
    git(clone, "branch", "feature/empty", "origin/main");
    const deleted = await deleteBranchIfNoUniqueCommits(clone, "feature/empty", "origin/main");
    expect(deleted).toBe(true);
    expect(git(clone, "branch", "--list", "feature/empty").trim()).toBe("");
  });

  it("keeps a branch that carries a unique commit", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-6");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-6", baseRef: "origin/main" });
    await writeFile(join(worktreePath, "own.md"), "own\n");
    git(worktreePath, "config", "user.email", "t@t");
    git(worktreePath, "config", "user.name", "t");
    git(worktreePath, "add", ".");
    git(worktreePath, "commit", "-qm", "own work");
    await removeWorktree(clone, worktreePath);
    const deleted = await deleteBranchIfNoUniqueCommits(clone, "feature/issue-6", "origin/main");
    expect(deleted).toBe(false);
    expect(git(clone, "branch", "--list", "feature/issue-6").trim()).not.toBe("");
  });

  it("returns false for a missing branch", async () => {
    const { clone } = await makeCloneWithOrigin();
    expect(await deleteBranchIfNoUniqueCommits(clone, "feature/nope", "origin/main")).toBe(false);
  });
});

describe("discardWorktree (#110)", () => {
  it("removes the worktree and deletes an empty branch", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-7");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-7", baseRef: "origin/main" });
    const result = await discardWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-7",
      baseRef: "origin/main",
    });
    expect(result).toEqual({ removed: true, branchDeleted: true });
    expect((await listWorktrees(clone)).some((w) => w.branch === "feature/issue-7")).toBe(false);
    expect(git(clone, "branch", "--list", "feature/issue-7").trim()).toBe("");
  });

  it("keeps a branch that has unique commits", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-8");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-8", baseRef: "origin/main" });
    await writeFile(join(worktreePath, "own.md"), "own\n");
    git(worktreePath, "config", "user.email", "t@t");
    git(worktreePath, "config", "user.name", "t");
    git(worktreePath, "add", ".");
    git(worktreePath, "commit", "-qm", "own work");
    const result = await discardWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-8",
      baseRef: "origin/main",
    });
    expect(result.branchDeleted).toBe(false);
    expect(git(clone, "branch", "--list", "feature/issue-8").trim()).not.toBe("");
  });

  it("prunes and still deletes the branch when the dir is already gone", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-9");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-9", baseRef: "origin/main" });
    await rm(worktreePath, { recursive: true, force: true });
    const result = await discardWorktree({
      repoPath: clone,
      worktreePath,
      branch: "feature/issue-9",
      baseRef: "origin/main",
    });
    expect(result.branchDeleted).toBe(true);
    expect((await listWorktrees(clone)).some((w) => w.branch === "feature/issue-9")).toBe(false);
  });

  it("keeps the branch when no baseRef is given", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-10");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-10", baseRef: "origin/main" });
    const result = await discardWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-10" });
    expect(result.branchDeleted).toBe(false);
    expect(git(clone, "branch", "--list", "feature/issue-10").trim()).not.toBe("");
  });
});

describe("deleteBranchForce (#115)", () => {
  it("deletes a branch even when it carries unique commits", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-11");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-11", baseRef: "origin/main" });
    await writeFile(join(worktreePath, "own.md"), "own\n");
    git(worktreePath, "config", "user.email", "t@t");
    git(worktreePath, "config", "user.name", "t");
    git(worktreePath, "add", ".");
    git(worktreePath, "commit", "-qm", "own work");
    await removeWorktree(clone, worktreePath);

    expect(await deleteBranchForce(clone, "feature/issue-11")).toBe(true);
    expect(git(clone, "branch", "--list", "feature/issue-11").trim()).toBe("");
  });

  it("returns false for a missing branch", async () => {
    const { clone } = await makeCloneWithOrigin();
    expect(await deleteBranchForce(clone, "feature/nope")).toBe(false);
  });
});

describe("worktreeDirtyFiles (#115)", () => {
  it("returns [] for a clean worktree", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-12");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-12", baseRef: "origin/main" });
    expect(await worktreeDirtyFiles(worktreePath)).toEqual([]);
  });

  it("reports a modified tracked file", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-13");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-13", baseRef: "origin/main" });
    await writeFile(join(worktreePath, "README.md"), "changed\n");
    expect(await worktreeDirtyFiles(worktreePath)).toHaveLength(1);
  });

  it("reports an untracked file", async () => {
    const { clone } = await makeCloneWithOrigin();
    const worktreePath = join(dir, "wt", "issue-14");
    await ensureWorktree({ repoPath: clone, worktreePath, branch: "feature/issue-14", baseRef: "origin/main" });
    await writeFile(join(worktreePath, "new.md"), "new\n");
    expect(await worktreeDirtyFiles(worktreePath)).toHaveLength(1);
  });

  it("returns null when the directory is gone", async () => {
    expect(await worktreeDirtyFiles(join(dir, "does-not-exist"))).toBeNull();
  });
});
