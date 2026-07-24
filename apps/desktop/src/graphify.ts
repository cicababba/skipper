// Graphify index driver (#233): the orchestrator-facing loop that keeps a repo's
// knowledge graph indexed and hands the planner a ready-to-query context. Never
// throws — all state lives on disk (graphify-store) and is broadcast via
// onStatus; failures land as a "failed" doc, never an error in the orchestration
// loop. git ops / runtime ops are injectable so the driver is unit-testable
// without a real repo or uv install.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoKey, type RepoRef } from "@skipper/shared";
import type { GraphifyContext } from "@skipper/core";
import { runGit } from "./git";
import type { RepoGitLock } from "./git-lock";
import {
  ensureGraphifyInstalled,
  graphifyMcpBin,
  isGraphifyInstalled,
  runGraphifyExtract,
  type GraphifyRuntime,
} from "./graphify-runtime";
import {
  clearGraphifyRunning,
  graphPathFor,
  graphifyRepoDir,
  isGraphifyRunning,
  loadGraphifyDoc,
  markGraphifyRunning,
  readReadyGraph,
  saveGraphifyDoc,
} from "./graphify-store";
import { addDetachedWorktree, removeDetachedWorktree, fetchOrigin, resolveBaseRef } from "./worktrees";

interface GraphifyOps {
  fetchOrigin: (repoPath: string) => Promise<void>;
  resolveBaseRef: (repoPath: string, baseBranch?: string) => Promise<string>;
  revParse: (repoPath: string, ref: string) => Promise<string>;
  addWorktree: (repoPath: string, worktreePath: string, ref: string) => Promise<void>;
  removeWorktree: (repoPath: string, worktreePath: string) => Promise<void>;
  ensureInstalled: () => Promise<void>;
  extract: (worktreePath: string, outDir: string) => Promise<void>;
}

export interface GraphifyDeps {
  graphsDir: string;
  runtime: GraphifyRuntime;
  repo: RepoRef;
  /** The linked local checkout the extract worktree is added from. */
  repoPath: string;
  /** Per-repo base-branch override; undefined = origin/HEAD. */
  baseBranch?: string;
  withRepoGitLock: RepoGitLock;
  /** Poke the snapshot broadcast on every status change. */
  onStatus?: () => void;
  /** Test seams — each op falls back to the real implementation. */
  ops?: Partial<GraphifyOps>;
}

async function defaultRevParse(repoPath: string, ref: string): Promise<string> {
  const r = await runGit(repoPath, ["rev-parse", ref]);
  if (r.code !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return r.stdout.trim();
}

function resolveOps(deps: GraphifyDeps): GraphifyOps {
  return {
    fetchOrigin: deps.ops?.fetchOrigin ?? ((repoPath) => fetchOrigin(repoPath)),
    resolveBaseRef:
      deps.ops?.resolveBaseRef ?? ((repoPath, baseBranch) => resolveBaseRef(repoPath, baseBranch)),
    revParse: deps.ops?.revParse ?? defaultRevParse,
    addWorktree: deps.ops?.addWorktree ?? addDetachedWorktree,
    removeWorktree: deps.ops?.removeWorktree ?? removeDetachedWorktree,
    ensureInstalled: deps.ops?.ensureInstalled ?? (() => ensureGraphifyInstalled(deps.runtime)),
    extract: deps.ops?.extract ?? ((wt, outDir) => runGraphifyExtract(deps.runtime, wt, outDir)),
  };
}

/**
 * Fire-and-forget index run. Coalesced by the in-memory running set (a second
 * call while one is in flight returns immediately). Every terminal write is
 * guarded on the on-disk runStartedAt still matching this run, so a stale run
 * can't clobber a fresher one's state.
 */
export async function ensureGraphIndexed(deps: GraphifyDeps): Promise<void> {
  const key = repoKey(deps.repo);
  if (isGraphifyRunning(key)) return;
  markGraphifyRunning(key);
  const runStartedAt = new Date().toISOString();
  const ops = resolveOps(deps);
  const repoDir = graphifyRepoDir(deps.graphsDir, key);
  const wtDir = join(repoDir, "wt");

  const prev = await loadGraphifyDoc(deps.graphsDir, key);
  const prevSha = prev?.indexedSha;

  const guardedSave = async (doc: Parameters<typeof saveGraphifyDoc>[2]): Promise<void> => {
    const onDisk = await loadGraphifyDoc(deps.graphsDir, key);
    if (onDisk && onDisk.runStartedAt !== runStartedAt) return;
    await saveGraphifyDoc(deps.graphsDir, key, doc);
  };

  try {
    if (!(await isGraphifyInstalled(deps.runtime.toolsDir))) {
      await saveGraphifyDoc(deps.graphsDir, key, {
        version: 1,
        status: "installing",
        ...(prevSha ? { indexedSha: prevSha } : {}),
        updatedAt: new Date().toISOString(),
        runStartedAt,
      });
      deps.onStatus?.();
      try {
        await ops.ensureInstalled();
      } catch (err) {
        await guardedSave({
          version: 1,
          status: "failed",
          ...(prevSha ? { indexedSha: prevSha } : {}),
          updatedAt: new Date().toISOString(),
          error: errText(err),
          runStartedAt,
        });
        return;
      }
    }

    await saveGraphifyDoc(deps.graphsDir, key, {
      version: 1,
      status: "indexing",
      ...(prevSha ? { indexedSha: prevSha } : {}),
      updatedAt: new Date().toISOString(),
      runStartedAt,
    });
    deps.onStatus?.();

    try {
      const sha = await deps.withRepoGitLock(deps.repo, async () => {
        // Offline is fine: fall back to whatever refs are already local.
        try {
          await ops.fetchOrigin(deps.repoPath);
        } catch {
          /* stale refs */
        }
        const baseRef = await ops.resolveBaseRef(deps.repoPath, deps.baseBranch);
        const resolvedSha = await ops.revParse(deps.repoPath, baseRef);
        if (resolvedSha === prevSha && existsSync(graphPathFor(deps.graphsDir, key))) {
          return resolvedSha; // already indexed at this sha — skip the extract
        }
        try {
          await ops.addWorktree(deps.repoPath, wtDir, resolvedSha);
          await ops.extract(wtDir, repoDir);
        } finally {
          await ops.removeWorktree(deps.repoPath, wtDir).catch(() => {});
        }
        return resolvedSha;
      });
      await guardedSave({
        version: 1,
        status: "ready",
        indexedSha: sha,
        updatedAt: new Date().toISOString(),
        runStartedAt,
      });
    } catch (err) {
      await guardedSave({
        version: 1,
        status: "failed",
        ...(prevSha ? { indexedSha: prevSha } : {}),
        updatedAt: new Date().toISOString(),
        error: errText(err),
        runStartedAt,
      });
    }
  } finally {
    clearGraphifyRunning(key);
    deps.onStatus?.();
  }
}

/**
 * The planner read path: return a ready-to-query context, never blocking. A stale
 * or missing graph kicks a background re-index but the current run proceeds — with
 * the last-good graph (declaring the base has advanced) or without a graph at all.
 * Never throws → undefined on any failure.
 */
export async function graphifyForPlanning(
  deps: GraphifyDeps,
): Promise<GraphifyContext | undefined> {
  try {
    const key = repoKey(deps.repo);
    const ready = await readReadyGraph(deps.graphsDir, key);
    if (!ready) {
      // Only a repo that was never indexed re-kicks here; a "failed" doc is sticky
      // (retry is explicit — Re-index button / toggle off→on).
      const doc = await loadGraphifyDoc(deps.graphsDir, key);
      if (!doc) void ensureGraphIndexed(deps);
      return undefined;
    }
    const ops = resolveOps(deps);
    let currentSha: string | undefined;
    try {
      // No fetch: prepareWorktreeFor already fetched for this planning run.
      const baseRef = await ops.resolveBaseRef(deps.repoPath, deps.baseBranch);
      currentSha = await ops.revParse(deps.repoPath, baseRef);
    } catch {
      /* best-effort — use the stored graph as-is */
    }
    const stale = currentSha !== undefined && currentSha !== ready.indexedSha;
    if (stale) void ensureGraphIndexed(deps);
    return {
      mcp: { mcpBinPath: graphifyMcpBin(deps.runtime.toolsDir), graphPath: ready.graphPath },
      indexedSha: ready.indexedSha,
      ...(stale ? { currentBaseSha: currentSha } : {}),
    };
  } catch {
    return undefined;
  }
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
