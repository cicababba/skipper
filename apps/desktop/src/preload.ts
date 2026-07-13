import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AuthProviderId,
  AuthState,
  IssuePlan,
  LifecycleState,
  FollowCandidatesResult,
  ListReposResult,
  OrchestratorState,
  OrchestratorTransitionResult,
  RepoIntakeSettings,
  RepoLinkResult,
  RepoSettingsRow,
  RepoUnlinkResult,
  ResumeRiteAction,
  SaveWorktreeFileResult,
  StoredPlan,
  UpdatePlanResult,
  WorktreeChangesResult,
  WorktreeFileResult,
} from "@nestbrain/shared";

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

  // Auth (multi-provider OAuth)
  auth: {
    getState: (): Promise<AuthState> =>
      ipcRenderer.invoke("nestbrain:auth:getState"),
    signIn: (provider: AuthProviderId): Promise<void> =>
      ipcRenderer.invoke(`nestbrain:auth:${provider}:signIn`),
    signOut: (provider: AuthProviderId, accountId?: string): Promise<void> =>
      ipcRenderer.invoke(`nestbrain:auth:${provider}:signOut`, accountId),
    cancelSignIn: (provider: AuthProviderId): Promise<void> =>
      ipcRenderer.invoke(`nestbrain:auth:${provider}:cancelSignIn`),
    onStateChanged: (callback: (state: AuthState) => void) => {
      const handler = (_e: unknown, state: AuthState) => callback(state);
      ipcRenderer.on("nestbrain:auth:stateChanged", handler);
      return () => ipcRenderer.off("nestbrain:auth:stateChanged", handler);
    },
  },

  modules: {
    get: (): Promise<string[]> => ipcRenderer.invoke("nestbrain:modules:get"),
  },

  // Orchestrator (issue #6 wiring; typed surface consumed by the inbox UI, #12)
  orchestrator: {
    getState: (): Promise<OrchestratorState> =>
      ipcRenderer.invoke("nestbrain:orchestrator:getState"),
    refresh: (): Promise<OrchestratorState> => ipcRenderer.invoke("nestbrain:orchestrator:refresh"),
    requestTransition: (
      itemId: string,
      to: LifecycleState,
      reason?: string,
    ): Promise<OrchestratorTransitionResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:requestTransition", itemId, to, reason),
    setIntakePaused: (paused: boolean): Promise<OrchestratorState> =>
      ipcRenderer.invoke("nestbrain:orchestrator:setIntakePaused", paused),
    updateSettings: (patch: { codingWipPerRepo?: number }): Promise<OrchestratorState> =>
      ipcRenderer.invoke("nestbrain:orchestrator:updateSettings", patch),
    setRepoSettings: (
      owner: string,
      name: string,
      patch: Partial<RepoIntakeSettings>,
    ): Promise<OrchestratorState> =>
      ipcRenderer.invoke("nestbrain:orchestrator:setRepoSettings", owner, name, patch),
    listRepoSettings: (): Promise<RepoSettingsRow[]> =>
      ipcRenderer.invoke("nestbrain:orchestrator:listRepoSettings"),
    listFollowCandidates: (accountId?: string): Promise<FollowCandidatesResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:listFollowCandidates", accountId),
    resolveResumeRite: (action: ResumeRiteAction, itemIds?: string[]): Promise<OrchestratorState> =>
      ipcRenderer.invoke("nestbrain:orchestrator:resolveResumeRite", action, itemIds),
    setPinned: (itemId: string, pinned: boolean): Promise<OrchestratorTransitionResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:setPinned", itemId, pinned),
    linkRepo: (owner: string, name: string, localPath: string): Promise<RepoLinkResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:linkRepo", owner, name, localPath),
    cloneRepo: (
      owner: string,
      name: string,
      destParent: string,
      accountId?: string,
    ): Promise<RepoLinkResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:cloneRepo", owner, name, destParent, accountId),
    unlinkRepo: (owner: string, name: string): Promise<RepoUnlinkResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:unlinkRepo", owner, name),
    listRepos: (): Promise<ListReposResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:listRepos"),
    getPlan: (itemId: string): Promise<StoredPlan | null> =>
      ipcRenderer.invoke("nestbrain:orchestrator:getPlan", itemId),
    updatePlan: (itemId: string, plan: IssuePlan): Promise<UpdatePlanResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:updatePlan", itemId, plan),
    openPr: (itemId: string): Promise<OrchestratorTransitionResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:openPr", itemId),
    getWorktreeChanges: (itemId: string): Promise<WorktreeChangesResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:getWorktreeChanges", itemId),
    readWorktreeFile: (itemId: string, path: string, oldPath?: string): Promise<WorktreeFileResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:readWorktreeFile", itemId, path, oldPath),
    saveWorktreeFile: (itemId: string, path: string, content: string): Promise<SaveWorktreeFileResult> =>
      ipcRenderer.invoke("nestbrain:orchestrator:saveWorktreeFile", itemId, path, content),
    onStateChanged: (callback: (state: OrchestratorState) => void) => {
      const handler = (_e: unknown, state: OrchestratorState) => callback(state);
      ipcRenderer.on("nestbrain:orchestrator:stateChanged", handler);
      return () => ipcRenderer.off("nestbrain:orchestrator:stateChanged", handler);
    },
  },

  // Coding runner (issue #9): per-item progress stream + replay buffer.
  coding: {
    getEvents: (itemId: string): Promise<unknown[]> =>
      ipcRenderer.invoke("nestbrain:coding:getEvents", itemId),
    onEvent: (itemId: string, callback: (envelope: unknown) => void) => {
      const channel = `nestbrain:coding:event:${itemId}`;
      const handler = (_e: unknown, envelope: unknown) => callback(envelope);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
  },

  // Planner console (issue #32): same shape as coding, own channel pair.
  planning: {
    getEvents: (itemId: string): Promise<unknown[]> =>
      ipcRenderer.invoke("nestbrain:planning:getEvents", itemId),
    onEvent: (itemId: string, callback: (envelope: unknown) => void) => {
      const channel = `nestbrain:planning:event:${itemId}`;
      const handler = (_e: unknown, envelope: unknown) => callback(envelope);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
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
