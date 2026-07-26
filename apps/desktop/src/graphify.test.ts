import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoKey, type RepoRef } from "@skipper/shared";
import { ensureGraphIndexed, graphifyForPlanning, type GraphifyDeps } from "./graphify";
import { GRAPHIFY_PIP_SPEC, graphifyBin, graphifyMcpBin } from "./graphify-runtime";
import {
  graphPathFor,
  isGraphifyRunning,
  loadGraphifyDoc,
  saveGraphifyDoc,
} from "./graphify-store";

let graphsDir: string;
let toolsDir: string;
let repoCounter = 0;

beforeEach(async () => {
  graphsDir = await mkdtemp(join(tmpdir(), "nb-graphify-drv-"));
  toolsDir = await mkdtemp(join(tmpdir(), "nb-graphify-tools-"));
});
afterEach(async () => {
  await rm(graphsDir, { recursive: true, force: true });
  await rm(toolsDir, { recursive: true, force: true });
});

function uniqueRepo(): RepoRef {
  return { owner: "o", name: `r${repoCounter++}` };
}

async function settle(): Promise<void> {
  // setTimeout (not setImmediate): give any would-be kick's threadpool fs work
  // wall-clock time to surface before asserting it did NOT happen.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
}

/** Wait until a background kick (marked running synchronously) finishes, so its
 *  fs writes don't race afterEach's rm. Wall-clock budget: the kick does real fs
 *  I/O on the libuv threadpool, so event-loop turns are not a valid unit. */
async function waitIdle(repo: RepoRef, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isGraphifyRunning(repoKey(repo))) {
    if (Date.now() > deadline)
      throw new Error("waitIdle: graphify kick still running after timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Make isGraphifyInstalled(toolsDir) return true (binaries + matching spec marker). */
async function stubInstalled(): Promise<void> {
  await mkdir(join(toolsDir, "bin"), { recursive: true });
  await writeFile(graphifyBin(toolsDir), "", "utf-8");
  await writeFile(graphifyMcpBin(toolsDir), "", "utf-8");
  await writeFile(join(toolsDir, "graphify.spec"), GRAPHIFY_PIP_SPEC, "utf-8");
}

async function writeGraphFile(repo: RepoRef): Promise<void> {
  const path = graphPathFor(graphsDir, repoKey(repo));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}", "utf-8");
}

interface FakeOps {
  fetchOrigin: ReturnType<typeof vi.fn>;
  resolveBaseRef: ReturnType<typeof vi.fn>;
  revParse: ReturnType<typeof vi.fn>;
  addWorktree: ReturnType<typeof vi.fn>;
  removeWorktree: ReturnType<typeof vi.fn>;
  ensureInstalled: ReturnType<typeof vi.fn>;
  extract: ReturnType<typeof vi.fn>;
}

function makeDeps(
  repo: RepoRef,
  opts: {
    baseSha?: string;
    ensureImpl?: () => Promise<void>;
    extractImpl?: () => Promise<void>;
  } = {},
): { deps: GraphifyDeps; ops: FakeOps } {
  const ops: FakeOps = {
    fetchOrigin: vi.fn(async () => {}),
    resolveBaseRef: vi.fn(async () => "origin/main"),
    revParse: vi.fn(async () => opts.baseSha ?? "sha-current"),
    addWorktree: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    ensureInstalled: vi.fn(opts.ensureImpl ?? (async () => {})),
    extract: vi.fn(opts.extractImpl ?? (async () => {})),
  };
  const deps: GraphifyDeps = {
    graphsDir,
    runtime: { uvBin: "uv", toolsDir },
    repo,
    repoPath: "/repo",
    withRepoGitLock: (_repo, fn) => fn(),
    onStatus: () => {},
    ops: ops as unknown as GraphifyDeps["ops"],
  };
  return { deps, ops };
}

describe("ensureGraphIndexed", () => {
  it("runs installing → indexing → ready and extracts in a worktree", async () => {
    const repo = uniqueRepo();
    const statuses: string[] = [];
    const record = async () =>
      void statuses.push((await loadGraphifyDoc(graphsDir, repoKey(repo)))!.status);
    const { deps, ops } = makeDeps(repo, { ensureImpl: record, extractImpl: record });

    await ensureGraphIndexed(deps);

    expect(statuses).toEqual(["installing", "indexing"]);
    const final = await loadGraphifyDoc(graphsDir, repoKey(repo));
    expect(final?.status).toBe("ready");
    expect(final?.indexedSha).toBe("sha-current");
    expect(ops.addWorktree).toHaveBeenCalledOnce();
    expect(ops.extract).toHaveBeenCalledOnce();
    expect(ops.removeWorktree).toHaveBeenCalledOnce();
  });

  it("short-circuits the extract when the base SHA is unchanged and graph.json exists", async () => {
    const repo = uniqueRepo();
    await stubInstalled();
    await saveGraphifyDoc(graphsDir, repoKey(repo), {
      version: 1,
      status: "ready",
      indexedSha: "sha-X",
      updatedAt: "t",
    });
    await writeGraphFile(repo);
    const { deps, ops } = makeDeps(repo, { baseSha: "sha-X" });

    await ensureGraphIndexed(deps);

    expect(ops.addWorktree).not.toHaveBeenCalled();
    expect(ops.extract).not.toHaveBeenCalled();
    const final = await loadGraphifyDoc(graphsDir, repoKey(repo));
    expect(final?.status).toBe("ready");
    expect(final?.indexedSha).toBe("sha-X");
  });

  it("lands failed and stops before the worktree when install fails", async () => {
    const repo = uniqueRepo();
    const { deps, ops } = makeDeps(repo, {
      ensureImpl: async () => {
        throw new Error("uv exploded");
      },
    });

    await ensureGraphIndexed(deps);

    const final = await loadGraphifyDoc(graphsDir, repoKey(repo));
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("uv exploded");
    expect(ops.addWorktree).not.toHaveBeenCalled();
    expect(ops.extract).not.toHaveBeenCalled();
  });

  it("lands failed but still removes the worktree when extract fails", async () => {
    const repo = uniqueRepo();
    await stubInstalled();
    const { deps, ops } = makeDeps(repo, {
      extractImpl: async () => {
        throw new Error("extract boom");
      },
    });

    await ensureGraphIndexed(deps);

    const final = await loadGraphifyDoc(graphsDir, repoKey(repo));
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("extract boom");
    expect(ops.addWorktree).toHaveBeenCalledOnce();
    expect(ops.removeWorktree).toHaveBeenCalledOnce();
  });

  it("coalesces a double-kick via the in-memory running set", async () => {
    const repo = uniqueRepo();
    await stubInstalled();
    const { deps, ops } = makeDeps(repo);

    await Promise.all([ensureGraphIndexed(deps), ensureGraphIndexed(deps)]);

    expect(ops.extract).toHaveBeenCalledOnce();
  });

  it("drops the final save when the on-disk runStartedAt no longer matches", async () => {
    const repo = uniqueRepo();
    await stubInstalled();
    const { deps } = makeDeps(repo, {
      extractImpl: async () => {
        // A fresher run stamps a different runStartedAt before our ready save lands.
        await saveGraphifyDoc(graphsDir, repoKey(repo), {
          version: 1,
          status: "indexing",
          updatedAt: "t",
          runStartedAt: "OTHER",
        });
      },
    });

    await ensureGraphIndexed(deps);

    const final = await loadGraphifyDoc(graphsDir, repoKey(repo));
    // The ready write was clobber-guarded away — the other run's state stands.
    expect(final?.status).toBe("indexing");
    expect(final?.runStartedAt).toBe("OTHER");
  });
});

describe("graphifyForPlanning", () => {
  it("returns a fresh context and does not kick when the SHA matches", async () => {
    const repo = uniqueRepo();
    await stubInstalled();
    await saveGraphifyDoc(graphsDir, repoKey(repo), {
      version: 1,
      status: "ready",
      indexedSha: "sha-A",
      updatedAt: "t",
    });
    await writeGraphFile(repo);
    const { deps, ops } = makeDeps(repo, { baseSha: "sha-A" });

    const ctx = await graphifyForPlanning(deps);

    expect(ctx).toEqual({
      mcp: { mcpBinPath: graphifyMcpBin(toolsDir), graphPath: graphPathFor(graphsDir, repoKey(repo)) },
      indexedSha: "sha-A",
    });
    await settle();
    expect(ops.addWorktree).not.toHaveBeenCalled();
  });

  it("returns the stale graph with currentBaseSha and kicks a re-index", async () => {
    const repo = uniqueRepo();
    await stubInstalled();
    await saveGraphifyDoc(graphsDir, repoKey(repo), {
      version: 1,
      status: "ready",
      indexedSha: "sha-A",
      updatedAt: "t",
    });
    await writeGraphFile(repo);
    const { deps, ops } = makeDeps(repo, { baseSha: "sha-B" });

    const ctx = await graphifyForPlanning(deps);

    expect(ctx?.indexedSha).toBe("sha-A");
    expect(ctx?.currentBaseSha).toBe("sha-B");
    await waitIdle(repo);
    expect(ops.addWorktree).toHaveBeenCalled();
  });

  it("returns undefined and kicks when there is no doc at all", async () => {
    const repo = uniqueRepo();
    await stubInstalled();
    const { deps, ops } = makeDeps(repo);

    const ctx = await graphifyForPlanning(deps);

    expect(ctx).toBeUndefined();
    await waitIdle(repo);
    expect(ops.addWorktree).toHaveBeenCalled();
  });

  it("returns undefined and does NOT re-kick a sticky failed doc", async () => {
    const repo = uniqueRepo();
    await stubInstalled();
    await saveGraphifyDoc(graphsDir, repoKey(repo), {
      version: 1,
      status: "failed",
      updatedAt: "t",
      error: "boom",
    });
    const { deps, ops } = makeDeps(repo);

    const ctx = await graphifyForPlanning(deps);

    expect(ctx).toBeUndefined();
    await settle();
    expect(ops.addWorktree).not.toHaveBeenCalled();
  });
});
