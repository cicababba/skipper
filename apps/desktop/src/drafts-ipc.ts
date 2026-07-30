import type { IpcMain } from "electron";
import {
  deleteComposerDraftFile,
  listComposerDrafts,
  readComposerDraftFile,
} from "./composer-draft-store";
import { demoteComposerDraft, hasLiveComposerChat } from "./composer-chat";
import { deleteAttachmentsDir } from "./composer-attachment-store";

// Saved composer drafts IPC (#138). The save/resume half lives on the composer
// namespace (it acts on a live chat); this module owns the list and the delete,
// which act on files. Deps are injected so the handlers are testable without a
// live Electron main.

export interface DraftsIpcDeps {
  ipcMain: IpcMain;
  draftsDir: string;
  /** Chat attachments root (#281), <userData>/composer/attachments. */
  attachmentsDir: string;
  notifyChanged: () => void;
}

export function registerDraftsHandlers(deps: DraftsIpcDeps): void {
  deps.ipcMain.handle("skipper:drafts:list", () => listComposerDrafts(deps.draftsDir));
  deps.ipcMain.handle("skipper:drafts:delete", async (_e, draftId: string) => {
    // Read before demoting: the file is the only place the chat id still is, and
    // the attachments are keyed by it (#281).
    const stored = await readComposerDraftFile(deps.draftsDir, draftId);
    // Demote first: a live chat still holding the id would autosave the file
    // back into existence on its next turn.
    demoteComposerDraft(draftId);
    const removed = await deleteComposerDraftFile(deps.draftsDir, draftId);
    if (!removed) return { ok: false as const, error: `no draft ${draftId}` };
    // A live chat's dispose owns its attachments — demote marked it discarded.
    if (stored && !hasLiveComposerChat(stored.chatId)) {
      await deleteAttachmentsDir(deps.attachmentsDir, stored.chatId).catch(() => {
        /* best-effort: the next composer init sweeps what is left */
      });
    }
    deps.notifyChanged();
    return { ok: true as const };
  });
}
