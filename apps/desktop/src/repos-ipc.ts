import type { IpcMain } from "electron";
import { codeHostFor, codeHostForProvider, type OrchestratorManifest } from "@skipper/core";
import {
  parseRepoPath,
  repoKey,
  resolveRepoIntakeSettings,
  resolveRepoOrchestratorSettings,
} from "@skipper/shared";
import type {
  Account,
  LifecycleState,
  ListRepoBranchesResult,
  OrchestratorState,
  RepoIntakeSettings,
  RepoRef,
  RepoSettingsRow,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import { runGit } from "./git";
import {
  branchesForLocalClone,
  cloneRepo,
  detectHostForLocalPath,
  listRemoteHeads,
  type RepoLinksFile,
} from "./repo-links";
import { resolveBaseChangeActions, type WorktreeProbe } from "./base-change";
import type { RepoGitLock } from "./git-lock";
import { applyRepoSettingsPatch } from "./settings-validators";
import { guardFollowedPatch, markRepoFollowed } from "./repo-follow";
import { discardWorktree, fetchOrigin, resolveBaseRef, worktreeDirtyFiles } from "./worktrees";

// Repo linking, cloning, base-branch and per-repo settings (#15, #62, #120).
// Deps are injected so the handlers are testable without a live Electron main;
// the impure git/fs helpers stay direct imports and are stubbed with vi.mock.
export interface ReposIpcDeps {
  ipcMain: IpcMain;
  ensureManifest: () => Promise<OrchestratorManifest>;
  saveManifest: (m: OrchestratorManifest) => Promise<void>;
  ensureRepoLinks: () => Promise<RepoLinksFile>;
  saveLinks: (links: RepoLinksFile) => Promise<void>;
  getAccounts: () => Account[];
  getToken: (accountKey: string, forceRefresh?: boolean) => Promise<string | null>;
  snapshot: () => OrchestratorState;
  broadcast: () => void;
  reconcileFromCache: () => Promise<void>;
  pokePlanner: () => void;
  pokeCoder: () => void;
  withRepoGitLock: RepoGitLock;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
  ) => Promise<TrackedItem>;
  seedInstructions: (repo: RepoRef, localPath: string, force?: boolean) => Promise<void>;
  kickGraphify: (repo: RepoRef) => void;
  accountForRepo: (owner: string, name: string, accountKey?: string) => Account | undefined;
  /** Every repo the poller has seen, in cache order. */
  cachedRepos: () => Iterable<RepoRef>;
  /** The global default agent model, for the resolved per-repo settings rows. */
  getDefaultModel: () => string | undefined;
}

async function revParseOrNull(repoPath: string, ref: string): Promise<string | null> {
  const r = await runGit(repoPath, ["rev-parse", ref]).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() || null : null;
}

/**
 * The base sha as Skipper sees the clone right now (#329). Stamped when a repo is
 * linked so the very first merge on it already has a left side to diff from;
 * best-effort, an unresolvable base just leaves baseSha absent.
 */
async function observedBaseSha(
  localPath: string,
  baseBranch?: string,
): Promise<string | undefined> {
  const ref = await resolveBaseRef(localPath, baseBranch).catch(() => null);
  return (ref ? await revParseOrNull(localPath, ref) : null) ?? undefined;
}

export function registerReposHandlers(deps: ReposIpcDeps): void {
  deps.ipcMain.handle(
    "skipper:orchestrator:setRepoSettings",
    async (_e, owner: string, name: string, patch: Partial<RepoIntakeSettings>) => {
      const m = await deps.ensureManifest();
      const key = repoKey({ owner, name });
      const followedBefore = resolveRepoIntakeSettings(m.repoSettings[key]).followed;
      const graphifyBefore = resolveRepoIntakeSettings(m.repoSettings[key]).graphify;
      // Generic patch endpoint — it must not become a way around the unfollow
      // guard; the user-facing refusal belongs to setRepoFollowed.
      const merged = guardFollowedPatch(m, key, applyRepoSettingsPatch(m.repoSettings[key], patch));
      if (Object.keys(merged).length === 0) delete m.repoSettings[key];
      else m.repoSettings[key] = merged;
      await deps.saveManifest(m);
      // Turned on: kick a first index so the graph is ready before the next plan (#233).
      if (!graphifyBefore && resolveRepoIntakeSettings(m.repoSettings[key]).graphify) {
        deps.kickGraphify({ owner, name });
      }
      if (!followedBefore && resolveRepoIntakeSettings(m.repoSettings[key]).followed) {
        // Re-followed: cached issues admit retroactively, like a fresh repo link.
        await deps.reconcileFromCache();
      } else {
        deps.broadcast();
        deps.pokePlanner();
        deps.pokeCoder();
      }
      return deps.snapshot();
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:listRepoSettings",
    async (): Promise<RepoSettingsRow[]> => {
      const m = await deps.ensureManifest();
      const links = await deps.ensureRepoLinks();
      const repos = new Map<string, RepoRef>();
      const put = (key: string, repo: RepoRef): void => {
        if (!repos.has(key)) repos.set(key, repo);
      };
      // Poll cache + tracked items carry proper-case RepoRefs; keys reconstructed
      // from links/settings fall back to the lowercased form.
      for (const repo of deps.cachedRepos()) {
        put(repoKey(repo), repo);
      }
      for (const item of Object.values(m.items)) {
        put(repoKey(item.repo), item.repo);
      }
      for (const key of [...Object.keys(links.repos), ...Object.keys(m.repoSettings)]) {
        const [owner, name] = key.split("/");
        if (owner && name) put(key, { owner, name });
      }
      const defaultModel = deps.getDefaultModel();
      return [...repos.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, repo]) => ({
          key,
          repo,
          linked: Boolean(links.repos[key]),
          localPath: links.repos[key]?.localPath,
          settings: m.repoSettings[key] ?? {},
          resolved: resolveRepoOrchestratorSettings(m.repoSettings[key], m.settings, defaultModel),
        }));
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:linkRepo",
    async (_e, owner: string, name: string, localPath: string, baseBranch?: string) => {
      try {
        await detectHostForLocalPath(deps.getAccounts(), owner, name, localPath);
        const trimmed = baseBranch?.trim();
        if (trimmed) {
          const onOrigin = async (): Promise<boolean> =>
            (await runGit(localPath, ["rev-parse", "--verify", "--quiet", `origin/${trimmed}`]))
              .code === 0;
          if (!(await onOrigin())) {
            await fetchOrigin(localPath).catch(() => {});
            if (!(await onOrigin())) {
              return { ok: false as const, error: `branch '${trimmed}' not found on origin` };
            }
          }
        }
        const links = await deps.ensureRepoLinks();
        const baseSha = await observedBaseSha(localPath, trimmed);
        links.repos[repoKey({ owner, name })] = {
          localPath,
          linkedAt: new Date().toISOString(),
          ...(trimmed ? { baseBranch: trimmed } : {}),
          ...(baseSha ? { baseSha } : {}),
        };
        await deps.saveLinks(links);
        // Linking is a stronger act of intent than ticking the follow box (#15) —
        // persist it before the reconcile so the cached issues admit in that pass.
        const m = await deps.ensureManifest();
        markRepoFollowed(m, { owner, name });
        await deps.saveManifest(m);
        // Seed before reconcile so an admitted triage item hits the gate while a
        // generation is in flight (#227); seeding failure never fails the link.
        await deps.seedInstructions({ owner, name }, localPath).catch(() => {});
        await deps.reconcileFromCache();
        return { ok: true as const, localPath };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:cloneRepo",
    async (
      _e,
      owner: string,
      name: string,
      destParent: string,
      accountId?: string,
      baseBranch?: string,
    ) => {
      try {
        const account = deps.accountForRepo(owner, name, accountId);
        const token = account ? await deps.getToken(account.key) : null;
        if (!token) throw new Error("no account token available for this repo");
        const hostId = account ? (codeHostForProvider(account.provider) ?? "github") : "github";
        const host = codeHostFor(hostId);
        const localPath = await cloneRepo(
          host,
          { owner, name },
          destParent,
          host.pushCredentials(token),
          account?.baseUrl,
        );
        // Fresh full clone carries every remote branch — one rev-parse settles it.
        const trimmed = baseBranch?.trim();
        if (trimmed) {
          const onOrigin =
            (await runGit(localPath, ["rev-parse", "--verify", "--quiet", `origin/${trimmed}`]))
              .code === 0;
          if (!onOrigin) {
            return { ok: false as const, error: `branch '${trimmed}' not found on origin` };
          }
        }
        const links = await deps.ensureRepoLinks();
        const baseSha = await observedBaseSha(localPath, trimmed);
        links.repos[repoKey({ owner, name })] = {
          localPath,
          linkedAt: new Date().toISOString(),
          ...(trimmed ? { baseBranch: trimmed } : {}),
          ...(baseSha ? { baseSha } : {}),
        };
        await deps.saveLinks(links);
        // Linking is a stronger act of intent than ticking the follow box (#15) —
        // persist it before the reconcile so the cached issues admit in that pass.
        const m = await deps.ensureManifest();
        markRepoFollowed(m, { owner, name });
        await deps.saveManifest(m);
        // Seed before reconcile so an admitted triage item hits the gate while a
        // generation is in flight (#227); seeding failure never fails the clone.
        await deps.seedInstructions({ owner, name }, localPath).catch(() => {});
        await deps.reconcileFromCache();
        return { ok: true as const, localPath };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:inspectLinkTarget",
    async (
      _e,
      owner: string,
      name: string,
      localPath: string,
    ): Promise<ListRepoBranchesResult> => {
      try {
        await detectHostForLocalPath(deps.getAccounts(), owner, name, localPath);
        // Best-effort authed fetch so the branch list + default are current; a
        // fetch failure never fails the inspect (offline link still works).
        const account = deps.accountForRepo(owner, name);
        const token = account ? await deps.getToken(account.key) : null;
        const creds =
          token && account
            ? codeHostFor(codeHostForProvider(account.provider) ?? "github").pushCredentials(token)
            : undefined;
        await fetchOrigin(localPath, creds, 60_000).catch(() => {});
        return await branchesForLocalClone(localPath);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:listRemoteBranches",
    async (
      _e,
      owner: string,
      name: string,
      accountId?: string,
    ): Promise<ListRepoBranchesResult> => {
      try {
        const account = deps.accountForRepo(owner, name, accountId);
        const token = account ? await deps.getToken(account.key) : null;
        if (!token || !account) {
          return { ok: false, error: "no account token available for this repo" };
        }
        const host = codeHostFor(codeHostForProvider(account.provider) ?? "github");
        const { branches, defaultBranch } = await listRemoteHeads(
          host,
          { owner, name },
          host.pushCredentials(token),
          account.baseUrl,
        );
        return { ok: true, branches, defaultBranch };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle("skipper:orchestrator:unlinkRepo", async (_e, owner: string, name: string) => {
    try {
      const links = await deps.ensureRepoLinks();
      delete links.repos[repoKey({ owner, name })];
      await deps.saveLinks(links);
      // Keep the instructions doc (#227): user edits survive unlink→relink, and a
      // ready doc makes relink skip reseeding.
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  deps.ipcMain.handle(
    "skipper:orchestrator:setRepoBaseBranch",
    async (_e, owner: string, name: string, baseBranch: string | null) => {
      try {
        const links = await deps.ensureRepoLinks();
        const key = repoKey({ owner, name });
        const link = links.repos[key];
        if (!link) return { ok: false as const, error: "repo not linked" };
        const repo = { owner, name };

        const oldBase = link.baseBranch;
        const trimmed = baseBranch?.trim() ?? "";
        const newBase = trimmed === "" ? undefined : trimmed;

        if (newBase) {
          const onOrigin = async (): Promise<boolean> =>
            (await runGit(link.localPath, ["rev-parse", "--verify", "--quiet", `origin/${newBase}`]))
              .code === 0;
          if (!(await onOrigin())) {
            await fetchOrigin(link.localPath).catch(() => {});
            if (!(await onOrigin())) {
              return { ok: false as const, error: `branch '${newBase}' not found on origin` };
            }
          }
        }

        // Effective-change check: only the resolved ref matters (setting the
        // override to what origin/HEAD already points at is a no-op). A throw on
        // either side is treated as a change so the reaction still runs.
        const resolveEff = (ref?: string): Promise<string | null> =>
          resolveBaseRef(link.localPath, ref).catch(() => null);
        const [oldEff, newEff] = await Promise.all([resolveEff(oldBase), resolveEff(newBase)]);
        const changed = oldEff === null || newEff === null || oldEff !== newEff;

        // Persist first so any planning that starts now already cuts from the new base.
        if (newBase) link.baseBranch = newBase;
        else delete link.baseBranch;
        // Restamp the observed base sha (#329) so a base *switch* is never diffed
        // as a base *advance*; unresolvable = no textual evidence next round.
        if (changed) {
          const sha = newEff ? await revParseOrNull(link.localPath, newEff) : null;
          if (sha) link.baseSha = sha;
          else delete link.baseSha;
        }
        await deps.saveLinks(links);
        if (!changed) return { ok: true as const };

        const m = await deps.ensureManifest();
        // Probe + discard under one repo git lock (nesting requestTransition here
        // would self-deadlock via the planner's prepareWorktreeFor).
        const actions = await deps.withRepoGitLock(repo, async () => {
          const oldBaseRef = await resolveBaseRef(link.localPath, oldBase).catch(() => null);
          const probes = new Map<string, WorktreeProbe>();
          for (const item of Object.values(m.items)) {
            if (repoKey(item.repo) !== key || !item.worktree) continue;
            const dirtyFiles = await worktreeDirtyFiles(item.worktree.path);
            const dirty = dirtyFiles === null ? null : dirtyFiles.length > 0;
            let aheadOfOldBase: number | null = null;
            if (oldBaseRef) {
              const rl = await runGit(link.localPath, [
                "rev-list",
                "--count",
                `${oldBaseRef}..refs/heads/${item.worktree.branch}`,
              ]);
              const parsed = rl.code === 0 ? parseInt(rl.stdout.trim(), 10) : NaN;
              aheadOfOldBase = Number.isFinite(parsed) ? parsed : null;
            }
            probes.set(item.id, { dirty, aheadOfOldBase });
          }
          const resolved = resolveBaseChangeActions(Object.values(m.items), key, probes);
          for (const d of resolved.discard) {
            await discardWorktree({
              repoPath: link.localPath,
              worktreePath: d.worktree.path,
              branch: d.worktree.branch,
              baseRef: oldBaseRef ?? undefined,
            }).catch((err) =>
              console.warn(`base-change discard failed for ${d.worktree.path}: ${err}`),
            );
          }
          return resolved;
        });

        // Clear the worktree record on discarded items in one manifest pass.
        if (actions.discard.length > 0) {
          for (const d of actions.discard) {
            const item = m.items[d.id];
            if (item) m.items[d.id] = { ...item, worktree: undefined, updatedAt: new Date().toISOString() };
          }
          await deps.saveManifest(m);
          deps.broadcast();
        }

        // Transitions AFTER the lock (requestTransition pokes the planner, which
        // takes the same lock). Each poke re-enqueues the item on the new base.
        const replanned: string[] = [];
        const skipped = [...actions.skipped];
        for (const id of actions.replan) {
          const item = m.items[id];
          if (!item) continue;
          try {
            await deps.requestTransition(id, "planning", "user", "base branch changed");
            replanned.push(id);
          } catch {
            skipped.push({ id, key: item.key, reason: "illegal-transition" });
          }
        }
        return { ok: true as const, replan: { replanned, skipped } };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:listRepoBranches",
    async (_e, owner: string, name: string): Promise<ListRepoBranchesResult> => {
      try {
        const links = await deps.ensureRepoLinks();
        const link = links.repos[repoKey({ owner, name })];
        if (!link) return { ok: false, error: "repo not linked" };
        return await branchesForLocalClone(link.localPath);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle("skipper:orchestrator:listRepos", async () => {
    const links = await deps.ensureRepoLinks();
    const m = await deps.ensureManifest();
    const seen = new Map<string, RepoRef>();
    for (const repo of deps.cachedRepos()) {
      seen.set(repoKey(repo), repo);
    }
    // A followed repo the poller never saw (manual owner/name add, tracker-first
    // setups) still needs a row here — this is the only place linking happens.
    for (const [key, settings] of Object.entries(m.repoSettings)) {
      if (seen.has(key) || !resolveRepoIntakeSettings(settings).followed) continue;
      const repo = parseRepoPath(key);
      if (repo) seen.set(key, repo);
    }
    const linked = Object.entries(links.repos).map(([key, link]) => ({
      key,
      localPath: link.localPath,
      linkedAt: link.linkedAt,
      baseBranch: link.baseBranch,
      linked: true as const,
    }));
    const unlinked = [...seen.entries()]
      .filter(([key]) => !links.repos[key])
      .map(([key, repo]) => ({ key, repo, linked: false as const }));
    return { linked, unlinked };
  });
}
