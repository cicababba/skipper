import type { IpcMain } from "electron";
import type { OrchestratorManifest } from "@skipper/core";
import {
  listWorktreeChanges,
  readWorktreeFileVersions,
  worktreeDiffTotals,
  worktreeStatus,
  writeWorktreeFile,
} from "./worktrees";

export interface WorktreeDiffIpcDeps {
  ipcMain: IpcMain;
  ensureManifest: () => Promise<OrchestratorManifest>;
}

export function registerWorktreeDiffHandlers(deps: WorktreeDiffIpcDeps): void {
  const { ipcMain, ensureManifest } = deps;
  // Worktree diff viewer (#114). The renderer may read and save any worktree
  // that exists on disk, in any lifecycle state — the user owns the worktree.
  async function usableWorktree(
    itemId: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const m = await ensureManifest();
    const item = m.items[itemId];
    if (!item) return { ok: false, error: `unknown item ${itemId}` };
    const st = await worktreeStatus(item.worktree);
    if (!st.ok) return st;
    if (!st.present) return { ok: false, error: "worktree folder is missing on disk" };
    return { ok: true, path: st.path };
  }

  ipcMain.handle("skipper:orchestrator:getWorktreeChanges", async (_e, itemId: string) => {
    const wt = await usableWorktree(itemId);
    if (!wt.ok) return wt;
    try {
      const files = await listWorktreeChanges(wt.path);
      const totals = await worktreeDiffTotals(wt.path);
      return { ok: true as const, files, totals };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(
    "skipper:orchestrator:readWorktreeFile",
    async (_e, itemId: string, path: string, oldPath?: string) => {
      const wt = await usableWorktree(itemId);
      if (!wt.ok) return wt;
      try {
        return { ok: true as const, file: await readWorktreeFileVersions(wt.path, path, oldPath) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(
    "skipper:orchestrator:saveWorktreeFile",
    async (_e, itemId: string, path: string, content: string) => {
      const wt = await usableWorktree(itemId);
      if (!wt.ok) return wt;
      try {
        await writeWorktreeFile(wt.path, path, content);
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  // Worktree control center (#40): location + liveness for any item with a
  // worktree, in any lifecycle state — unlike the review-gated diff handlers.
  ipcMain.handle("skipper:orchestrator:getWorktreeStatus", async (_e, itemId: string) => {
    const m = await ensureManifest();
    const item = m.items[itemId];
    if (!item) return { ok: false as const, error: `unknown item ${itemId}` };
    return worktreeStatus(item.worktree);
  });
}
