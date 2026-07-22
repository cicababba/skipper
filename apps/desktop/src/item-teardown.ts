import type { RepoRef, TrackedItem } from "@skipper/shared";
import { resolveBaseRef, discardWorktree } from "./worktrees";
import { archiveStoredPlan } from "./plan-store";
import { deletePlanChat } from "./plan-chat-store";
import { deleteAgentChats } from "./agent-chat-store";

/** Discards an item's worktree under the caller's per-repo git lock: resolves the
 *  base ref (best-effort) so a branch with no unique commits is pruned, then removes
 *  the worktree. Shared by archiveItem and untrackItem. */
export async function discardItemWorktreeUnderLock(opts: {
  repo: RepoRef;
  localPath: string;
  baseBranch: string | undefined;
  worktreePath: string;
  branch: string;
  withRepoGitLock: <T>(repo: RepoRef, fn: () => Promise<T>) => Promise<T>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { repo, localPath, baseBranch, worktreePath, branch, withRepoGitLock } = opts;
  try {
    await withRepoGitLock(repo, async () => {
      const baseRef = await resolveBaseRef(localPath, baseBranch).catch(() => undefined);
      await discardWorktree({ repoPath: localPath, worktreePath, branch, baseRef });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Archives the item's stored plan (swapping in the archived ref on success) and
 *  fire-and-forgets the plan/agent chat deletes. Returns the possibly-updated plan. */
export async function archivePlanAndDeleteChats(
  plansDir: string,
  itemId: string,
  plan: TrackedItem["plan"],
): Promise<TrackedItem["plan"]> {
  let result = plan;
  if (result?.ref) {
    const archivedRef = await archiveStoredPlan(plansDir, result.ref).catch(() => null);
    if (archivedRef) result = { ...result, ref: archivedRef };
  }
  void deletePlanChat(plansDir, itemId).catch(() => {});
  void deleteAgentChats(plansDir, itemId).catch(() => {});
  return result;
}
