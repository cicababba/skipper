import type { Issue, LifecycleState, PullRequest, SourceRef, TrackedItem } from "@skipper/shared";
import {
  BRANCH_ISSUE_RE,
  branchSlugMatchesKey,
  CI_FIX_MAX_ROUNDS,
  repoKey,
  resolveRepoOrchestratorSettings,
  sourceRefKey,
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
  /** Fresh dependency evidence keyed by work-item id (#85). A present key is an
   *  authoritative snapshot (empty array clears); an absent key means no fresh
   *  evidence — the stored blockedBy stands. */
  dependencies?: Record<string, SourceRef[]>;
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
      } else if (!issue.repo || policy.shouldAdmit?.(issue) === false) {
        // Repo-less (unmapped project, #79) or unfollowed repo: never parked,
        // never admitted — raw inbox only. Parking a repo-less issue would be a
        // time bomb, since the resume rite would later try to admit it.
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

    if (item.title !== issue.title || item.url !== issue.url || item.body !== issue.body) {
      manifest.items[item.id] = {
        ...item,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        updatedAt: now.toISOString(),
      };
    }
  }

  reconcilePulls(manifest, accountId, poll.pullRequests, outcome, transition);

  if (poll.mode === "full") {
    reconcileFullWalkAbsence(manifest, accountId, poll, outcome, transition);
  }

  // Last: a prerequisite merged/closed/evicted above already reads its new state
  // this tick, so dependents park or release in the same round.
  reconcileDependencies(manifest, accountId, poll, transition, now);

  return outcome;
}

const DEP_PARK_STATES: readonly LifecycleState[] = ["triage", "plan-gate", "queued"];
const DEP_RESOLVED_STATES: readonly LifecycleState[] = ["merged", "closed"];

/** Merge two ref lists, deduped by sourceRefKey. */
function mergeByKey(a: SourceRef[] | undefined, b: SourceRef[]): SourceRef[] {
  const out = [...(a ?? [])];
  const seen = new Set(out.map(sourceRefKey));
  for (const ref of b) {
    const key = sourceRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** "#42" when the ref's project matches the item's (case-insensitive), else "owner/repo#42". */
function displayRef(ref: SourceRef, item: TrackedItem): string {
  return ref.project.toLowerCase() === item.sourceRef.project.toLowerCase()
    ? `#${ref.key}`
    : `${ref.project}#${ref.key}`;
}

/**
 * Issue dependencies (#85). Applies fresh adapter evidence to blockedBy, then
 * parks items with unmet prerequisites (only from resting states) and releases
 * blocked items whose prerequisites are all merged/closed or gone. A ref only
 * blocks if it resolves to a tracked item that isn't merged/closed — Skipper
 * can't observe an untracked issue's merge, so untracked refs are ignored.
 *
 * Cycles (A⇄B): both park; the single-pass sweep terminates; a user resume +
 * waiver breaks the tie. Not detected by design.
 */
function reconcileDependencies(
  manifest: OrchestratorManifest,
  accountId: string,
  poll: ReconcilePoll,
  transition: TransitionFn,
  now: Date = new Date(),
): void {
  // 1. Apply fresh evidence (any state). A present key is authoritative.
  for (const [itemId, deps] of Object.entries(poll.dependencies ?? {})) {
    const item = manifest.items[itemId];
    if (!item) continue; // parked/unknown ids drop
    const before = (item.blockedBy ?? []).map(sourceRefKey).join("|");
    const after = deps.map(sourceRefKey).join("|");
    if (before !== after) {
      manifest.items[itemId] = {
        ...item,
        blockedBy: deps.length ? deps : undefined,
        updatedAt: now.toISOString(),
      };
    }
  }

  // 2. Resolution index over ALL manifest items (account-agnostic — a prerequisite
  //    may be tracked under another account of the same tracker).
  const index = new Map<string, LifecycleState>();
  for (const item of Object.values(manifest.items)) {
    index.set(`${item.source}:${sourceRefKey(item.sourceRef)}`, item.state);
  }

  // Mirrors blockingItemsFor in apps/web/src/lib/inbox/blocked.ts — keep in lockstep.
  const unmet = (item: TrackedItem): SourceRef[] => {
    const selfKey = sourceRefKey(item.sourceRef);
    const waived = new Set((item.blockedByWaived ?? []).map(sourceRefKey));
    return (item.blockedBy ?? []).filter((ref) => {
      const key = sourceRefKey(ref);
      if (key === selfKey || waived.has(key)) return false;
      const state = index.get(`${item.source}:${key}`);
      return state !== undefined && !DEP_RESOLVED_STATES.includes(state);
    });
  };

  // 3. Sweep this account's items.
  for (const item of Object.values(manifest.items)) {
    if (item.accountId !== accountId) continue;
    const blocking = unmet(item);

    if (blocking.length && DEP_PARK_STATES.includes(item.state)) {
      const last = item.transitions.at(-1);
      if (last?.from === "blocked" && last.actor === "user") {
        // Manual resume is the override — waive the current unmet set instead of
        // re-parking. A newly appearing dep still blocks (it isn't waived yet).
        manifest.items[item.id] = {
          ...item,
          blockedByWaived: mergeByKey(item.blockedByWaived, blocking),
        };
      } else if (canTransition(item.state, "blocked")) {
        transition(
          item,
          "blocked",
          `blocked by ${blocking.map((r) => displayRef(r, item)).join(", ")}`,
          item.state,
        );
      }
    } else if (item.state === "blocked" && blocking.length === 0) {
      // Release only blocks reconcile created (last transition into blocked was
      // reconcile-actored with a "blocked by" reason).
      const into = [...item.transitions].reverse().find((t) => t.to === "blocked");
      if (into?.actor === "reconcile" && into.reason?.startsWith("blocked by")) {
        const to =
          item.resumeTo && canTransition("blocked", item.resumeTo) ? item.resumeTo : "triage";
        transition(item, to, "prerequisites merged/closed");
      }
    }
  }
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
