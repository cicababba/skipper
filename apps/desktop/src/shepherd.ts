// PR shepherding driver (issue #11): opens/updates the draft PR on user (or
// auto) trigger, re-enters coding on change requests with the review feedback,
// and captures the solutions-memory record after merge. Event-driven off
// manifest state via pokeShepherd(), the coder.ts loop pattern.

import {
  GitHubApiError,
  buildCommitMessage,
  buildPrBody,
  buildPrTitle,
  createPullRequest,
  fetchPullReviewComments,
  fetchPullReviews,
  findOpenPullByHead,
  mapReviewFeedback,
  writeSolutionRecord,
  type GitHubTokenProvider,
  type OrchestratorSettings,
} from "@skipper/core";
import type {
  LifecycleState,
  PrReviewComment,
  RepoRef,
  SolutionRecord,
  StoredPlan,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import { captureBranchDiff, commitWorktree, pushWorktreeBranch, removeWorktree } from "./worktrees";

export interface ShepherdDeps {
  listItems: () => TrackedItem[];
  getItem: (itemId: string) => TrackedItem | undefined;
  getSettings: () => OrchestratorSettings;
  getTokenProvider: (item: TrackedItem) => GitHubTokenProvider;
  getRepoPath: (repo: RepoRef) => string | undefined;
  /** Bare base branch name (no origin/ prefix) — the PR `base` param. */
  getBaseBranch: (item: TrackedItem) => Promise<string>;
  getPlan: (item: TrackedItem) => Promise<StoredPlan | null>;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
  ) => Promise<TrackedItem>;
  /** Single manifest write: authoritative pr link + lastPushedSha + clear pending comments + transition to pr-open. */
  completePrOpen: (
    itemId: string,
    pr: { id: string; number: number; url: string },
    pushedSha: string,
    actor: "user" | "shepherd",
    reason: string,
  ) => Promise<void>;
  /** Single manifest write: shepherd.pendingReviewComments + transition to coding. */
  completeReentry: (itemId: string, comments: PrReviewComment[], reason: string) => Promise<void>;
  /** Single manifest write: memoryRef stamp + clear worktree (no transition — merged is terminal). */
  completeMergedCleanup: (itemId: string, memoryRef: string) => Promise<void>;
  memoryDir: string;
}

let deps: ShepherdDeps | null = null;
const inFlight = new Set<string>();
let scanScheduled = false;

export function initShepherd(d: ShepherdDeps): void {
  deps = d;
  inFlight.clear();
}

/** Coalesced re-scan — fired after polls, transitions and completed reviews. */
export function pokeShepherd(): void {
  if (!deps || scanScheduled) return;
  scanScheduled = true;
  setImmediate(() => {
    scanScheduled = false;
    void scan().catch(() => {
      /* per-item errors handled in the workers */
    });
  });
}

async function scan(): Promise<void> {
  if (!deps) return;
  for (const item of deps.listItems()) {
    if (inFlight.has(item.id)) continue;
    if (item.state === "changes-requested" && item.pr) {
      void reenter(item.id);
    } else if (
      item.state === "human-review" &&
      item.pr &&
      deps.getSettings().shepherdRepush === "auto"
    ) {
      void openOrPushPr(item.id, "shepherd");
    } else if (item.state === "merged" && item.worktree && !item.shepherd?.memoryRef) {
      void captureMerged(item.id);
    }
  }
}

/**
 * User-triggered "open PR" from human-review (#14's button lands here), and the
 * repush of a fix round. With item.pr set it only pushes; otherwise it creates
 * the draft PR and writes the authoritative link.
 */
export async function openOrPushPr(
  itemId: string,
  actor: "user" | "shepherd",
): Promise<{ ok: true; item: TrackedItem } | { ok: false; error: string }> {
  if (!deps) return { ok: false, error: "shepherd not initialized" };
  if (inFlight.has(itemId)) return { ok: false, error: "operation already in progress" };
  inFlight.add(itemId);
  try {
    const item = deps.getItem(itemId);
    if (!item) return { ok: false, error: `unknown item ${itemId}` };
    if (item.state !== "human-review") {
      return { ok: false, error: `item is in "${item.state}", expected "human-review"` };
    }

    try {
      if (!item.worktree) throw new Error("no worktree recorded for item");
      if (!deps.getRepoPath(item.repo)) {
        throw new Error(`repo ${item.repo.owner}/${item.repo.name} is not linked`);
      }
      const getToken = deps.getTokenProvider(item);

      const { sha } = await commitWorktree(item.worktree.path, buildCommitMessage(item));
      if (item.pr && item.shepherd?.lastPushedSha === sha) {
        throw new Error("no new changes to push");
      }
      await pushWorktreeBranch(item.worktree.path, item.worktree.branch, await getToken());

      let pr = item.pr;
      let reason = "updates pushed to PR";
      if (!pr) {
        const stored = await deps.getPlan(item);
        const params = {
          title: buildPrTitle(item),
          body: buildPrBody({ issueNumber: item.number, plan: stored?.plan }),
          head: item.worktree.branch,
          base: await deps.getBaseBranch(item),
          draft: true,
        };
        try {
          pr = await createPullRequest(item.repo, params, getToken);
        } catch (err) {
          // 422 = a PR for this head already exists — adopt it.
          if (err instanceof GitHubApiError && err.status === 422) {
            pr = (await findOpenPullByHead(item.repo, item.worktree.branch, getToken)) ?? undefined;
          }
          if (!pr) throw err;
        }
        reason = "draft PR opened";
      }

      await deps.completePrOpen(itemId, pr, sha, actor, reason);
      return { ok: true, item: deps.getItem(itemId) ?? item };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (actor === "shepherd") {
        // Auto mode must never silently spin — park the item for the human.
        await deps
          .requestTransition(itemId, "needs-input", "shepherd", `auto repush failed: ${message}`)
          .catch(() => {});
      }
      return { ok: false, error: message };
    }
  } finally {
    inFlight.delete(itemId);
  }
}

/** Change requests → back to coding in the same worktree, with the review feedback. */
async function reenter(itemId: string): Promise<void> {
  if (!deps || inFlight.has(itemId)) return;
  inFlight.add(itemId);
  try {
    const item = deps.getItem(itemId);
    if (!item || item.state !== "changes-requested" || !item.pr) return;
    const getToken = deps.getTokenProvider(item);
    const [reviews, comments] = await Promise.all([
      fetchPullReviews(item.repo, item.pr.number, getToken),
      fetchPullReviewComments(item.repo, item.pr.number, getToken),
    ]);
    // No author filter: the connected user is usually the PR author, and their
    // inline comments on the agent's PR are exactly the feedback to address.
    let feedback = mapReviewFeedback(reviews, comments);
    if (feedback.length === 0) {
      feedback = [
        {
          body: "Changes were requested on the pull request without written comments — re-inspect the PR diff and the issue for what needs to change.",
        },
      ];
    }
    await deps.completeReentry(itemId, feedback, "PR review requested changes");
  } catch (err) {
    // Stay in changes-requested; the next poke retries.
    console.warn(`[shepherd] re-entry failed for ${itemId}: ${String(err)}`);
  } finally {
    inFlight.delete(itemId);
  }
}

/** Merged → capture problema→piano→diff→esito, then drop the worktree. */
async function captureMerged(itemId: string): Promise<void> {
  if (!deps || inFlight.has(itemId)) return;
  inFlight.add(itemId);
  try {
    const item = deps.getItem(itemId);
    if (!item || item.state !== "merged" || !item.worktree || item.shepherd?.memoryRef) return;
    if (!item.pr) {
      console.warn(`[shepherd] merged item ${itemId} has no PR link — skipping memory capture`);
      return;
    }

    let diff: string | undefined;
    let diffStats: SolutionRecord["diffStats"];
    try {
      const base = await deps.getBaseBranch(item);
      const captured = await captureBranchDiff(item.worktree.path, `origin/${base}`);
      diff = captured.diff;
      diffStats = captured.stats;
    } catch {
      // Worktree already gone or diff failed — capture the record without it.
    }

    const stored = await deps.getPlan(item).catch(() => null);
    const record: SolutionRecord = {
      version: 1,
      itemId: item.id,
      repo: item.repo,
      issueNumber: item.number,
      title: item.title,
      url: item.url,
      pr: { number: item.pr.number, url: item.pr.url },
      plan: stored ?? undefined,
      diff,
      diffStats,
      outcome: "merged",
      capturedAt: new Date().toISOString(),
    };
    const ref = await writeSolutionRecord(deps.memoryDir, record);

    const repoPath = deps.getRepoPath(item.repo);
    if (repoPath) {
      await removeWorktree(repoPath, item.worktree.path).catch(() => {
        /* already gone or busy — the record is what matters */
      });
    }
    await deps.completeMergedCleanup(itemId, ref);
  } catch (err) {
    console.warn(`[shepherd] merged capture failed for ${itemId}: ${String(err)}`);
  } finally {
    inFlight.delete(itemId);
  }
}
