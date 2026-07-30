import { join } from "node:path";
import type { IpcMain } from "electron";
import type { AgentRuntimeId, RuntimeAvailability } from "@skipper/shared";

// Which agent CLIs are actually installed (#287), so the settings selects can
// list only what a run could really spawn. Probed fresh on every call against
// the main process' PATH — no cache, no startup scan.

const RUNTIME_BINARIES: Record<AgentRuntimeId, string> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "copilot-cli": "copilot",
  "gemini-cli": "gemini",
};

export interface RuntimesIpcDeps {
  ipcMain: IpcMain;
  exec: (cmd: string) => void;
  fileExists: (path: string) => boolean;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

// A Windows PATH is stale for an already-running process, so mirror the
// resolvers in packages/core/src/llm/*-cli.ts: the same four install locations
// they can launch from also count as installed here.
function windowsFallbackPaths(bin: string, env: RuntimesIpcDeps["env"]): string[] {
  const home = env.USERPROFILE || env.HOME || "";
  const appdata = env.APPDATA || "";
  const local = env.LOCALAPPDATA || "";
  return [
    home && join(home, ".local", "bin", `${bin}.exe`),
    local && join(local, "Programs", bin, `${bin}.exe`),
    appdata && join(appdata, "npm", `${bin}.cmd`),
    appdata && join(appdata, "npm", `${bin}.exe`),
  ].filter(Boolean) as string[];
}

export function detectRuntimes(deps: Omit<RuntimesIpcDeps, "ipcMain">): RuntimeAvailability {
  const { exec, fileExists, platform, env } = deps;
  const isWindows = platform === "win32";
  const result = {} as RuntimeAvailability;
  for (const [runtime, bin] of Object.entries(RUNTIME_BINARIES) as [AgentRuntimeId, string][]) {
    try {
      exec(isWindows ? `where ${bin}` : `command -v ${bin}`);
      result[runtime] = true;
    } catch {
      result[runtime] = isWindows && windowsFallbackPaths(bin, env).some(fileExists);
    }
  }
  return result;
}

export function registerRuntimesHandlers(deps: RuntimesIpcDeps): void {
  const { ipcMain, ...probe } = deps;
  ipcMain.handle("skipper:runtimes:status", () => detectRuntimes(probe));
}
