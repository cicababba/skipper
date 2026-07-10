import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AuthState, SyncPreferences, SyncState } from "@nestbrain/shared";

interface GitOpResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Mark HTML element so web UI can adjust for native chrome
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("is-desktop");
  if (process.platform === "darwin") {
    document.documentElement.classList.add("is-desktop-mac");
  }
});

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface CreateTerminalResult {
  id: string;
  cwd: string;
}

contextBridge.exposeInMainWorld("nestbrain", {
  isElectron: true,
  platform: process.platform,

  getBootstrap: () => ipcRenderer.invoke("nestbrain:getBootstrap"),
  selectDirectory: () => ipcRenderer.invoke("nestbrain:selectDirectory"),

  projects: {
    import: (): Promise<{ projectPath: string; name: string } | null> =>
      ipcRenderer.invoke("nestbrain:projects:import"),
    makeReady: (projectPath: string): Promise<{ ready: boolean }> =>
      ipcRenderer.invoke("nestbrain:projects:makeReady", projectPath),
    status: (projectPath: string): Promise<{ ready: boolean }> =>
      ipcRenderer.invoke("nestbrain:projects:status", projectPath),
  },
  trash: {
    list: (): Promise<{ id: string; name: string; originalPath: string; size: number; deletedAt: number }[]> =>
      ipcRenderer.invoke("nestbrain:trash:list"),
    restore: (id: string): Promise<{ ok: true; restoredTo: string }> =>
      ipcRenderer.invoke("nestbrain:trash:restore", id),
    empty: (): Promise<{ ok: true }> => ipcRenderer.invoke("nestbrain:trash:empty"),
  },
  session: {
    run: (mode: "save" | "resume", projectDir: string): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke("nestbrain:session:run", mode, projectDir),
  },
  setupNestBrain: (parentPath: string) =>
    ipcRenderer.invoke("nestbrain:setupNestBrain", parentPath),
  moveOrCreateNestBrain: (parentPath: string) =>
    ipcRenderer.invoke("nestbrain:moveOrCreateNestBrain", parentPath),
  onNestBrainMoved: (callback: (info: { nestBrainPath: string }) => void) => {
    const handler = (_e: unknown, info: { nestBrainPath: string }) =>
      callback(info);
    ipcRenderer.on("nestbrain:nestBrainMoved", handler);
    return () => ipcRenderer.off("nestbrain:nestBrainMoved", handler);
  },

  // File system
  fs: {
    list: (dirPath: string): Promise<FsEntry[]> =>
      ipcRenderer.invoke("nestbrain:fs:list", dirPath),
    createDir: (dirPath: string): Promise<{ ok: true; path: string }> =>
      ipcRenderer.invoke("nestbrain:fs:createDir", dirPath),
    readFile: (filePath: string): Promise<{
      content: string;
      size: number;
      binary: boolean;
      tooLarge: boolean;
    }> => ipcRenderer.invoke("nestbrain:fs:readFile", filePath),
    writeFile: (
      filePath: string,
      content: string,
    ): Promise<{ ok: true; size: number }> =>
      ipcRenderer.invoke("nestbrain:fs:writeFile", filePath, content),
    delete: (targetPath: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke("nestbrain:fs:delete", targetPath),
    rename: (
      oldPath: string,
      newName: string,
    ): Promise<{ ok: true; newPath: string }> =>
      ipcRenderer.invoke("nestbrain:fs:rename", oldPath, newName),
    onChange: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on("nestbrain:fs:changed", handler);
      return () => ipcRenderer.off("nestbrain:fs:changed", handler);
    },
  },

  // Auth (Google OAuth)
  auth: {
    getState: (): Promise<AuthState> =>
      ipcRenderer.invoke("nestbrain:auth:getState"),
    signIn: (): Promise<void> => ipcRenderer.invoke("nestbrain:auth:signIn"),
    signOut: (): Promise<void> => ipcRenderer.invoke("nestbrain:auth:signOut"),
    cancelSignIn: (): Promise<void> =>
      ipcRenderer.invoke("nestbrain:auth:cancelSignIn"),
    onStateChanged: (callback: (state: AuthState) => void) => {
      const handler = (_e: unknown, state: AuthState) => callback(state);
      ipcRenderer.on("nestbrain:auth:stateChanged", handler);
      return () => ipcRenderer.off("nestbrain:auth:stateChanged", handler);
    },
  },

  // Sync (Google Drive)
  sync: {
    getState: (): Promise<SyncState | null> =>
      ipcRenderer.invoke("nestbrain:sync:getState"),
    setPreferences: (prefs: Partial<SyncPreferences>): Promise<void> =>
      ipcRenderer.invoke("nestbrain:sync:setPreferences", prefs),
    syncNow: (): Promise<void> => ipcRenderer.invoke("nestbrain:sync:syncNow"),
    cancel: (): Promise<void> => ipcRenderer.invoke("nestbrain:sync:cancel"),
    softDelete: (relPath: string): Promise<void> =>
      ipcRenderer.invoke("nestbrain:sync:softDelete", relPath),
    hardDelete: (relPath: string): Promise<void> =>
      ipcRenderer.invoke("nestbrain:sync:hardDelete", relPath),
    onStateChanged: (callback: (state: SyncState) => void) => {
      const handler = (_e: unknown, state: SyncState) => callback(state);
      ipcRenderer.on("nestbrain:sync:stateChanged", handler);
      return () => ipcRenderer.off("nestbrain:sync:stateChanged", handler);
    },
  },

  modules: {
    get: (): Promise<string[]> => ipcRenderer.invoke("nestbrain:modules:get"),
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("nestbrain:openExternal", url),
  onShowAbout: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("nestbrain:show-about", handler);
    return () => ipcRenderer.off("nestbrain:show-about", handler);
  },

  // Resolve a renderer-side File object to its absolute filesystem path.
  // Used by drag-drop into the terminal — Electron 32+ removed File.path
  // so we go through webUtils, which the preload can call but the
  // sandboxed renderer can't.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // Git status — used by the file tree to render per-file markers and
  // a branch chip next to project folders. Returns null when the path
  // isn't a git repo top, so the caller can cheaply ask first.
  git: {
    status: (
      repoPath: string,
    ): Promise<{
      branch: string;
      ahead: number;
      behind: number;
      files: Record<string, { index: string; worktree: string }>;
      hasUpstream: boolean;
    } | null> => ipcRenderer.invoke("nestbrain:git:status", repoPath),
    findRepo: (
      anyPath: string,
    ): Promise<{
      repoPath: string;
      status: {
        branch: string;
        ahead: number;
        behind: number;
        files: Record<string, { index: string; worktree: string }>;
        hasUpstream: boolean;
      };
    } | null> => ipcRenderer.invoke("nestbrain:git:findRepo", anyPath),
    stage: (repoPath: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:stage", repoPath, paths),
    unstage: (repoPath: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:unstage", repoPath, paths),
    discard: (repoPath: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:discard", repoPath, paths),
    commit: (repoPath: string, message: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:commit", repoPath, message),
    push: (repoPath: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:push", repoPath),
    pull: (repoPath: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:pull", repoPath),
    stashList: (
      repoPath: string,
    ): Promise<GitOpResult & { stashes: { ref: string; message: string }[] }> =>
      ipcRenderer.invoke("nestbrain:git:stashList", repoPath),
    stashPush: (
      repoPath: string,
      message?: string,
      includeUntracked?: boolean,
    ): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:stashPush", repoPath, message, includeUntracked),
    stashPop: (repoPath: string, ref?: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:stashPop", repoPath, ref),
    stashDrop: (repoPath: string, ref: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("nestbrain:git:stashDrop", repoPath, ref),
  },

  // Auto-update (official builds; inert in source builds)
  updates: {
    getState: (): Promise<unknown> => ipcRenderer.invoke("nestbrain:updates:getState"),
    check: (): Promise<unknown> => ipcRenderer.invoke("nestbrain:updates:check"),
    restart: (): Promise<void> => ipcRenderer.invoke("nestbrain:updates:restart"),
    onStateChanged: (callback: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => callback(state);
      ipcRenderer.on("nestbrain:updates:stateChanged", handler);
      return () => ipcRenderer.off("nestbrain:updates:stateChanged", handler);
    },
  },

  // CLI on PATH (Install / Uninstall)
  cli: {
    status: (): Promise<{
      supported: boolean;
      target: string | null;
      source: string;
      installed: boolean;
      stale: boolean;
    }> => ipcRenderer.invoke("nestbrain:cli:status"),
    install: () => ipcRenderer.invoke("nestbrain:cli:install"),
    uninstall: () => ipcRenderer.invoke("nestbrain:cli:uninstall"),
  },

  // Terminal
  terminal: {
    create: (opts: { cwd: string; cols?: number; rows?: number }): Promise<CreateTerminalResult> =>
      ipcRenderer.invoke("nestbrain:terminal:create", opts),
    write: (id: string, data: string) =>
      ipcRenderer.send("nestbrain:terminal:write", { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send("nestbrain:terminal:resize", { id, cols, rows }),
    kill: (id: string) => ipcRenderer.send("nestbrain:terminal:kill", { id }),
    onData: (id: string, callback: (data: string) => void) => {
      const channel = `nestbrain:terminal:data:${id}`;
      const handler = (_e: unknown, data: string) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
    onExit: (id: string, callback: (code: number) => void) => {
      const channel = `nestbrain:terminal:exit:${id}`;
      const handler = (_e: unknown, code: number) => callback(code);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
  },
});
