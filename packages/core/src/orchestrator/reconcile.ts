import type { Issue, LifecycleState, PullRequest, TrackedItem } from "@skipper/shared";
import {
  BRANCH_ISSUE_RE,
  branchSlugMatchesKey,
  CI_FIX_MAX_ROUNDS,
  repoKey,
  resolveRepoOrchestratorSettings,
} from "@skipper/shared";
import { admitItem, applyTransition } from "./machine";
import type { OrchestratorManifest } from "./manifest";
import { canTransition } from "./states";

export interface AdmissionPolicy {
  intakePaused: boolean;
  /** #15 seam: per-repo auto-plan / follow list. Undefined = admit everything. */
  shouldAdmit?: (issue: Issue) => boolean;
}

export interface ReconcileOutcome {
  transitions: Array<{
    itemId: string;
    from: LifecycleState | null;
    to: LifecycleState;
    reason: string;
  }>;
  admitted: string[];
  parked: string[];
  conflicts: Array<{ itemId: string; detail: string }>;
}

export interface ReconcilePoll {
  mode: "full" | "delta";
  issues: Issue[];
  pullRequests: PullRequest[];
}

const PRE_CODING_STATES: readonly LifecycleState[] = ["triage", "planning", "plan-gate", "queued"];

/**
 * Maps one account's poll result onto the manifest (observe → reconcile →
 * track state). Mutates manifest.items/parked; the caller saves. Conflicting
 * platform evidence never throws — it lands in outcome.conflicts so one weird
 * item can't kill the poll loop.
 */
export function reconcile(
  manifest: OrchestratorManifest,
  accountId: string,
  poll: ReconcilePoll,
  policy: AdmissionPolicy,
  now: Date = new Date(),
): ReconcileOutcome {
  const outcome: ReconcileOutcome = { transitions: [], admitted: [], parked: [], conflicts: [] };

  const transition = (
    item: TrackedItem,
    to: LifecycleState,
    reason: string,
    resumeTo?: LifecycleState,
  ): void => {
    manifest.items[item.id] = applyTransition(item, to, "reconcile", reason, { now, resumeTo });
    outcome.transitions.push({ itemId: item.id, from: item.state, to, reason });
  };

  const admit = (issue: Issue): void => {
    const wasParked = issue.id in manifest.parked;
    let item = admitItem(issue, now);
    if (wasParked) {
      // Ex-parked issues join the resume rite (#15): held from auto-plan until
      // the user resolves the one-shot prompt — no unwanted token burst.
      item = { ...item, holdAutoPlan: true };
      manifest.resumeRite ??= { itemIds: [], createdAt: now.toISOString() };
      if (!manifest.resumeRite.itemIds.includes(item.id)) {
        manifest.resumeRite.itemIds.push(item.id);
      }
    }
    manifest.items[item.id] = item;
    delete manifest.parked[issue.id];
    outcome.admitted.push(issue.id);
    outcome.transitions.push({ itemId: issue.id, from: null, to: "triage", reason: "admitted" });
  };

  for (const issue of poll.issues) {
    const item = manifest.items[issue.id];

    if (!item) {
      if (issue.state === "closed") {
        delete manifest.parked[issue.id];
      } else if (policy.shouldAdmit?.(issue) === false) {
        // Unfollowed repo: never parked, never admitted — raw inbox only.
      } else if (policy.intakePaused) {
        manifest.parked[issue.id] ??= { firstSeenAt: now.toISOString() };
        outcome.parked.push(issue.id);
      } else {
        admit(issue);
      }
      continue;
    }

    if (issue.state === "closed") {
      if (item.state === "merged" || item.state === "closed") continue;
      if (canTransition(item.state, "closed")) {
        transition(item, "closed", "closed on GitHub");
      } else {
        outcome.conflicts.push({
          itemId: item.id,
          detail: `issue closed on GitHub while item is ${item.state}`,
        });
      }
      continue;
    }

    if (item.state === "closed") {
      transition(item, "triage", "reopened");
      continue;
    }

    if (item.title !== issue.title || item.url !== issue.url) {
      manifest.items[item.id] = {
        ...item,
        title: issue.title,
        url: issue.url,
        updatedAt: now.toISOString(),
      };
    }
  }

  reconcilePulls(manifest, accountId, poll.pullRequests, outcome, transition);

  if (poll.mode === "full") {
    reconcileFullWalkAbsence(manifest, accountId, poll, outcome, transition);
  }

  return outcome;
}

type TransitionFn = (
  item: TrackedItem,
  to: LifecycleState,
  reason: string,
  resumeTo?: LifecycleState,
) => void;

function reconcilePulls(
  manifest: OrchestratorManifest,
  accountId: string,
  pullRequests: PullRequest[],
  outcome: ReconcileOutcome,
  transition: TransitionFn,
): void {
  const items = Object.values(manifest.items).filter((i) => i.accountId === accountId);

  for (const pr of pullRequests) {
    // Match by repo + number: the list streams carry the issue-record id while
    // POST /pulls returns the pull-record id, so ids never line up across sources.
    let item = items.find(
      (i) =>
        i.pr &&
        i.pr.number === pr.number &&
        i.repo.owner === pr.repo.owner &&
        i.repo.name === pr.repo.name,
    );

    // Fallback link heuristic for externally opened PRs:
    // open PR whose head branch names a tracked issue in the same repo.
    if (!item && pr.state === "open" && pr.headRef) {
      const match = BRANCH_ISSUE_RE.exec(pr.headRef);
      if (match) {
        const candidate = items.find(
          (i) =>
            !i.pr &&
            branchSlugMatchesKey(match[1], i.key) &&
            i.repo.owner === pr.repo.owner &&
            i.repo.name === pr.repo.name,
        );
        if (candidate) {
          // Re-read: the issues pass may have replaced this item this tick.
          item = {
            ...manifest.items[candidate.id],
            pr: { id: pr.id, number: pr.number, url: pr.url },
          };
          manifest.items[item.id] = item;
        }
      }
    }

    if (!item) continue; // standalone PRs stay inbox-only

    const current = manifest.items[item.id];
    if (pr.merged) {
      if (current.state === "merged") continue;
      if (canTransition(current.state, "merged")) {
        transition(current, "merged", "PR merged");
      } else {
        outcome.conflicts.push({
          itemId: current.id,
          detail: `PR #${pr.number} merged while item is ${current.state}`,
        });
      }
    } else if (pr.state === "closed") {
      if (current.state === "needs-input") continue;
      if (canTransition(current.state, "needs-input")) {
        transition(current, "needs-input", "PR closed without merge");
      } else {
        outcome.conflicts.push({
          itemId: current.id,
          detail: `PR #${pr.number} closed without merge while item is ${current.state}`,
        });
      }
    } else {
      if (!pr.draft && current.state === "pr-open") {
        transition(current, "in-review", "PR under review");
      }
      const afterOpen = manifest.items[item.id];
      if (pr.reviewDecision === "changes-requested" && afterOpen.state === "in-review") {
        transition(afterOpen, "changes-requested", "changes requested on PR");
      }
      reconcileCi(manifest, item.id, pr, transition);
    }
  }
}

/**
 * CI-failure re-entry (round-guarded). Reacts once per pushed sha, only to the
 * agent's own push (headSha === lastPushedSha — a human's push is not ours to
 * fix), only under ciReentry:"auto". Green CI restores the round budget.
 */
function reconcileCi(
  manifest: OrchestratorManifest,
  itemId: string,
  pr: PullRequest,
  transition: TransitionFn,
): void {
  const item = manifest.items[itemId];
  const shepherd = item.shepherd;
  if (!pr.headSha || !shepherd?.lastPushedSha) return;

  if (pr.ciStatus === "passing" && (shepherd.ciFixRounds || shepherd.lastCiSha)) {
    manifest.items[itemId] = {
      ...item,
      shepherd: { ...shepherd, ciFixRounds: undefined, lastCiSha: undefined },
    };
    return;
  }

  if (pr.ciStatus !== "failing") return;
  if (pr.headSha !== shepherd.lastPushedSha) return;
  if (shepherd.lastCiSha === pr.headSha) return;
  if (item.state !== "pr-open" && item.state !== "in-review") return;
  const resolved = resolveRepoOrchestratorSettings(
    manifest.repoSettings[repoKey(item.repo)],
    manifest.settings,
  );
  if (resolved.ciReentry !== "auto") return;

  const rounds = (shepherd.ciFixRounds ?? 0) + 1;
  const guarded = {
    ...item,
    shepherd: { ...shepherd, lastCiSha: pr.headSha, ciFixRounds: rounds },
  };
  manifest.items[itemId] = guarded;
  if (rounds > CI_FIX_MAX_ROUNDS) {
    transition(
      guarded,
      "needs-input",
      `CI still failing after ${CI_FIX_MAX_ROUNDS} fix rounds`,
      "human-review",
    );
  } else {
    transition(guarded, "changes-requested", `CI failing (fix round ${rounds}/${CI_FIX_MAX_ROUNDS})`);
  }
}

// A full walk returns every open assigned issue, so a tracked item missing
// from it was closed or unassigned — indistinguishable from here. Pre-coding
// items close quietly (the reopen path recovers them); in-flight items hold
// worktrees/PRs, so they keep their state and surface a conflict for a human.
function reconcileFullWalkAbsence(
  manifest: OrchestratorManifest,
  accountId: string,
  poll: ReconcilePoll,
  outcome: ReconcileOutcome,
  transition: (item: TrackedItem, to: LifecycleState, reason: string) => void,
): void {
  const present = new Set(poll.issues.map((i) => i.id));

  for (const item of Object.values(manifest.items)) {
    if (item.accountId !== accountId || present.has(item.id)) continue;
    if (item.state === "merged" || item.state === "closed" || item.state === "failed") continue;
    if (PRE_CODING_STATES.includes(item.state)) {
      transition(item, "closed", "no longer assigned or visible");
    } else {
      outcome.conflicts.push({
        itemId: item.id,
        detail: `item is ${item.state} but its issue is no longer assigned or visible`,
      });
    }
  }

  for (const parkedId of Object.keys(manifest.parked)) {
    if (!present.has(parkedId)) delete manifest.parked[parkedId];
  }
}
