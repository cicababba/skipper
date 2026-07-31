import type { IpcMain } from "electron";
import type { OrchestratorManifest } from "@skipper/core";
import { repoKey, resolveRepoIntakeSettings } from "@skipper/shared";
import type {
  GetRepoGraphifyResult,
  GetRepoInstructionsResult,
  RegenerateRepoInstructionsResult,
  ReindexRepoGraphifyResult,
  RepoInstructionsDoc,
  RepoRef,
  SetRepoInstructionsResult,
} from "@skipper/shared";
import type { RepoLinksFile } from "./repo-links";
import {
  isInstructionsGenerating,
  loadRepoInstructions,
  saveRepoInstructions,
} from "./repo-instructions";
import { isGraphifyRunning, loadGraphifyDoc } from "./graphify-store";

// Per-repo agent instructions (#227) and the Graphify index (#233). The stores
// are impure fs helpers imported directly; only orchestrator state is injected.
export interface RepoConfigIpcDeps {
  ipcMain: IpcMain;
  repoInstructionsDir: string;
  graphsDir: string;
  ensureManifest: () => Promise<OrchestratorManifest>;
  ensureRepoLinks: () => Promise<RepoLinksFile>;
  broadcast: () => void;
  pokePlanner: () => void;
  seedInstructions: (repo: RepoRef, localPath: string, force?: boolean) => Promise<void>;
  kickGraphify: (repo: RepoRef) => void;
}

export function registerRepoConfigHandlers(deps: RepoConfigIpcDeps): void {
  deps.ipcMain.handle(
    "skipper:orchestrator:getRepoInstructions",
    async (_e, owner: string, name: string): Promise<GetRepoInstructionsResult> => {
      try {
        const doc = await loadRepoInstructions(deps.repoInstructionsDir, repoKey({ owner, name }));
        return { ok: true, doc };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:setRepoInstructions",
    async (_e, owner: string, name: string, content: string): Promise<SetRepoInstructionsResult> => {
      try {
        if (typeof content !== "string") return { ok: false, error: "content must be a string" };
        const doc: RepoInstructionsDoc = {
          version: 1,
          content: content.slice(0, 100_000),
          updatedAt: new Date().toISOString(),
          source: "edited",
          status: "ready",
        };
        await saveRepoInstructions(deps.repoInstructionsDir, repoKey({ owner, name }), doc);
        deps.broadcast();
        deps.pokePlanner();
        return { ok: true, doc };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:regenerateRepoInstructions",
    async (_e, owner: string, name: string): Promise<RegenerateRepoInstructionsResult> => {
      try {
        const links = await deps.ensureRepoLinks();
        const link = links.repos[repoKey({ owner, name })];
        if (!link) return { ok: false, error: "repo not linked" };
        if (isInstructionsGenerating(repoKey({ owner, name }))) {
          return { ok: false, error: "generation already running" };
        }
        void deps.seedInstructions({ owner, name }, link.localPath, true);
        deps.broadcast();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:getRepoGraphify",
    async (_e, owner: string, name: string): Promise<GetRepoGraphifyResult> => {
      try {
        const doc = await loadGraphifyDoc(deps.graphsDir, repoKey({ owner, name }));
        return { ok: true, doc };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  deps.ipcMain.handle(
    "skipper:orchestrator:reindexRepoGraphify",
    async (_e, owner: string, name: string): Promise<ReindexRepoGraphifyResult> => {
      try {
        const key = repoKey({ owner, name });
        const links = await deps.ensureRepoLinks();
        if (!links.repos[key]?.localPath) return { ok: false, error: "repo not linked" };
        const m = await deps.ensureManifest();
        if (!resolveRepoIntakeSettings(m.repoSettings[key]).graphify) {
          return { ok: false, error: "Graphify is off for this repo" };
        }
        if (isGraphifyRunning(key)) return { ok: false, error: "indexing already running" };
        deps.kickGraphify({ owner, name });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
