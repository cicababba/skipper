// Pure decision for a base-branch change (#156): given the tracked items, the
// repo whose base moved, and a probe of each candidate's worktree, decide which
// worktrees to discard, which items to replan on the new base, and which to
// skip (leaving worktree + plan untouched). No IO — the caller runs the git
// side and the transitions.

import { repoKey, type BaseChangeSkipReason, type TrackedItem } from "@skipper/shared";

export interface WorktreeProbe {
  /** null = dir gone / git failed (nothing to lose). */
  dirty: boolean | null;
  /** null = base ref unresolved / rev-list failed. NaN counts as unresolved too:
   *  the type admits it, and treating it as "not ahead" would discard the worktree. */
  aheadOfOldBase: number | null;
}

export interface BaseChangeActions {
  discard: { id: string; worktree: { path: string; branch: string } }[];
  replan: string[];
  skipped: { id: string; key: string; reason: BaseChangeSkipReason }[];
}

const CANDIDATE_STATES: ReadonlySet<TrackedItem["state"]> = new Set([
  "triage",
  "plan-gate",
  "needs-input",
  "queued",
]);

/** plan-gate/queued always regenerate; needs-input only with a plan to redo; triage never. */
function shouldReplan(item: TrackedItem): boolean {
  switch (item.state) {
    case "plan-gate":
    case "queued":
      return true;
    case "needs-input":
      return item.plan !== undefined;
    default:
      return false;
  }
}

export function resolveBaseChangeActions(
  items: TrackedItem[],
  repoKeyStr: string,
  probes: Map<string, WorktreeProbe>,
): BaseChangeActions {
  const discard: BaseChangeActions["discard"] = [];
  const replan: string[] = [];
  const skipped: BaseChangeActions["skipped"] = [];

  for (const item of items) {
    if (repoKey(item.repo) !== repoKeyStr) continue;
    if (!CANDIDATE_STATES.has(item.state)) continue;

    if (item.worktree) {
      const probe = probes.get(item.id);
      const dirty = probe?.dirty ?? null;
      const ahead = probe?.aheadOfOldBase ?? null;
      let skip: BaseChangeSkipReason | undefined;
      if (dirty === true) {
        skip = "dirty";
      } else if (dirty === false) {
        if (ahead === null || !Number.isFinite(ahead)) skip = "unresolved-base";
        else if (ahead > 0) skip = "own-commits";
      }
      // dirty === null (dir gone) falls through with no skip → discard.
      if (skip) {
        skipped.push({ id: item.id, key: item.key, reason: skip });
        continue;
      }
      discard.push({
        id: item.id,
        worktree: { path: item.worktree.path, branch: item.worktree.branch },
      });
    }

    if (shouldReplan(item)) replan.push(item.id);
  }

  return { discard, replan, skipped };
}
