import type { IpcMain } from "electron";
import {
  applyTransition,
  codeHostFor,
  issueSourceForAuthProvider,
  IssuePlanSchema,
  type OrchestratorManifest,
} from "@skipper/core";
import { repoKey } from "@skipper/shared";
import type {
  Account,
  ArchiveItemResult,
  CleanWorktreeResult,
  CloseItemOnTrackerResult,
  CodeHostId,
  Issue,
  PullRequest,
  LifecycleState,
  OrchestratorState,
  ResumeRiteAction,
  TrackedItem,
  TransitionActor,
  UntrackItemResult,
} from "@skipper/shared";
import type { RepoLinksFile } from "./repo-links";
import type { RepoGitLock } from "./git-lock";
import { archivePlanAndDeleteChats, discardItemWorktreeUnderLock } from "./item-teardown";
import { readStoredPlan, updateStoredPlan } from "./plan-store";
import { readStoredCoderReport } from "./report-store";
import { cancelRescore } from "./rescore";
import { cancelPlanningRun } from "./planner";
import { cancelCodingRun } from "./coder";
import { openOrPushPr } from "./shepherd";
import {
  fetchOrigin,
  forceCleanWorktree,
  resolveBaseRef,
  worktreeDirtyFiles,
} from "./worktrees";

// Per-item lifecycle IPC: transitions, plan/report reads, pin, archive, untrack,
// worktree cleanup, close-on-tracker, PR open and the resume rite. Orchestrator
// state is injected; the run cancellers and the git/fs helpers are direct imports.
export interface ItemIpcDeps {
  ipcMain: IpcMain;
  plansDir: string;
  ensureManifest: () => Promise<OrchestratorManifest>;
  saveManifest: (m: OrchestratorManifest) => Promise<void>;
  ensureRepoLinks: () => Promise<RepoLinksFile>;
  snapshot: () => OrchestratorState;
  broadcast: () => void;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
  ) => Promise<TrackedItem>;
  pokePlanner: () => void;
  pokeCoder: () => void;
  reconcileFromCache: () => Promise<void>;
  withRepoGitLock: RepoGitLock;
  getAccounts: () => Account[];
  getToken: (accountKey: string, forceRefresh?: boolean) => Promise<string | null>;
  /** The connected account that authenticates a code host for this item. */
  codeHostAccountFor: (codeHost: CodeHostId, preferKey?: string) => Account | undefined;
  getCached: (accountId: string, itemId: string) => Issue | PullRequest | undefined;
  dropCached: (accountId: string, itemId: string) => void;
  markCachedIssueClosed: (accountId: string, itemId: string) => void;
}

/** Minimal Issue rebuilt from a TrackedItem for a close call when the raw poll
 *  cache lacks it (#132) — carries every field closeGitHubIssue/closeGitLabIssue
 *  read; required-unused fields get inert defaults. */
function synthesizeIssue(item: TrackedItem): Issue {
  return {
    kind: "issue",
    id: item.id,
    source: item.source,
    sourceRef: item.sourceRef,
    codeHost: item.codeHost,
    accountId: item.accountId,
    repo: item.repo,
    key: item.key,
    number: item.number,
    title: item.title,
    body: item.body,
    labels: [],
    assignees: [],
    url: item.url,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    state: "open",
  };
}

/**
 * Resolves the one-shot resume-rite prompt (#15). Selected items move to
 * planning; the rest keep holdAutoPlan and stay in triage for manual planning.
 * Any resolution — including dismiss — clears the rite.
 */
async function resolveResumeRite(
  deps: ItemIpcDeps,
  action: ResumeRiteAction,
  itemIds?: string[],
): Promise<void> {
  const m = await deps.ensureManifest();
  if (!m.resumeRite) return;
  const rite = m.resumeRite.itemIds;
  const selected =
    action === "plan-all"
      ? rite
      : action === "plan-selected"
        ? (itemIds ?? []).filter((id) => rite.includes(id))
        : [];
  for (const id of selected) {
    const item = m.items[id];
    if (!item || item.state !== "triage") continue; // closed/moved meanwhile — skip
    m.items[id] = applyTransition(
      { ...item, holdAutoPlan: undefined },
      "planning",
      "user",
      "resume rite",
    );
  }
  delete m.resumeRite;
  await deps.saveManifest(m);
  deps.broadcast();
  deps.pokePlanner();
}

export function registerItemHandlers(deps: ItemIpcDeps): void {
  deps.ipcMain.handle(
    "skipper:orchestrator:requestTransition",
    async (_e, itemId: string, to: LifecycleState, reason?: string) => {
      try {
        const item = await deps.requestTransition(itemId, to, "user", reason);
        return { ok: true as const, item };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:resolveResumeRite",
    async (_e, action: ResumeRiteAction, itemIds?: string[]) => {
      await resolveResumeRite(deps, action, itemIds);
      return deps.snapshot();
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:setPinned",
    async (_e, itemId: string, pinned: boolean) => {
      const m = await deps.ensureManifest();
      const item = m.items[itemId];
      if (!item) return { ok: false as const, error: `unknown item ${itemId}` };
      m.items[itemId] = {
        ...item,
        pinned: pinned ? true : undefined,
        updatedAt: new Date().toISOString(),
      };
      await deps.saveManifest(m);
      deps.broadcast();
      deps.pokeCoder();
      return { ok: true as const, item: m.items[itemId] };
    },
  );
  deps.ipcMain.handle("skipper:orchestrator:getPlan", async (_e, itemId: string) => {
    const m = await deps.ensureManifest();
    const ref = m.items[itemId]?.plan?.ref;
    if (!ref) return null;
    return readStoredPlan(deps.plansDir, ref);
  });
  deps.ipcMain.handle("skipper:orchestrator:getCoderReport", async (_e, itemId: string) => {
    const m = await deps.ensureManifest();
    const ref = m.items[itemId]?.coderReport?.ref;
    if (!ref) return null;
    return readStoredCoderReport(deps.plansDir, ref);
  });
  // Persist a user-edited plan at the gate (#13). Only legal while the item sits
  // in plan-gate — during a replan the item is back in planning, so stale saves lose.
  deps.ipcMain.handle(
    "skipper:orchestrator:updatePlan",
    async (_e, itemId: string, plan: unknown) => {
      const m = await deps.ensureManifest();
      const item = m.items[itemId];
      if (!item) return { ok: false as const, error: `unknown item ${itemId}` };
      if (item.state !== "plan-gate") {
        return {
          ok: false as const,
          error: `plan is only editable in plan-gate (item is ${item.state})`,
        };
      }
      const ref = item.plan?.ref;
      if (!ref) return { ok: false as const, error: "item has no stored plan" };
      const parsed = IssuePlanSchema.safeParse(plan);
      if (!parsed.success) {
        return {
          ok: false as const,
          error: `invalid plan: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
        };
      }
      const stored = await updateStoredPlan(deps.plansDir, ref, parsed.data, "inline-edit");
      if (!stored) return { ok: false as const, error: "stored plan not found" };
      // An inline edit supersedes the plan an in-flight rescore was scoring (#164):
      // cancel it so the stale score stands rather than landing on the edited plan.
      cancelRescore(itemId);
      return { ok: true as const, stored };
    },
  );
  // Open the draft PR from human-review, or push a fix round's updates (#11).
  deps.ipcMain.handle("skipper:orchestrator:openPr", async (_e, itemId: string) => {
    await deps.ensureManifest();
    await deps.ensureRepoLinks();
    return openOrPushPr(itemId, "user");
  });
  // Manual end-of-flow cleanup (#115): archive a closed item — discard its
  // worktree (conservative branch delete) and archive the plan. The dirty gate
  // needs the caller's confirmation before destroying uncommitted work.
  deps.ipcMain.handle(
    "skipper:orchestrator:archiveItem",
    async (_e, itemId: string, force?: boolean): Promise<ArchiveItemResult> => {
      const m = await deps.ensureManifest();
      const links = await deps.ensureRepoLinks();
      const item = m.items[itemId];
      if (!item) return { ok: false, error: `unknown item ${itemId}` };
      if (item.state !== "closed") {
        return { ok: false, error: "only closed items can be archived" };
      }

      if (item.worktree) {
        const dirty = await worktreeDirtyFiles(item.worktree.path);
        if (dirty && dirty.length > 0 && !force) {
          return { ok: false, needsConfirm: true, dirtyFiles: dirty.length };
        }
        const link = links.repos[repoKey(item.repo)];
        if (link) {
          const res = await discardItemWorktreeUnderLock({
            repo: item.repo,
            localPath: link.localPath,
            baseBranch: link.baseBranch,
            worktreePath: item.worktree.path,
            branch: item.worktree.branch,
            withRepoGitLock: deps.withRepoGitLock,
          });
          if (!res.ok) return res;
        }
      }

      const plan = await archivePlanAndDeleteChats(deps.plansDir, itemId, item.plan);

      // Re-read after the slow git ops so a concurrent update is not clobbered.
      const current = m.items[itemId] ?? item;
      const archived: TrackedItem = {
        ...current,
        worktree: undefined,
        plan,
        updatedAt: new Date().toISOString(),
      };
      m.items[itemId] = archived;
      await deps.saveManifest(m);
      deps.broadcast();
      return { ok: true, item: archived };
    },
  );
  // Manifest cleanup (#120): untrack an item — drop it from the manifest and the
  // raw cache (so reconcileFromCache can't instantly resurrect it) and prune its
  // worktree. A later real poll/full-walk may re-admit it (no ignore list). The
  // worktree/PR gate needs confirmation before destroying uncommitted work.
  deps.ipcMain.handle(
    "skipper:orchestrator:untrackItem",
    async (_e, itemId: string, force?: boolean): Promise<UntrackItemResult> => {
      const m = await deps.ensureManifest();
      const links = await deps.ensureRepoLinks();
      const item = m.items[itemId];
      if (!item) return { ok: false, error: `unknown item ${itemId}` };

      if ((item.worktree || item.pr) && !force) {
        const dirty = item.worktree ? await worktreeDirtyFiles(item.worktree.path) : null;
        return {
          ok: false,
          needsConfirm: true,
          hasWorktree: !!item.worktree,
          dirtyFiles: dirty?.length ?? 0,
          hasPr: !!item.pr,
        };
      }

      if (item.state === "coding") cancelCodingRun(itemId);
      if (item.state === "planning") cancelPlanningRun(itemId);
      cancelRescore(itemId);

      if (item.worktree) {
        const link = links.repos[repoKey(item.repo)];
        if (link) {
          const res = await discardItemWorktreeUnderLock({
            repo: item.repo,
            localPath: link.localPath,
            baseBranch: link.baseBranch,
            worktreePath: item.worktree.path,
            branch: item.worktree.branch,
            withRepoGitLock: deps.withRepoGitLock,
          });
          if (!res.ok) return res;
        }
      }

      await archivePlanAndDeleteChats(deps.plansDir, itemId, item.plan);

      delete m.items[itemId];
      delete m.parked[itemId];
      if (m.resumeRite) {
        m.resumeRite.itemIds = m.resumeRite.itemIds.filter((id) => id !== itemId);
        if (m.resumeRite.itemIds.length === 0) delete m.resumeRite;
      }

      // Drop from the raw cache so reconcileFromCache (mapping change, link/clone,
      // re-follow) doesn't instantly re-admit it.
      deps.dropCached(item.accountId, itemId);

      await deps.saveManifest(m);
      deps.broadcast();
      return { ok: true };
    },
  );
  // Dirty-worktree cleanup (#204): reset the item's worktree to its base ref and
  // clean untracked files — discards leftover uncommitted work AND local commits;
  // worktree + branch survive. Never automatic: the renderer confirms with the
  // file list first. Refuses while an agent run holds the worktree.
  deps.ipcMain.handle(
    "skipper:orchestrator:cleanWorktree",
    async (_e, itemId: string): Promise<CleanWorktreeResult> => {
      const m = await deps.ensureManifest();
      const links = await deps.ensureRepoLinks();
      const item = m.items[itemId];
      if (!item) return { ok: false, error: `unknown item ${itemId}` };
      if (!item.worktree) return { ok: false, error: "no worktree recorded for item" };
      if (item.state === "coding" || item.state === "planning") {
        return { ok: false, error: "a run is active in this worktree" };
      }
      const link = links.repos[repoKey(item.repo)];
      if (!link) {
        return { ok: false, error: `repo ${item.repo.owner}/${item.repo.name} is not linked` };
      }
      const worktree = item.worktree;
      try {
        return await deps.withRepoGitLock(item.repo, async () => {
          const dirty = await worktreeDirtyFiles(worktree.path);
          if (dirty === null) return { ok: false, error: "worktree folder is missing on disk" };
          const account = deps.codeHostAccountFor(item.codeHost, item.accountId);
          const token = account ? await deps.getToken(account.key) : null;
          const creds = token ? codeHostFor(item.codeHost).pushCredentials(token) : undefined;
          await fetchOrigin(link.localPath, creds).catch(() => {});
          const baseRef = await resolveBaseRef(link.localPath, link.baseBranch);
          await forceCleanWorktree(worktree.path, baseRef);
          return { ok: true };
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  // Close-on-tracker (#132): close the issue on its tracker via the source's
  // closeIssue capability, then settle the item locally through reconcile's
  // existing "closed on GitHub" path (zero extra network). Adapter errors (e.g. a
  // 403 when the GitHub App lacks Issues: write) surface via the {ok:false} path.
  deps.ipcMain.handle(
    "skipper:orchestrator:closeItemOnTracker",
    async (_e, itemId: string): Promise<CloseItemOnTrackerResult> => {
      const m = await deps.ensureManifest();
      const item = m.items[itemId];
      if (!item) return { ok: false, error: `unknown item ${itemId}` };

      const account = deps.getAccounts().find((a) => a.key === item.accountId);
      const source = account ? issueSourceForAuthProvider(account.provider) : undefined;
      if (!account || !source?.closeIssue) {
        return { ok: false, error: `closing on the tracker is not supported for ${item.source}` };
      }

      const cached = deps.getCached(item.accountId, item.id);
      const issue = cached?.kind === "issue" ? cached : synthesizeIssue(item);
      try {
        await source.closeIssue(
          issue,
          (force) => deps.getToken(account.key, force),
          account.baseUrl,
        );
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (cached?.kind === "issue") deps.markCachedIssueClosed(item.accountId, item.id);
      await deps.reconcileFromCache();
      return { ok: true };
    },
  );
}
