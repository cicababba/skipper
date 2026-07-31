import type { IpcMain } from "electron";
import {
  listJiraProjects,
  listMembershipProjects,
  listOpenProjectProjects,
  listUserInstallationRepos,
  remapProjectItems,
  type OrchestratorManifest,
} from "@skipper/core";
import {
  formatRepoMappingValue,
  mappingHost,
  parseProjectMappingKey,
  parseRepoMappingValue,
  projectMappingKey,
  repoKey,
  resolveRepoIntakeSettings,
} from "@skipper/shared";
import type {
  Account,
  AuthProviderId,
  FollowCandidate,
  FollowCandidatesResult,
  Issue,
  OrchestratorState,
  PullRequest,
  TrackerProjectsResult,
} from "@skipper/shared";
import type { RepoLinksFile } from "./repo-links";
import { activeItemsForRepo } from "./repo-follow";

// Intake surfaces (#79): the follow-candidate picker, the project→repo mapping
// writer and the live tracker-project listing behind the mapping editor.
export interface IntakeIpcDeps {
  ipcMain: IpcMain;
  ensureManifest: () => Promise<OrchestratorManifest>;
  saveManifest: (m: OrchestratorManifest) => Promise<void>;
  ensureRepoLinks: () => Promise<RepoLinksFile>;
  /** Every connected account, including the ones that back no issue source. */
  getAccounts: () => Account[];
  /** Accounts whose auth provider backs an issue source. */
  issueAccounts: () => Account[];
  getToken: (accountKey: string, forceRefresh?: boolean) => Promise<string | null>;
  snapshot: () => OrchestratorState;
  reconcileFromCache: () => Promise<void>;
  cachedFor: (accountId: string) => Map<string, Issue | PullRequest> | undefined;
}

export function registerIntakeHandlers(deps: IntakeIpcDeps): void {
  deps.ipcMain.handle(
    "skipper:orchestrator:listFollowCandidates",
    async (_e, accountId?: string, providerId?: AuthProviderId): Promise<FollowCandidatesResult> => {
      try {
        const account = accountId
          ? deps
              .issueAccounts()
              .find((a) => a.key === accountId && (!providerId || a.provider === providerId))
          : deps.issueAccounts()[0];
        if (!account) return { ok: false, error: "no issue-source account connected" };
        const m = await deps.ensureManifest();
        const links = await deps.ensureRepoLinks();

        const candidates = new Map<string, FollowCandidate>();
        const describe = (key: string): Omit<FollowCandidate, "repo" | "source"> => ({
          followed: resolveRepoIntakeSettings(m.repoSettings[key]).followed,
          linked: Boolean(links.repos[key]),
          activeItems: activeItemsForRepo(m, key).length,
        });

        let installationCount: number | undefined;
        let installUrl: string | undefined;

        if (account.provider === "github") {
          const result = await listUserInstallationRepos((force) =>
            deps.getToken(account.key, force),
          );
          for (const repo of result.repos) {
            const key = repoKey(repo);
            candidates.set(key, {
              repo: { owner: repo.owner, name: repo.name },
              private: repo.private,
              source: "installation",
              ...describe(key),
            });
          }
          installationCount = result.installationCount;
          installUrl = result.appSlug
            ? `https://github.com/apps/${result.appSlug}/installations/new`
            : "https://github.com/settings/installations";
        } else if (account.provider === "gitlab") {
          const projects = await listMembershipProjects(
            (force) => deps.getToken(account.key, force),
            account.baseUrl,
          );
          for (const project of projects) {
            const key = repoKey(project.repo);
            candidates.set(key, {
              repo: project.repo,
              private: project.private,
              source: "membership",
              ...describe(key),
            });
          }
        }

        // Public repos assigned via general visibility never show in the
        // installation/membership lists — merge what this account's poller saw.
        const polled = deps.cachedFor(account.key);
        if (polled) {
          for (const item of polled.values()) {
            if (!item.repo) continue;
            const key = repoKey(item.repo);
            if (candidates.has(key)) continue;
            candidates.set(key, {
              repo: item.repo,
              source: "polled",
              ...describe(key),
            });
          }
        }

        return {
          ok: true,
          installationCount,
          installUrl,
          repos: [...candidates.values()].sort((a, b) =>
            `${a.repo.owner}/${a.repo.name}`.localeCompare(`${b.repo.owner}/${b.repo.name}`),
          ),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  // Project→repo mapping writer (#79). Validate the key via parseProjectMappingKey
  // (invalid → no-op, never coerce), rebuild the canonical key, then reconcile so a
  // fresh mapping admits cached repo-less issues and an unmapping blocks new ones.
  deps.ipcMain.handle(
    "skipper:orchestrator:setProjectMapping",
    async (_e, mappingKey: string, repo: string | null) => {
      const m = await deps.ensureManifest();
      const parts = parseProjectMappingKey(mappingKey);
      if (!parts) return deps.snapshot();
      const key = projectMappingKey(parts.source, parts.host, parts.projectKey);
      if (repo) {
        const parsed = parseRepoMappingValue(repo);
        if (!parsed) return deps.snapshot();
        m.projectMappings[key] = formatRepoMappingValue(parsed.codeHost, parsed.repo);
        // #120: migrate/flag already-tracked items pinned to the old repo.
        remapProjectItems(m, key, { repo: parsed.repo, codeHost: parsed.codeHost }, (accountId) => {
          const account = deps.getAccounts().find((a) => a.key === accountId);
          return account ? mappingHost(account.baseUrl) : undefined;
        });
      } else {
        delete m.projectMappings[key];
      }
      await deps.saveManifest(m);
      await deps.reconcileFromCache();
      return deps.snapshot();
    },
  );
  // Live project listing for the mapping editor (#79). Use getAccounts directly —
  // needs-project-mapping trackers (Jira, OpenProject) carry no inherent repo, so
  // this handler is the path to an account's projects for the mapping UI.
  deps.ipcMain.handle(
    "skipper:orchestrator:listTrackerProjects",
    async (_e, accountId: string): Promise<TrackerProjectsResult> => {
      const account = deps.getAccounts().find((a) => a.key === accountId);
      if (!account) return { ok: false, error: "unknown account" };
      try {
        if (account.provider === "jira") {
          const projects = await listJiraProjects((force) => deps.getToken(account.key, force), {
            cloudId: account.cloudId,
            baseUrl: account.baseUrl,
          });
          return { ok: true, source: "jira", host: mappingHost(account.baseUrl), projects };
        }
        if (account.provider === "openproject") {
          if (!account.baseUrl) return { ok: false, error: "account has no instance URL" };
          const projects = await listOpenProjectProjects(
            (force) => deps.getToken(account.key, force),
            account.baseUrl,
            account.authMethod,
          );
          return { ok: true, source: "openproject", host: mappingHost(account.baseUrl), projects };
        }
        return { ok: false, error: "account does not support project mapping" };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
