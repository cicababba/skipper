import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchFor,
  ensureWorktree,
  listWorktrees,
  removeWorktree,
  resolveBaseRef,
  worktreeDirFor,
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

describe("worktreeDirFor / branchFor", () => {
  it("builds a sanitized per-issue path", () => {
    const path = worktreeDirFor("/root", { owner: "My Org", name: "a/b" }, 7);
    expect(path).toBe(join("/root", "My_Org-a_b", "issue-7"));
  });

  it("branch matches the reconcile heuristic", () => {
    expect(branchFor(42)).toBe("feature/issue-42");
    expect(/^(?:feature|fix)\/issue-(\d+)\b/.exec(branchFor(42))?.[1]).toBe("42");
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
