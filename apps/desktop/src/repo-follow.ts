import type { OrchestratorManifest } from "@skipper/core";
import { isSettledState, repoKey, resolveRepoIntakeSettings } from "@skipper/shared";
import type { BlockingItem, RepoIntakeSettings, RepoRef, TrackedItem } from "@skipper/shared";

/**
 * Tracked items on a repo that still hold live work — a plan, a worktree, a PR
 * under shepherd, or a gate waiting on the user. Every ATTENTION_STATE is in
 * here by construction, which is what makes a repo with a pending gate
 * un-unfollowable.
 */
export function activeItemsForRepo(m: OrchestratorManifest, key: string): TrackedItem[] {
  return Object.values(m.items).filter(
    (item) => repoKey(item.repo) === key && !isSettledState(item.state),
  );
}

export function toBlockingItems(items: TrackedItem[]): BlockingItem[] {
  return items.map((item) => ({ id: item.id, key: item.key, state: item.state }));
}

/** Linking a repo is a stronger act of intent than ticking a box — it follows. */
export function markRepoFollowed(m: OrchestratorManifest, repo: RepoRef): void {
  const key = repoKey(repo);
  m.repoSettings[key] = { ...m.repoSettings[key], followed: true };
}

export type ApplyRepoFollowedResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string; blocking: BlockingItem[] };

/**
 * Writes the explicit followed flag, refusing an unfollow while the repo has
 * active items. Unfollowing also purges the repo's parked issues: nothing would
 * ever admit them again. `manifest.parked` is keyed by issue id and carries no
 * repo, so the ids are resolved through the poll cache — an issue absent from
 * the cache cannot be admitted anyway.
 */
export function applyRepoFollowed(
  m: OrchestratorManifest,
  repo: RepoRef,
  followed: boolean,
  cachedIssues: Iterable<{ id: string; repo?: RepoRef }>,
): ApplyRepoFollowedResult {
  const key = repoKey(repo);
  const before = resolveRepoIntakeSettings(m.repoSettings[key]).followed;
  if (!followed) {
    const active = activeItemsForRepo(m, key);
    if (active.length > 0) {
      return {
        ok: false,
        error: `${repo.owner}/${repo.name} still has ${active.length} active item${
          active.length === 1 ? "" : "s"
        }`,
        blocking: toBlockingItems(active),
      };
    }
  }
  m.repoSettings[key] = { ...m.repoSettings[key], followed };
  if (!followed) {
    for (const issue of cachedIssues) {
      if (issue.repo && repoKey(issue.repo) === key) delete m.parked[issue.id];
    }
  }
  return { ok: true, changed: before !== followed };
}

/**
 * Backstop for the generic repo-settings patch endpoint (#15): a patch that
 * would unfollow a repo holding active items keeps the repo followed, and the
 * rest of the patch still applies. Mirrors "invalid values are dropped, never
 * coerced" — the user-facing refusal belongs to setRepoFollowed.
 */
export function guardFollowedPatch(
  m: OrchestratorManifest,
  key: string,
  merged: RepoIntakeSettings,
): RepoIntakeSettings {
  const wasFollowed = resolveRepoIntakeSettings(m.repoSettings[key]).followed;
  const stillFollowed = resolveRepoIntakeSettings(merged).followed;
  if (!wasFollowed || stillFollowed) return merged;
  return activeItemsForRepo(m, key).length > 0 ? { ...merged, followed: true } : merged;
}
