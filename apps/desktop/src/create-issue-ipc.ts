import type { IpcMain } from "electron";
import type {
  Account,
  CreateIssueOnTrackerParams,
  CreateIssueOnTrackerResult,
  IssueSourceId,
} from "@skipper/shared";
import { mappingHost, projectForRepo } from "@skipper/shared";
import type { IssueSource } from "@skipper/core";

// Trackers whose issues live in a project rather than in the repo: the create
// call needs the project, which only the project→repo mapping knows (#274).
const PROJECT_SCOPED_SOURCES = new Set<IssueSourceId>(["jira", "openproject"]);

// Issue creation (#135). The created issue is deliberately NOT injected into the
// manifest or the poll cache: the GitHub poll only reads the `assigned` stream,
// so an unassigned issue is invisible to it and the 6-hourly full walk would
// close the injected item as "no longer assigned or visible". Self-assignment
// (#136) needs no injection either — the assigned stream picks the issue up on
// the next poll. Deps are injected so the handler is testable without a live
// Electron main.
export interface CreateIssueIpcDeps {
  ipcMain: IpcMain;
  getAccounts: () => Account[];
  getToken: (accountKey: string, forceRefresh?: boolean) => Promise<string | null>;
  sourceForProvider: (provider: Account["provider"]) => IssueSource | undefined;
  getProjectMappings: () => Promise<Record<string, string>>;
}

export function registerCreateIssueHandlers(deps: CreateIssueIpcDeps): void {
  deps.ipcMain.handle(
    "skipper:orchestrator:createIssueOnTracker",
    async (_e, params: CreateIssueOnTrackerParams): Promise<CreateIssueOnTrackerResult> => {
      const title = params?.title?.trim();
      if (!title) return { ok: false, error: "title is required" };
      const owner = params.repo?.owner?.trim();
      const name = params.repo?.name?.trim();
      if (!owner || !name) return { ok: false, error: "repo owner and name are required" };

      const account = deps.getAccounts().find((a) => a.key === params.accountId);
      if (!account) return { ok: false, error: `unknown account ${params.accountId}` };

      const source = deps.sourceForProvider(account.provider);
      if (!source?.createIssue) {
        return { ok: false, error: `issue creation is not supported for ${account.provider}` };
      }

      let project: string | undefined;
      if (PROJECT_SCOPED_SOURCES.has(source.id)) {
        const mapped = projectForRepo(await deps.getProjectMappings(), {
          source: source.id,
          host: mappingHost(account.baseUrl),
          repo: { owner, name },
        });
        if (!mapped.ok) {
          return {
            ok: false,
            error:
              mapped.reason === "unmapped"
                ? `no ${source.id} project is mapped to ${owner}/${name} — add the mapping in Settings`
                : `${owner}/${name} is mapped to more than one ${source.id} project (${mapped.candidates.join(", ")}) — leave a single mapping in Settings`,
          };
        }
        project = mapped.projectKey;
      }

      try {
        const issue = await source.createIssue(
          {
            repo: { owner, name },
            title,
            body: params.body,
            labels: params.labels,
            assignees: params.assignees,
            accountId: account.key,
            ...(project !== undefined && { project }),
          },
          (force) => deps.getToken(account.key, force),
          account.baseUrl,
          account.cloudId,
          account.authMethod,
        );
        return {
          ok: true,
          id: issue.id,
          key: issue.key,
          ...(issue.number != null && { number: issue.number }),
          url: issue.url,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
