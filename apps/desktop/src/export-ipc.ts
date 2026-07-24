import type { BrowserWindow, IpcMain, SaveDialogOptions, SaveDialogReturnValue } from "electron";

// Markdown export (#216): save an exported artifact/dossier to a user-chosen .md
// file via the native save dialog. Deps are injected so the handler is testable
// without a live Electron main.
export interface ExportIpcDeps {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  showSaveDialog: (
    window: BrowserWindow,
    options: SaveDialogOptions,
  ) => Promise<SaveDialogReturnValue>;
  writeFile: (path: string, content: string) => Promise<void>;
}

export function registerExportHandlers(deps: ExportIpcDeps): void {
  const { ipcMain, getMainWindow, showSaveDialog, writeFile } = deps;
  ipcMain.handle(
    "skipper:export:saveMarkdown",
    async (_e, defaultFilename: string, content: string) => {
      const win = getMainWindow();
      if (!win) return { ok: false as const, error: "no window" };
      try {
        const result = await showSaveDialog(win, {
          defaultPath: defaultFilename,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (result.canceled || !result.filePath) return { ok: true as const, canceled: true };
        await writeFile(result.filePath, content);
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
