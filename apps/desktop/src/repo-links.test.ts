import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubCodeHost, codeHostFor } from "@skipper/core";
import type { CodeHost } from "@skipper/core";
import { repoKey } from "@skipper/shared";
import { cloneRepo, loadRepoLinks, saveRepoLinks, validateRepoOrigin } from "./repo-links";
import { planFileName, readStoredPlan, updateStoredPlan, writeStoredPlan } from "./plan-store";
import type { StoredPlan } from "@skipper/shared";

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
    expect(repoKey({ owner: "CicaBabba", name: "Skipper" })).toBe("cicababba/skipper");
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
    await expect(validateRepoOrigin(repoDir, { owner: "owner", name: "repo" }, githubCodeHost)).resolves.toBeUndefined();
  });

  it("is case-insensitive on owner/name", async () => {
    const repoDir = await makeRepo("https://github.com/Owner/Repo.git");
    await expect(validateRepoOrigin(repoDir, { owner: "owner", name: "repo" }, githubCodeHost)).resolves.toBeUndefined();
  });

  it("rejects a mismatched owner/name", async () => {
    const repoDir = await makeRepo("https://github.com/someone/else.git");
    await expect(validateRepoOrigin(repoDir, { owner: "owner", name: "repo" }, githubCodeHost)).rejects.toThrow(/does not match/);
  });

  it("rejects a non-github origin", async () => {
    const repoDir = await makeRepo("https://gitlab.com/owner/repo.git");
    await expect(validateRepoOrigin(repoDir, { owner: "owner", name: "repo" }, githubCodeHost)).rejects.toThrow(/does not match/);
  });

  it("rejects a directory that is not a git repo", async () => {
    const plain = join(dir, "plain");
    await mkdir(plain);
    await expect(validateRepoOrigin(plain, { owner: "owner", name: "repo" }, githubCodeHost)).rejects.toThrow(/not a git repository/);
  });

  it("rejects a missing path", async () => {
    await expect(validateRepoOrigin(join(dir, "nope"), { owner: "owner", name: "repo" }, githubCodeHost)).rejects.toThrow(
      /not a directory/,
    );
  });
});

describe("validateRepoOrigin — gitlab baseUrl", () => {
  const gitlab = codeHostFor("gitlab");

  it("accepts a self-hosted origin when its baseUrl is passed", async () => {
    const repoDir = await makeRepo("https://gitlab.acme.com/grp/sub/repo.git");
    await expect(
      validateRepoOrigin(repoDir, { owner: "grp/sub", name: "repo" }, gitlab, "https://gitlab.acme.com"),
    ).resolves.toBeUndefined();
  });

  it("rejects a self-hosted origin when baseUrl is omitted (defaults to gitlab.com)", async () => {
    const repoDir = await makeRepo("https://gitlab.acme.com/grp/sub/repo.git");
    await expect(
      validateRepoOrigin(repoDir, { owner: "grp/sub", name: "repo" }, gitlab),
    ).rejects.toThrow(/does not match/);
  });

  it("accepts a gitlab.com origin on the default path (baseUrl undefined)", async () => {
    const repoDir = await makeRepo("https://gitlab.com/owner/repo.git");
    await expect(
      validateRepoOrigin(repoDir, { owner: "owner", name: "repo" }, gitlab),
    ).resolves.toBeUndefined();
  });
});

describe("cloneRepo — baseUrl threading", () => {
  it("passes baseUrl through to host.cloneUrl", async () => {
    // Local source repo keeps the clone offline; the stub host records the baseUrl
    // it is handed and validates via a matching parseOrigin.
    const src = join(dir, "src");
    await mkdir(src);
    execFileSync("git", ["-C", src, "init", "-q"]);

    let seenBaseUrl: string | undefined = "unset";
    const stubHost: Pick<CodeHost, "cloneUrl" | "parseOrigin"> = {
      cloneUrl: (_repo, baseUrl) => {
        seenBaseUrl = baseUrl;
        return src;
      },
      parseOrigin: () => ({ owner: "grp/sub", name: "repo" }),
    };

    const destParent = join(dir, "dest");
    const localPath = await cloneRepo(
      stubHost,
      { owner: "grp/sub", name: "repo" },
      destParent,
      { username: "x", password: "y" },
      "https://gitlab.acme.com",
    );

    expect(seenBaseUrl).toBe("https://gitlab.acme.com");
    expect(localPath).toBe(join(destParent, "repo"));
  });
});

describe("repo links store", () => {
  it("round-trips and starts fresh on missing/corrupt file", async () => {
    const filePath = join(dir, "repo-links.json");
    const fresh = await loadRepoLinks(filePath);
    expect(fresh).toEqual({ version: 1, repos: {} });

    fresh.repos[repoKey({ owner: "o", name: "r" })] = { localPath: "/x", linkedAt: "2026-07-11T10:00:00.000Z" };
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

  it("updates the plan body, stamps editedAt, and preserves the envelope", async () => {
    const plansDir = join(dir, "plans");
    const stored: StoredPlan = {
      version: 2,
      itemId: "github:3",
      repo: { owner: "o", name: "r" },
      issueNumber: 3,
      generatedAt: "2026-07-11T10:00:00.000Z",
      model: "sonnet",
      plan: {
        summary: "original",
        files: [{ path: "a.ts", reason: "r" }],
        steps: [{ title: "t", detail: "d", files: [], symbols: [] }],
        acceptance: [],
        risks: [],
        openQuestions: [],
        estimatedSize: "s",
      },
      confidence: {
        version: 1,
        composite: 0.7,
        weights: { groundedness: 0.35, convergence: 0.25, critic: 0.3, clarity: 0.1 },
        signals: {},
        errors: [],
        computedAt: "2026-07-11T10:01:00.000Z",
      },
    };
    const ref = planFileName(stored.itemId);
    await writeStoredPlan(plansDir, ref, stored);

    const edited = { ...stored.plan, summary: "edited" };
    const updated = await updateStoredPlan(plansDir, ref, edited);
    expect(updated?.plan.summary).toBe("edited");
    expect(updated?.editedAt).toBeTruthy();
    expect(updated?.confidence).toEqual(stored.confidence);
    expect(updated?.generatedAt).toBe(stored.generatedAt);
    expect(updated?.version).toBe(2);
    expect(await readStoredPlan(plansDir, ref)).toEqual(updated);
  });

  it("returns null when updating a missing ref", async () => {
    const plansDir = join(dir, "plans");
    expect(
      await updateStoredPlan(plansDir, "missing.json", {
        summary: "s",
        files: [{ path: "a.ts", reason: "r" }],
        steps: [{ title: "t", detail: "d", files: [], symbols: [] }],
        acceptance: [],
        risks: [],
        openQuestions: [],
        estimatedSize: "s",
      }),
    ).toBeNull();
  });
});
