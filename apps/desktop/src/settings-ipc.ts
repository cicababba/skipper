import type { IpcMain } from "electron";
import type { AppSettingsPatch } from "@skipper/shared";
import { loadAppSettings, saveAppSettings, mergeSettingsPatch, maskSettings } from "./settings-store";

// App settings moved off the embedded Next server onto IPC (#208). Deps are
// injected so main can hand the dev/packaged settings dir; `get` masks the
// OpenAI key, `set` loads → merges the patch → persists.
export interface SettingsIpcDeps {
  ipcMain: IpcMain;
  settingsDir: () => string;
}

export function registerSettingsHandlers(deps: SettingsIpcDeps): void {
  const { ipcMain, settingsDir } = deps;
  ipcMain.handle("skipper:settings:get", async () => {
    return maskSettings(await loadAppSettings(settingsDir()));
  });
  ipcMain.handle("skipper:settings:set", async (_e, patch: AppSettingsPatch) => {
    const dir = settingsDir();
    const updated = mergeSettingsPatch(await loadAppSettings(dir), patch);
    await saveAppSettings(dir, updated);
    return { ok: true as const };
  });
}
