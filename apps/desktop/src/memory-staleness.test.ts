import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoRef, SolutionRecord } from "@skipper/shared";
import { memoryFileName, readSolutionRecord, writeSolutionRecord } from "@skipper/core";
import { initStalenessSweep, sweepStaleness, type StalenessDeps } from "./memory-staleness";

// The #256 sweep, driver-style: fake git/lock/links against a real on-disk
// store. It runs off the tail of the poll loop, so the invariants under test are
// "throttled", "isolated" and "never throws" as much as the arithmetic.

const REPO_A: RepoRef = { owner: "acme", name: "rocket" };
const REPO_B: RepoRef = { owner: "acme", name: "anvil" };
const DAY_MS = 86_400_000;

let memoryDir: string;

function makeRecord(
  itemId: string,
  files: string[],
  overrides: Partial<SolutionRecord> = {},
): SolutionRecord {
  return {
    version: 2,
    itemId,
    repo: REPO_A,
    title: `record ${itemId}`,
    url: "https://example.test/1",
    diffStats: { filesChanged: files.length, totalChangedLines: 10, files },
    outcome: "merged",
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

interface Harness {
  deps: StalenessDeps;
  runGit: ReturnType<typeof vi.fn>;
  resolveBaseRef: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  order: string[];
  setNow: (at: number) => void;
}

function makeHarness(
  opts: {
    tree?: Record<string, string[] | Error>;
    links?: Record<string, { localPath: string; baseBranch?: string }>;
    getRepoLinks?: StalenessDeps["getRepoLinks"];
  } = {},
): Harness {
  const order: string[] = [];
  let now = Date.parse("2026-07-20T00:00:00.000Z");
  const trees = opts.tree ?? { "acme/rocket": ["src/a.ts", "src/b.ts"] };

  const runGit = vi.fn(async (cwd: string, args: string[]) => {
    order.push(`git ${args[0]} ${cwd}`);
    const key = cwd.replace("/clones/", "acme/");
    const tree = trees[key];
    if (tree instanceof Error) return { code: 128, stdout: "", stderr: tree.message };
    return { code: 0, stdout: `${(tree ?? []).join("\n")}\n`, stderr: "" };
  });
  const resolveBaseRef = vi.fn(async () => "origin/main");
  const broadcast = vi.fn();

  const deps: StalenessDeps = {
    memoryDir,
    getRepoLinks:
      opts.getRepoLinks ??
      (async () =>
        opts.links ?? {
          "acme/rocket": { localPath: "/clones/rocket" },
          "acme/anvil": { localPath: "/clones/anvil" },
        }),
    runGit: runGit as unknown as StalenessDeps["runGit"],
    withRepoGitLock: async (repo, fn) => {
      order.push(`lock-enter ${repo.owner}/${repo.name}`);
      try {
        return await fn();
      } finally {
        order.push(`lock-exit ${repo.owner}/${repo.name}`);
      }
    },
    resolveBaseRef,
    broadcast,
    now: () => now,
  };
  return { deps, runGit, resolveBaseRef, broadcast, order, setNow: (at) => (now = at) };
}

const read = (id: string): Promise<SolutionRecord | null> =>
  readSolutionRecord(memoryDir, memoryFileName(id));

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "nb-staleness-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("sweepStaleness", () => {
  it("stamps the missing fraction on every record of a linked repo", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts", "src/b.ts"]));
    await writeSolutionRecord(memoryDir, makeRecord("github:2", ["src/a.ts", "src/gone.ts"]));
    await writeSolutionRecord(memoryDir, makeRecord("github:3", ["src/gone.ts"]));
    const h = makeHarness();
    initStalenessSweep(h.deps);

    await sweepStaleness();

    expect((await read("github:1"))?.staleness).toBe(0);
    expect((await read("github:2"))?.staleness).toBe(0.5);
    expect((await read("github:3"))?.staleness).toBe(1);
    expect(Date.parse((await read("github:3"))!.stalenessCheckedAt!)).not.toBeNaN();
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it("lists the base ref's tree once per repo, under the repo git lock", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts"]));
    await writeSolutionRecord(memoryDir, makeRecord("github:2", ["src/b.ts"]));
    const h = makeHarness();
    initStalenessSweep(h.deps);

    await sweepStaleness();

    expect(h.runGit).toHaveBeenCalledTimes(1);
    expect(h.runGit).toHaveBeenCalledWith("/clones/rocket", [
      "ls-tree",
      "-r",
      "--name-only",
      "origin/main",
    ]);
    expect(h.order).toEqual([
      "lock-enter acme/rocket",
      "git ls-tree /clones/rocket",
      "lock-exit acme/rocket",
    ]);
  });

  it("honours a per-repo base-branch override", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts"]));
    const h = makeHarness({
      links: { "acme/rocket": { localPath: "/clones/rocket", baseBranch: "release" } },
    });
    initStalenessSweep(h.deps);

    await sweepStaleness();
    expect(h.resolveBaseRef).toHaveBeenCalledWith("/clones/rocket", "release");
  });

  it("skips a repo again inside the 24h window and resumes after it", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts"]));
    const h = makeHarness();
    initStalenessSweep(h.deps);

    await sweepStaleness();
    expect(h.runGit).toHaveBeenCalledTimes(1);

    h.setNow(Date.parse("2026-07-20T00:00:00.000Z") + DAY_MS - 1);
    await sweepStaleness();
    expect(h.runGit).toHaveBeenCalledTimes(1);

    h.setNow(Date.parse("2026-07-20T00:00:00.000Z") + DAY_MS + 1);
    await sweepStaleness();
    expect(h.runGit).toHaveBeenCalledTimes(2);
  });

  // Stamped before the work: a repo whose git keeps failing must not be retried
  // on every single poll.
  it("throttles a repo whose git failed just like a successful one", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts"]));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = makeHarness({ tree: { "acme/rocket": new Error("not a git repository") } });
    initStalenessSweep(h.deps);

    await sweepStaleness();
    await sweepStaleness();
    expect(h.runGit).toHaveBeenCalledTimes(1);
    expect((await read("github:1"))?.staleness).toBeUndefined();
  });

  it("does not rewrite a record whose fraction has not moved", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/gone.ts"]));
    const h = makeHarness();
    initStalenessSweep(h.deps);

    await sweepStaleness();
    const first = (await read("github:1"))!.stalenessCheckedAt;
    expect(h.broadcast).toHaveBeenCalledTimes(1);

    h.setNow(Date.parse("2026-07-22T00:00:00.000Z"));
    await sweepStaleness();

    expect((await read("github:1"))?.stalenessCheckedAt).toBe(first);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it("restamps when the tree moved under the record", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts"]));
    const tree: Record<string, string[]> = { "acme/rocket": ["src/a.ts"] };
    const h = makeHarness({ tree });
    initStalenessSweep(h.deps);

    await sweepStaleness();
    expect((await read("github:1"))?.staleness).toBe(0);

    tree["acme/rocket"] = ["src/renamed.ts"];
    h.setNow(Date.parse("2026-07-22T00:00:00.000Z"));
    await sweepStaleness();

    expect((await read("github:1"))?.staleness).toBe(1);
    expect(h.broadcast).toHaveBeenCalledTimes(2);
  });

  it("keeps one repo's git failure from touching another's records", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/gone.ts"]));
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:2", ["src/anvil.ts"], { repo: REPO_B }),
    );
    const h = makeHarness({
      tree: { "acme/rocket": new Error("boom"), "acme/anvil": ["src/anvil.ts"] },
    });
    initStalenessSweep(h.deps);

    await sweepStaleness();

    expect((await read("github:1"))?.staleness).toBeUndefined();
    expect((await read("github:2"))?.staleness).toBe(0);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it("ignores records whose repo is not linked", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts"]));
    const h = makeHarness({ links: {} });
    initStalenessSweep(h.deps);

    await sweepStaleness();

    expect(h.runGit).not.toHaveBeenCalled();
    expect((await read("github:1"))?.staleness).toBeUndefined();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("leaves a record that claims no files unmeasured", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", []));
    const h = makeHarness();
    initStalenessSweep(h.deps);

    await sweepStaleness();

    const rec = await read("github:1");
    expect(rec?.staleness).toBeUndefined();
    expect(rec?.stalenessCheckedAt).toBeUndefined();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("measures a note's linked files too", async () => {
    await writeSolutionRecord(memoryDir, {
      version: 2,
      itemId: "note:1",
      repo: REPO_A,
      title: "a note",
      url: "",
      kind: "note",
      note: { body: "b", files: ["src/gone.ts"] },
      capturedAt: "2026-07-10T00:00:00.000Z",
    });
    const h = makeHarness();
    initStalenessSweep(h.deps);

    await sweepStaleness();
    expect((await read("note:1"))?.staleness).toBe(1);
  });

  it("does nothing at all when the memory dir is empty", async () => {
    const h = makeHarness();
    initStalenessSweep(h.deps);

    await sweepStaleness();
    expect(h.runGit).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("swallows a links failure — the poll loop must survive it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts"]));
    const h = makeHarness({
      getRepoLinks: async () => {
        throw new Error("repo links unreadable");
      },
    });
    initStalenessSweep(h.deps);

    await expect(sweepStaleness()).resolves.toBeUndefined();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("is inert before init", async () => {
    await expect(sweepStaleness()).resolves.toBeUndefined();
  });

  it("does not re-enter while a sweep is in flight", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", ["src/a.ts"]));
    const h = makeHarness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    h.deps.resolveBaseRef = vi.fn(async () => {
      await gate;
      return "origin/main";
    });
    initStalenessSweep(h.deps);

    const first = sweepStaleness();
    await sweepStaleness();
    release();
    await first;

    expect(h.runGit).toHaveBeenCalledTimes(1);
  });
});
