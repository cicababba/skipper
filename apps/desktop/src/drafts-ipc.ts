import type { IpcMain } from "electron";
import { deleteComposerDraftFile, listComposerDrafts } from "./composer-draft-store";
import { demoteComposerDraft } from "./composer-chat";

// Saved composer drafts IPC (#138). The save/resume half lives on the composer
// namespace (it acts on a live chat); this module owns the list and the delete,
// which act on files. Deps are injected so the handlers are testable without a
// live Electron main.

export interface DraftsIpcDeps {
  ipcMain: IpcMain;
  draftsDir: string;
  notifyChanged: () => void;
}

export function registerDraftsHandlers(deps: DraftsIpcDeps): void {
  deps.ipcMain.handle("skipper:drafts:list", () => listComposerDrafts(deps.draftsDir));
  deps.ipcMain.handle("skipper:drafts:delete", async (_e, draftId: string) => {
    // Demote first: a live chat still holding the id would autosave the file
    // back into existence on its next turn.
    demoteComposerDraft(draftId);
    const removed = await deleteComposerDraftFile(deps.draftsDir, draftId);
    if (!removed) return { ok: false as const, error: `no draft ${draftId}` };
    deps.notifyChanged();
    return { ok: true as const };
  });
}
