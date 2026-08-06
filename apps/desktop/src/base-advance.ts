// Base advance under an in-flight item (#329): when a tracked PR merges, every
// other item on the same repo still holds a plan written against the pre-merge
// tree. The verdict half is pure — same repo, prerequisite merged, plan-cited
// files touched — and the driver half runs the git diff, the groundedness
// re-probe on a throwaway worktree at the new base, and the reaction (auto-replan
// where that is legal and non-destructive, a notice everywhere else). Never
// throws: a merge reaction must not be able to break polling.

import { join } from "node:path";
import {
  newGroundednessMisses,
  overlappingPaths,
  scoreGroundedness as realScoreGroundedness,
} from "@skipper/core";
import { canTransition, repoKey, sourceRefKey } from "@skipper/shared";
import type {
  BaseAdvanceNotice,
  GroundednessSignal,
  IssueSourceId,
  IssuePlan,
  LifecycleState,
  RepoRef,
  SourceRef,
  StoredPlan,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import { runGit } from "./git";
import type { RepoGitLock } from "./git-lock";
import { readStoredPlan } from "./plan-store";
import type { RepoLinksFile } from "./repo-links";
import {
  addDetachedWorktree,
  fetchOrigin,
  removeDetachedWorktree,
  resolveBaseRef,
} from "./worktrees";

/** replan = transition to planning; warn = a notice on the item; probe = re-run
 *  groundedness on the new base, then decide. */
export type BaseAdvanceAction = "replan" | "warn" | "probe";

export interface BaseAdvanceVerdict {
  id: string;
  key: string;
  action: BaseAdvanceAction;
  /** Why an auto-replan is off the table. Absent = replanning is legal here. */
  reason?: "in-flight" | "edited-plan";
  /** Display keys of the merges this verdict rests on. */
  mergedKeys: string[];
  overlapFiles: string[];
}

/** One merged item, reduced to what dependency matching and the notice need. */
export interface MergedItemRef {
  source: IssueSourceId;
  sourceRef: SourceRef;
  key: string;
}

export interface BaseAdvancePlanFacts {
  plan: IssuePlan;
  /** Hand-edited at the gate (editedAt/revisions) — never auto-replanned. */
  handEdited: boolean;
}

export interface BaseAdvanceEvidence {
  merged: MergedItemRef[];
  /** Paths the merges changed; empty = no textual evidence this round. */
  changedFiles: string[];
  /** itemId → plan facts. An item without an entry is not a candidate. */
  plans: Map<string, BaseAdvancePlanFacts>;
}

// triage has no plan, planning is already writing a fresh one, and pr-open and
// beyond is the code host's conflict story, not ours.
const CANDIDATE_STATES: ReadonlySet<LifecycleState> = new Set([
  "plan-gate",
  "queued",
  "coding",
  "agent-review",
  "human-review",
  "needs-input",
  "blocked",
]);

export function resolveBaseAdvanceVerdicts(
  items: TrackedItem[],
  repoKeyStr: string,
  evidence: BaseAdvanceEvidence,
): BaseAdvanceVerdict[] {
  const mergedByRef = new Map<string, string>();
  for (const m of evidence.merged) {
    mergedByRef.set(`${m.source}:${sourceRefKey(m.sourceRef)}`, m.key);
  }
  const allMergedKeys = [...new Set(evidence.merged.map((m) => m.key))];

  const verdicts: BaseAdvanceVerdict[] = [];
  for (const item of items) {
    if (repoKey(item.repo) !== repoKeyStr) continue;
    if (!CANDIDATE_STATES.has(item.state)) continue;
    const facts = evidence.plans.get(item.id);
    if (!facts) continue;

    const reason = facts.handEdited
      ? ("edited-plan" as const)
      : canTransition(item.state, "planning")
        ? undefined
        : ("in-flight" as const);
    const overlapFiles = overlappingPaths(facts.plan, evidence.changedFiles);

    const prerequisiteKeys = [
      ...new Set(
        (item.blockedBy ?? [])
          .map((ref) => mergedByRef.get(`${item.source}:${sourceRefKey(ref)}`))
          .filter((key): key is string => key !== undefined),
      ),
    ];

    // A merged prerequisite makes the plan stale by construction — it was written
    // before the work it depends on existed. File overlap is only suspicion.
    if (prerequisiteKeys.length > 0) {
      verdicts.push({
        id: item.id,
        key: item.key,
        action: reason ? "warn" : "replan",
        ...(reason ? { reason } : {}),
        mergedKeys: prerequisiteKeys,
        overlapFiles,
      });
    } else if (overlapFiles.length > 0) {
      verdicts.push({
        id: item.id,
        key: item.key,
        action: "probe",
        ...(reason ? { reason } : {}),
        mergedKeys: allMergedKeys,
        overlapFiles,
      });
    }
  }
  return verdicts;
}

interface BaseAdvanceOps {
  fetchOrigin: (repoPath: string) => Promise<void>;
  resolveBaseRef: (repoPath: string, baseBranch?: string) => Promise<string>;
  revParse: (repoPath: string, ref: string) => Promise<string>;
  /** Paths changed between two shas; [] when git can't answer. */
  diffNames: (repoPath: string, from: string, to: string) => Promise<string[]>;
  addWorktree: (repoPath: string, worktreePath: string, ref: string) => Promise<void>;
  removeWorktree: (repoPath: string, worktreePath: string) => Promise<void>;
  readPlan: (ref: string) => Promise<StoredPlan | null>;
  scoreGroundedness: (plan: IssuePlan, repoPath: string) => Promise<GroundednessSignal>;
  now: () => Date;
}

export interface BaseAdvanceDeps {
  plansDir: string;
  /** Root the throwaway probe worktree is created under. */
  worktreesDir: string;
  getItems: () => Promise<TrackedItem[]>;
  getRepoLinks: () => Promise<RepoLinksFile>;
  saveRepoLinks: (links: RepoLinksFile) => Promise<void>;
  withRepoGitLock: RepoGitLock;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
  ) => Promise<TrackedItem>;
  setBaseAdvance: (itemId: string, notice: BaseAdvanceNotice) => Promise<void>;
  /** Test seams — each op falls back to the real implementation. */
  ops?: Partial<BaseAdvanceOps>;
}

let deps: BaseAdvanceDeps | null = null;
const reacting = new Set<string>();

export function initBaseAdvance(baseAdvanceDeps: BaseAdvanceDeps): void {
  deps = baseAdvanceDeps;
  reacting.clear();
}

async function defaultRevParse(repoPath: string, ref: string): Promise<string> {
  const r = await runGit(repoPath, ["rev-parse", ref]);
  if (r.code !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return r.stdout.trim();
}

async function defaultDiffNames(repoPath: string, from: string, to: string): Promise<string[]> {
  const r = await runGit(repoPath, ["diff", "--name-only", from, to]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean);
}

function resolveOps(d: BaseAdvanceDeps): BaseAdvanceOps {
  return {
    fetchOrigin: d.ops?.fetchOrigin ?? ((repoPath) => fetchOrigin(repoPath)),
    resolveBaseRef:
      d.ops?.resolveBaseRef ?? ((repoPath, baseBranch) => resolveBaseRef(repoPath, baseBranch)),
    revParse: d.ops?.revParse ?? defaultRevParse,
    diffNames: d.ops?.diffNames ?? defaultDiffNames,
    addWorktree: d.ops?.addWorktree ?? addDetachedWorktree,
    removeWorktree: d.ops?.removeWorktree ?? removeDetachedWorktree,
    readPlan: d.ops?.readPlan ?? ((ref) => readStoredPlan(d.plansDir, ref)),
    scoreGroundedness: d.ops?.scoreGroundedness ?? realScoreGroundedness,
    now: d.ops?.now ?? (() => new Date()),
  };
}

function probeWorktreePath(worktreesDir: string, repo: RepoRef): string {
  const sanitize = (component: string): string => component.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(worktreesDir, "_base-advance", `${sanitize(repo.owner)}-${sanitize(repo.name)}`);
}

/** Fire-and-forget reaction to merges observed in one poll, grouped per repo. */
export async function reactToMerges(mergedItemIds: string[]): Promise<void> {
  if (!deps || mergedItemIds.length === 0) return;
  try {
    const items = await deps.getItems();
    const merged = new Set(mergedItemIds);
    const repoKeys = new Set(items.filter((i) => merged.has(i.id)).map((i) => repoKey(i.repo)));
    for (const key of repoKeys) {
      await reactToMergedItems(key, mergedItemIds);
    }
  } catch (err) {
    console.warn(`[base-advance] reaction failed: ${String(err)}`);
  }
}

/** The per-repo reaction: git evidence, verdicts, probes, then transitions/notices. */
export async function reactToMergedItems(
  repoKeyStr: string,
  mergedItemIds: string[],
): Promise<void> {
  if (!deps || reacting.has(repoKeyStr)) return;
  const d = deps;
  const ops = resolveOps(d);
  reacting.add(repoKeyStr);
  try {
    const items = await d.getItems();
    const mergedIds = new Set(mergedItemIds);
    const mergedItems = items.filter((i) => mergedIds.has(i.id) && repoKey(i.repo) === repoKeyStr);
    if (mergedItems.length === 0) return;
    const repo = mergedItems[0].repo;

    const links = await d.getRepoLinks();
    const link = links.repos[repoKeyStr];
    if (!link) return;

    // Plan facts for every candidate, read before the lock — the stored plan is
    // also where the previous groundedness report lives.
    const stored = new Map<string, StoredPlan>();
    const plans = new Map<string, BaseAdvancePlanFacts>();
    for (const item of items) {
      if (mergedIds.has(item.id) || repoKey(item.repo) !== repoKeyStr) continue;
      const ref = item.plan?.ref;
      if (!ref) continue;
      const plan = await ops.readPlan(ref).catch(() => null);
      if (!plan) continue;
      stored.set(item.id, plan);
      plans.set(item.id, {
        plan: plan.plan,
        handEdited: Boolean(plan.editedAt || plan.revisions?.length),
      });
    }

    const probePath = probeWorktreePath(d.worktreesDir, repo);
    const git = await d.withRepoGitLock(repo, async () => {
      try {
        await ops.fetchOrigin(link.localPath);
      } catch {
        /* offline — reason about whatever refs are already local */
      }
      const baseRef = await ops.resolveBaseRef(link.localPath, link.baseBranch);
      const newSha = await ops.revParse(link.localPath, baseRef);
      const changedFiles =
        link.baseSha && link.baseSha !== newSha
          ? await ops.diffNames(link.localPath, link.baseSha, newSha)
          : [];

      const verdicts = resolveBaseAdvanceVerdicts(items, repoKeyStr, {
        merged: mergedItems.map((i) => ({ source: i.source, sourceRef: i.sourceRef, key: i.key })),
        changedFiles,
        plans,
      });

      let probeReady = false;
      if (verdicts.some((v) => v.action === "probe")) {
        try {
          await ops.addWorktree(link.localPath, probePath, newSha);
          probeReady = true;
        } catch (err) {
          console.warn(`[base-advance] probe worktree failed for ${repoKeyStr}: ${String(err)}`);
        }
      }
      return { newSha, verdicts, probeReady };
    });

    await stampBaseSha(repoKeyStr, git.newSha);

    try {
      for (const verdict of git.verdicts) {
        // No probe tree (git failed) degrades the probe to a plain warning.
        const action =
          verdict.action === "probe" && !git.probeReady ? ("warn" as const) : verdict.action;
        await applyVerdict(verdict, {
          action,
          probePath,
          stored: stored.get(verdict.id),
          now: ops.now,
          scoreGroundednessAt: ops.scoreGroundedness,
        });
      }
    } finally {
      if (git.probeReady) {
        await d
          .withRepoGitLock(repo, () => ops.removeWorktree(link.localPath, probePath))
          .catch((err) =>
            console.warn(`[base-advance] probe cleanup failed for ${probePath}: ${String(err)}`),
          );
      }
    }
  } catch (err) {
    console.warn(`[base-advance] reaction skipped for ${repoKeyStr}: ${String(err)}`);
  } finally {
    reacting.delete(repoKeyStr);
  }
}

/** Advances the link's observed base sha, re-reading so a concurrent link write wins. */
async function stampBaseSha(repoKeyStr: string, newSha: string): Promise<void> {
  const d = deps!;
  try {
    const links = await d.getRepoLinks();
    const link = links.repos[repoKeyStr];
    if (!link || link.baseSha === newSha) return;
    link.baseSha = newSha;
    await d.saveRepoLinks(links);
  } catch (err) {
    console.warn(`[base-advance] baseSha stamp failed for ${repoKeyStr}: ${String(err)}`);
  }
}

async function applyVerdict(
  verdict: BaseAdvanceVerdict,
  ctx: {
    action: BaseAdvanceAction;
    probePath: string;
    stored: StoredPlan | undefined;
    now: () => Date;
    scoreGroundednessAt: BaseAdvanceOps["scoreGroundedness"];
  },
): Promise<void> {
  const d = deps!;
  try {
    let action = ctx.action;
    let newMisses: BaseAdvanceNotice["newMisses"] | undefined;

    if (action === "probe") {
      const plan = ctx.stored?.plan;
      if (!plan) return;
      const fresh = await ctx.scoreGroundednessAt(plan, ctx.probePath);
      const misses = newGroundednessMisses(ctx.stored?.confidence?.signals.groundedness, fresh);
      if (misses.files.length > 0 || misses.symbols.length > 0) {
        newMisses = misses;
        action = verdict.reason ? "warn" : "replan";
      } else {
        action = "warn";
      }
    }

    if (action === "replan") {
      await d.requestTransition(
        verdict.id,
        "planning",
        "reconcile",
        `${verdict.mergedKeys.join(", ")} merged — replanning on the new base`,
      );
      return;
    }
    await d.setBaseAdvance(verdict.id, {
      at: ctx.now().toISOString(),
      mergedKeys: verdict.mergedKeys,
      overlapFiles: verdict.overlapFiles,
      ...(newMisses ? { newMisses } : {}),
      reason: verdict.reason ?? "overlap",
    });
  } catch (err) {
    console.warn(`[base-advance] ${verdict.key} reaction failed: ${String(err)}`);
  }
}
