import { repoKey } from "@skipper/shared";
import type { RepoRef } from "@skipper/shared";

export type RepoGitLock = <T>(repo: RepoRef, fn: () => Promise<T>) => Promise<T>;

// Planner concurrency (2) and the coder can hit the same clone at once; git
// fetch + worktree add on a shared clone are not concurrency-safe, so serialize
// per repo. The map is bounded by the linked-repo count.
export function makeRepoGitLock(): RepoGitLock {
  const repoGitLocks = new Map<string, Promise<unknown>>();

  return function withRepoGitLock<T>(repo: RepoRef, fn: () => Promise<T>): Promise<T> {
    const key = repoKey(repo);
    const prev = repoGitLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    repoGitLocks.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };
}
