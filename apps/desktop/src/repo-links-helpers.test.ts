import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "@skipper/shared";
import { runGit } from "./git";
import { branchesForLocalClone, detectHostForLocalPath } from "./repo-links";

vi.mock("./git", () => ({ runGit: vi.fn() }));
const runGitMock = vi.mocked(runGit);

// The detectHostForLocalPath fixtures spawn real git (measured at 2.0–2.6 s per
// test when the other packages' suites run in parallel under `turbo test`); the
// 5 s default is a unit-test budget (#316).
vi.setConfig({ testTimeout: 20_000 });

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("branchesForLocalClone", () => {
  it("lists origin branches and resolves the default from origin/HEAD", async () => {
    runGitMock.mockImplementation(async (_cwd, args) => {
      if (args[0] === "for-each-ref") return ok("origin/main\norigin/feature\norigin/HEAD\n");
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      return fail("unexpected");
    });

    const res = await branchesForLocalClone("/repo");

    expect(res).toEqual({ ok: true, branches: ["feature", "main"], defaultBranch: "main" });
  });

  it("returns defaultBranch undefined when the base ref cannot be resolved", async () => {
    runGitMock.mockImplementation(async (_cwd, args) => {
      if (args[0] === "for-each-ref") return ok("origin/main\n");
      return fail("no HEAD"); // symbolic-ref and ls-remote both fail
    });

    const res = await branchesForLocalClone("/repo");

    expect(res).toEqual({ ok: true, branches: ["main"], defaultBranch: undefined });
  });

  it("returns an error when for-each-ref fails", async () => {
    runGitMock.mockResolvedValue(fail("not a git repository"));

    const res = await branchesForLocalClone("/repo");

    expect(res).toEqual({ ok: false, error: "not a git repository" });
  });
});

describe("detectHostForLocalPath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nb-detecthost-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeRepo(originUrl: string): Promise<string> {
    const repoDir = join(dir, `repo-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(repoDir);
    execFileSync("git", ["-C", repoDir, "init", "-q"]);
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", originUrl]);
    return repoDir;
  }

  it("resolves against a cloud host default without any accounts", async () => {
    const repoDir = await makeRepo("https://github.com/acme/widget.git");
    await expect(detectHostForLocalPath([], "acme", "widget", repoDir)).resolves.toBeUndefined();
  });

  it("throws when the origin matches no registered host", async () => {
    const repoDir = await makeRepo("https://github.com/acme/widget.git");
    await expect(detectHostForLocalPath([], "other", "repo", repoDir)).rejects.toThrow();
  });

  it("uses an account's self-hosted baseUrl to match a self-hosted origin", async () => {
    const repoDir = await makeRepo("https://gitlab.mycorp.com/grp/proj.git");
    const account: Account = {
      provider: "gitlab",
      key: "gitlab:gitlab.mycorp.com:1",
      id: "1",
      baseUrl: "https://gitlab.mycorp.com",
    };

    // Without the account's baseUrl the self-hosted origin matches nothing.
    await expect(detectHostForLocalPath([], "grp", "proj", repoDir)).rejects.toThrow();
    // With it, the gitlab host is tried against the self-hosted instance and matches.
    await expect(
      detectHostForLocalPath([account], "grp", "proj", repoDir),
    ).resolves.toBeUndefined();
  });
});
