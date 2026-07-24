import type { AppSettings, AppSettingsPatch } from "@skipper/shared";

// App settings moved off the embedded server onto Electron IPC (#208). Outside
// Electron (plain browser) there is no settings backend, so reads return null
// and writes are no-ops.

export async function getAppSettings(): Promise<AppSettings | null> {
  if (typeof window === "undefined" || !window.skipper) return null;
  return window.skipper.settings.get();
}

export async function updateAppSettings(patch: AppSettingsPatch): Promise<void> {
  if (typeof window === "undefined" || !window.skipper) return;
  await window.skipper.settings.set(patch);
}
