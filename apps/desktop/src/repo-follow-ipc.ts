import type { IpcMain } from "electron";
import type { OrchestratorManifest } from "@skipper/core";
import type { Issue, OrchestratorState, PullRequest, SetRepoFollowedResult } from "@skipper/shared";
import { applyRepoFollowed } from "./repo-follow";

// Explicit follow set (#15): the sidebar shows exactly the repos the user chose.
// Deps are injected so the handler is testable without a live Electron main.
export interface RepoFollowIpcDeps {
  ipcMain: IpcMain;
  ensureManifest: () => Promise<OrchestratorManifest>;
  saveManifest: (m: OrchestratorManifest) => Promise<void>;
  /** Every cached poll item — the only place a parked issue id's repo is known. */
  cachedItems: () => Iterable<Issue | PullRequest>;
  /** Admits the repo's cached issues retroactively, then broadcasts. */
  reconcileFromCache: () => Promise<void>;
  broadcast: () => void;
  snapshot: () => OrchestratorState;
}

export function registerRepoFollowHandlers(deps: RepoFollowIpcDeps): void {
  deps.ipcMain.handle(
    "skipper:orchestrator:setRepoFollowed",
    async (_e, owner: string, name: string, followed: boolean): Promise<SetRepoFollowedResult> => {
      const trimmedOwner = owner?.trim();
      const trimmedName = name?.trim();
      if (!trimmedOwner || !trimmedName) {
        return { ok: false, error: "repo owner and name are required", blocking: [] };
      }
      const repo = { owner: trimmedOwner, name: trimmedName };
      const m = await deps.ensureManifest();
      const result = applyRepoFollowed(m, repo, followed === true, deps.cachedItems());
      if (!result.ok) return result;
      await deps.saveManifest(m);
      if (followed === true) await deps.reconcileFromCache();
      else deps.broadcast();
      return { ok: true, state: deps.snapshot() };
    },
  );
}
