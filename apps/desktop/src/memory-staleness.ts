// Staleness sweep (#256): once a day per linked repo, list the base ref's tree
// and stamp every memory with the fraction of its files that no longer exist
// there. One git call per repo, under the repo git lock, off the poll loop's
// tail. Never throws — a memory signal must not be able to break polling.

import {
  listSolutionRecords,
  readSolutionRecord,
  recordFilesTouched,
  stalenessFraction,
  writeSolutionRecord,
  type SolutionRecordEntry,
} from "@skipper/core";
import { repoKey, type RepoRef } from "@skipper/shared";
import type { RepoGitLock } from "./git-lock";

const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

export interface StalenessDeps {
  memoryDir: string;
  /** Linked clones by repoKey. */
  getRepoLinks: () => Promise<Record<string, { localPath: string; baseBranch?: string }>>;
  runGit: (
    cwd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  withRepoGitLock: RepoGitLock;
  resolveBaseRef: (repoPath: string, baseBranch?: string) => Promise<string>;
  broadcast: () => void;
  /** Test seam — the throttle clock. */
  now?: () => number;
}

let deps: StalenessDeps | null = null;
const lastSweepAt = new Map<string, number>();
let sweeping = false;

export function initStalenessSweep(stalenessDeps: StalenessDeps): void {
  deps = stalenessDeps;
  lastSweepAt.clear();
  sweeping = false;
}

function groupByRepo(entries: SolutionRecordEntry[]): Map<string, SolutionRecordEntry[]> {
  const byRepo = new Map<string, SolutionRecordEntry[]>();
  for (const entry of entries) {
    const key = repoKey(entry.record.repo);
    const group = byRepo.get(key);
    if (group) group.push(entry);
    else byRepo.set(key, [entry]);
  }
  return byRepo;
}

async function baseRefPaths(repo: RepoRef, localPath: string, baseBranch?: string): Promise<Set<string>> {
  const d = deps!;
  return d.withRepoGitLock(repo, async () => {
    const baseRef = await d.resolveBaseRef(localPath, baseBranch);
    const res = await d.runGit(localPath, ["ls-tree", "-r", "--name-only", baseRef]);
    if (res.code !== 0) {
      throw new Error(`git ls-tree ${baseRef} failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    return new Set(res.stdout.split("\n").filter(Boolean));
  });
}

async function sweepRepo(entries: SolutionRecordEntry[], paths: Set<string>): Promise<boolean> {
  const d = deps!;
  let changed = false;
  for (const { ref, record } of entries) {
    try {
      const staleness = stalenessFraction(recordFilesTouched(record), paths);
      // Writing an unchanged value would rewrite the whole memory dir daily,
      // so stalenessCheckedAt only moves when the fraction itself moves.
      if (staleness === record.staleness) continue;
      const fresh = (await readSolutionRecord(d.memoryDir, ref)) ?? record;
      await writeSolutionRecord(d.memoryDir, {
        ...fresh,
        staleness,
        stalenessCheckedAt: new Date().toISOString(),
      });
      changed = true;
    } catch (err) {
      console.warn(`[memory] staleness write failed for ${ref}: ${String(err)}`);
    }
  }
  return changed;
}

/** Fire-and-forget sweep of every linked repo that has memories and is due. */
export async function sweepStaleness(): Promise<void> {
  if (!deps || sweeping) return;
  const d = deps;
  sweeping = true;
  try {
    const byRepo = groupByRepo(await listSolutionRecords(d.memoryDir));
    if (byRepo.size === 0) return;
    const links = await d.getRepoLinks();
    const now = d.now ?? Date.now;

    let changed = false;
    for (const [key, entries] of byRepo) {
      const link = links[key];
      if (!link) continue;
      if (now() - (lastSweepAt.get(key) ?? 0) < SWEEP_EVERY_MS) continue;
      // Stamped before the work: a repo whose git keeps failing retries daily
      // rather than on every poll.
      lastSweepAt.set(key, now());
      try {
        const paths = await baseRefPaths(entries[0].record.repo, link.localPath, link.baseBranch);
        if (await sweepRepo(entries, paths)) changed = true;
      } catch (err) {
        console.warn(`[memory] staleness sweep skipped for ${key}: ${String(err)}`);
      }
    }
    if (changed) d.broadcast();
  } catch (err) {
    console.warn(`[memory] staleness sweep failed: ${String(err)}`);
  } finally {
    sweeping = false;
  }
}
