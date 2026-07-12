import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoLinks, saveRepoLinks, repoKey, validateRepoOrigin } from "./repo-links";
import { planFileName, readStoredPlan, writeStoredPlan } from "./plan-store";
import type { StoredPlan } from "@nestbrain/shared";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-repolinks-"));
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

describe("repoKey", () => {
  it("normalizes case", () => {
    expect(repoKey("CicaBabba", "Skipper")).toBe("cicababba/skipper");
  });
});

describe("validateRepoOrigin", () => {
  it.each([
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo/",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
  ])("accepts origin %s", async (url) => {
    const repoDir = await makeRepo(url);
    await expect(validateRepoOrigin(repoDir, "owner", "repo")).resolves.toBeUndefined();
  });

  it("is case-insensitive on owner/name", async () => {
    const repoDir = await makeRepo("https://github.com/Owner/Repo.git");
    await expect(validateRepoOrigin(repoDir, "owner", "repo")).resolves.toBeUndefined();
  });

  it("rejects a mismatched owner/name", async () => {
    const repoDir = await makeRepo("https://github.com/someone/else.git");
    await expect(validateRepoOrigin(repoDir, "owner", "repo")).rejects.toThrow(/does not match/);
  });

  it("rejects a non-github origin", async () => {
    const repoDir = await makeRepo("https://gitlab.com/owner/repo.git");
    await expect(validateRepoOrigin(repoDir, "owner", "repo")).rejects.toThrow(/does not match/);
  });

  it("rejects a directory that is not a git repo", async () => {
    const plain = join(dir, "plain");
    await mkdir(plain);
    await expect(validateRepoOrigin(plain, "owner", "repo")).rejects.toThrow(/not a git repository/);
  });

  it("rejects a missing path", async () => {
    await expect(validateRepoOrigin(join(dir, "nope"), "owner", "repo")).rejects.toThrow(
      /not a directory/,
    );
  });
});

describe("repo links store", () => {
  it("round-trips and starts fresh on missing/corrupt file", async () => {
    const filePath = join(dir, "repo-links.json");
    const fresh = await loadRepoLinks(filePath);
    expect(fresh).toEqual({ version: 1, repos: {} });

    fresh.repos[repoKey("o", "r")] = { localPath: "/x", linkedAt: "2026-07-11T10:00:00.000Z" };
    await saveRepoLinks(filePath, fresh);
    const loaded = await loadRepoLinks(filePath);
    expect(loaded).toEqual(fresh);
  });
});

describe("plan store", () => {
  it("sanitizes item ids into filenames", () => {
    expect(planFileName("github:12345")).toBe("github_12345.json");
  });

  it("round-trips a stored plan", async () => {
    const plansDir = join(dir, "plans");
    const stored: StoredPlan = {
      version: 2,
      itemId: "github:1",
      repo: { owner: "o", name: "r" },
      issueNumber: 1,
      generatedAt: "2026-07-11T10:00:00.000Z",
      model: "sonnet",
      plan: {
        summary: "s",
        files: [{ path: "a.ts", reason: "r" }],
        steps: [{ title: "t", detail: "d", files: [], symbols: [] }],
        acceptance: [],
        risks: [],
        openQuestions: [],
        estimatedSize: "s",
      },
    };
    const ref = planFileName(stored.itemId);
    await writeStoredPlan(plansDir, ref, stored);
    expect(await readStoredPlan(plansDir, ref)).toEqual(stored);
    expect(await readStoredPlan(plansDir, "missing.json")).toBeNull();
  });

  it("still reads a pre-#8 v1 plan", async () => {
    const plansDir = join(dir, "plans");
    const v1 = { version: 1, itemId: "github:2", plan: { summary: "old" } };
    await writeStoredPlan(plansDir, "v1.json", v1 as unknown as StoredPlan);
    expect(await readStoredPlan(plansDir, "v1.json")).toEqual(v1);
  });
});
