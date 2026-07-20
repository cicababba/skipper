import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  ArchiveItemResult,
  AuthProviderId,
  AuthProviderMeta,
  AuthState,
  IssuePlan,
  LifecycleState,
  FollowCandidatesResult,
  ListReposResult,
  MemoryPhase,
  OrchestratorSettings,
  OrchestratorState,
  OrchestratorTransitionResult,
  RepoIntakeSettings,
  RepoLinkResult,
  RepoRef,
  RepoSettingsRow,
  RepoUnlinkResult,
  ResumeRiteAction,
  SaveWorktreeFileResult,
  SolutionRecord,
  StoredPlan,
  TrackerProjectsResult,
  UpdatePlanResult,
  WorktreeChangesResult,
  WorktreeFileResult,
  WorktreeStatusResult,
} from "@skipper/shared";

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

contextBridge.exposeInMainWorld("skipper", {
  isElectron: true,
  platform: process.platform,

  getBootstrap: () => ipcRenderer.invoke("skipper:getBootstrap"),
  selectDirectory: () => ipcRenderer.invoke("skipper:selectDirectory"),

  session: {
    run: (mode: "save" | "resume", projectDir: string): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke("skipper:session:run", mode, projectDir),
  },

  // File system
  fs: {
    list: (dirPath: string): Promise<FsEntry[]> =>
      ipcRenderer.invoke("skipper:fs:list", dirPath),
    createDir: (dirPath: string): Promise<{ ok: true; path: string }> =>
      ipcRenderer.invoke("skipper:fs:createDir", dirPath),
    readFile: (filePath: string): Promise<{
      content: string;
      size: number;
      binary: boolean;
      tooLarge: boolean;
    }> => ipcRenderer.invoke("skipper:fs:readFile", filePath),
    writeFile: (
      filePath: string,
      content: string,
    ): Promise<{ ok: true; size: number }> =>
      ipcRenderer.invoke("skipper:fs:writeFile", filePath, content),
    delete: (targetPath: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke("skipper:fs:delete", targetPath),
    rename: (
      oldPath: string,
      newName: string,
    ): Promise<{ ok: true; newPath: string }> =>
      ipcRenderer.invoke("skipper:fs:rename", oldPath, newName),
    onChange: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on("skipper:fs:changed", handler);
      return () => ipcRenderer.off("skipper:fs:changed", handler);
    },
  },

  // Auth (multi-provider OAuth)
  auth: {
    getState: (): Promise<AuthState> =>
      ipcRenderer.invoke("skipper:auth:getState"),
    getProviders: (): Promise<AuthProviderMeta[]> =>
      ipcRenderer.invoke("skipper:auth:getProviders"),
    signIn: (provider: AuthProviderId, options?: { baseUrl?: string }): Promise<void> =>
      ipcRenderer.invoke(`skipper:auth:${provider}:signIn`, options),
    signInWithPat: (provider: AuthProviderId, pat: string, options?: { baseUrl?: string }): Promise<void> =>
      ipcRenderer.invoke(`skipper:auth:${provider}:signInWithPat`, pat, options),
    signOut: (provider: AuthProviderId, accountId: string): Promise<void> =>
      ipcRenderer.invoke(`skipper:auth:${provider}:signOut`, accountId),
    cancelSignIn: (provider: AuthProviderId): Promise<void> =>
      ipcRenderer.invoke(`skipper:auth:${provider}:cancelSignIn`),
    chooseResource: (provider: AuthProviderId, resourceId: string): Promise<void> =>
      ipcRenderer.invoke(`skipper:auth:${provider}:chooseResource`, resourceId),
    onStateChanged: (callback: (state: AuthState) => void) => {
      const handler = (_e: unknown, state: AuthState) => callback(state);
      ipcRenderer.on("skipper:auth:stateChanged", handler);
      return () => ipcRenderer.off("skipper:auth:stateChanged", handler);
    },
  },

  // Orchestrator (issue #6 wiring; typed surface consumed by the inbox UI, #12)
  orchestrator: {
    getState: (): Promise<OrchestratorState> =>
      ipcRenderer.invoke("skipper:orchestrator:getState"),
    refresh: (): Promise<OrchestratorState> => ipcRenderer.invoke("skipper:orchestrator:refresh"),
    requestTransition: (
      itemId: string,
      to: LifecycleState,
      reason?: string,
    ): Promise<OrchestratorTransitionResult> =>
      ipcRenderer.invoke("skipper:orchestrator:requestTransition", itemId, to, reason),
    setIntakePaused: (paused: boolean): Promise<OrchestratorState> =>
      ipcRenderer.invoke("skipper:orchestrator:setIntakePaused", paused),
    updateSettings: (patch: Partial<OrchestratorSettings>): Promise<OrchestratorState> =>
      ipcRenderer.invoke("skipper:orchestrator:updateSettings", patch),
    setRepoSettings: (
      owner: string,
      name: string,
      patch: Partial<RepoIntakeSettings>,
    ): Promise<OrchestratorState> =>
      ipcRenderer.invoke("skipper:orchestrator:setRepoSettings", owner, name, patch),
    listRepoSettings: (): Promise<RepoSettingsRow[]> =>
      ipcRenderer.invoke("skipper:orchestrator:listRepoSettings"),
    setProjectMapping: (mappingKey: string, repo: string | null): Promise<OrchestratorState> =>
      ipcRenderer.invoke("skipper:orchestrator:setProjectMapping", mappingKey, repo),
    listTrackerProjects: (accountId: string): Promise<TrackerProjectsResult> =>
      ipcRenderer.invoke("skipper:orchestrator:listTrackerProjects", accountId),
    listFollowCandidates: (
      accountId?: string,
      providerId?: AuthProviderId,
    ): Promise<FollowCandidatesResult> =>
      ipcRenderer.invoke("skipper:orchestrator:listFollowCandidates", accountId, providerId),
    resolveResumeRite: (action: ResumeRiteAction, itemIds?: string[]): Promise<OrchestratorState> =>
      ipcRenderer.invoke("skipper:orchestrator:resolveResumeRite", action, itemIds),
    setPinned: (itemId: string, pinned: boolean): Promise<OrchestratorTransitionResult> =>
      ipcRenderer.invoke("skipper:orchestrator:setPinned", itemId, pinned),
    linkRepo: (owner: string, name: string, localPath: string): Promise<RepoLinkResult> =>
      ipcRenderer.invoke("skipper:orchestrator:linkRepo", owner, name, localPath),
    cloneRepo: (
      owner: string,
      name: string,
      destParent: string,
      accountId?: string,
    ): Promise<RepoLinkResult> =>
      ipcRenderer.invoke("skipper:orchestrator:cloneRepo", owner, name, destParent, accountId),
    unlinkRepo: (owner: string, name: string): Promise<RepoUnlinkResult> =>
      ipcRenderer.invoke("skipper:orchestrator:unlinkRepo", owner, name),
    listRepos: (): Promise<ListReposResult> =>
      ipcRenderer.invoke("skipper:orchestrator:listRepos"),
    getPlan: (itemId: string): Promise<StoredPlan | null> =>
      ipcRenderer.invoke("skipper:orchestrator:getPlan", itemId),
    updatePlan: (itemId: string, plan: IssuePlan): Promise<UpdatePlanResult> =>
      ipcRenderer.invoke("skipper:orchestrator:updatePlan", itemId, plan),
    openPr: (itemId: string): Promise<OrchestratorTransitionResult> =>
      ipcRenderer.invoke("skipper:orchestrator:openPr", itemId),
    archiveItem: (itemId: string, force?: boolean): Promise<ArchiveItemResult> =>
      ipcRenderer.invoke("skipper:orchestrator:archiveItem", itemId, force),
    getWorktreeChanges: (itemId: string): Promise<WorktreeChangesResult> =>
      ipcRenderer.invoke("skipper:orchestrator:getWorktreeChanges", itemId),
    readWorktreeFile: (itemId: string, path: string, oldPath?: string): Promise<WorktreeFileResult> =>
      ipcRenderer.invoke("skipper:orchestrator:readWorktreeFile", itemId, path, oldPath),
    saveWorktreeFile: (itemId: string, path: string, content: string): Promise<SaveWorktreeFileResult> =>
      ipcRenderer.invoke("skipper:orchestrator:saveWorktreeFile", itemId, path, content),
    getWorktreeStatus: (itemId: string): Promise<WorktreeStatusResult> =>
      ipcRenderer.invoke("skipper:orchestrator:getWorktreeStatus", itemId),
    onStateChanged: (callback: (state: OrchestratorState) => void) => {
      const handler = (_e: unknown, state: OrchestratorState) => callback(state);
      ipcRenderer.on("skipper:orchestrator:stateChanged", handler);
      return () => ipcRenderer.off("skipper:orchestrator:stateChanged", handler);
    },
  },

  // Coding runner (issue #9): per-item progress stream + replay buffer.
  coding: {
    getEvents: (itemId: string): Promise<unknown[]> =>
      ipcRenderer.invoke("skipper:coding:getEvents", itemId),
    onEvent: (itemId: string, callback: (envelope: unknown) => void) => {
      const channel = `skipper:coding:event:${itemId}`;
      const handler = (_e: unknown, envelope: unknown) => callback(envelope);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
  },

  // Planner console (issue #32): same shape as coding, own channel pair.
  planning: {
    getEvents: (itemId: string): Promise<unknown[]> =>
      ipcRenderer.invoke("skipper:planning:getEvents", itemId),
    onEvent: (itemId: string, callback: (envelope: unknown) => void) => {
      const channel = `skipper:planning:event:${itemId}`;
      const handler = (_e: unknown, envelope: unknown) => callback(envelope);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
  },

  // Reviewer console (issue #113): same shape as coding/planning, own channel pair.
  review: {
    getEvents: (itemId: string): Promise<unknown[]> =>
      ipcRenderer.invoke("skipper:review:getEvents", itemId),
    onEvent: (itemId: string, callback: (envelope: unknown) => void) => {
      const channel = `skipper:review:event:${itemId}`;
      const handler = (_e: unknown, envelope: unknown) => callback(envelope);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
  },

  // Solutions memory (issue #46): the "memories used" card reads records + votes.
  memory: {
    get: (id: string): Promise<SolutionRecord | null> =>
      ipcRenderer.invoke("skipper:memory:get", id),
    list: (repo: RepoRef): Promise<SolutionRecord[]> =>
      ipcRenderer.invoke("skipper:memory:list", repo),
    feedback: (
      itemId: string,
      phase: MemoryPhase,
      id: string,
      vote: "up" | "down" | null,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("skipper:memory:feedback", itemId, phase, id, vote),
    delete: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("skipper:memory:delete", id),
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("skipper:openExternal", url),
  onShowAbout: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("skipper:show-about", handler);
    return () => ipcRenderer.off("skipper:show-about", handler);
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
    } | null> => ipcRenderer.invoke("skipper:git:status", repoPath),
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
    } | null> => ipcRenderer.invoke("skipper:git:findRepo", anyPath),
    stage: (repoPath: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:stage", repoPath, paths),
    unstage: (repoPath: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:unstage", repoPath, paths),
    discard: (repoPath: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:discard", repoPath, paths),
    commit: (repoPath: string, message: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:commit", repoPath, message),
    push: (repoPath: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:push", repoPath),
    pull: (repoPath: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:pull", repoPath),
    stashList: (
      repoPath: string,
    ): Promise<GitOpResult & { stashes: { ref: string; message: string }[] }> =>
      ipcRenderer.invoke("skipper:git:stashList", repoPath),
    stashPush: (
      repoPath: string,
      message?: string,
      includeUntracked?: boolean,
    ): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:stashPush", repoPath, message, includeUntracked),
    stashPop: (repoPath: string, ref?: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:stashPop", repoPath, ref),
    stashDrop: (repoPath: string, ref: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("skipper:git:stashDrop", repoPath, ref),
  },

  // Auto-update (official builds; inert in source builds)
  updates: {
    getState: (): Promise<unknown> => ipcRenderer.invoke("skipper:updates:getState"),
    check: (): Promise<unknown> => ipcRenderer.invoke("skipper:updates:check"),
    restart: (): Promise<void> => ipcRenderer.invoke("skipper:updates:restart"),
    onStateChanged: (callback: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => callback(state);
      ipcRenderer.on("skipper:updates:stateChanged", handler);
      return () => ipcRenderer.off("skipper:updates:stateChanged", handler);
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
    }> => ipcRenderer.invoke("skipper:cli:status"),
    install: () => ipcRenderer.invoke("skipper:cli:install"),
    uninstall: () => ipcRenderer.invoke("skipper:cli:uninstall"),
  },

  // Terminal
  terminal: {
    create: (opts: { cwd: string; cols?: number; rows?: number }): Promise<CreateTerminalResult> =>
      ipcRenderer.invoke("skipper:terminal:create", opts),
    write: (id: string, data: string) =>
      ipcRenderer.send("skipper:terminal:write", { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send("skipper:terminal:resize", { id, cols, rows }),
    kill: (id: string) => ipcRenderer.send("skipper:terminal:kill", { id }),
    onData: (id: string, callback: (data: string) => void) => {
      const channel = `skipper:terminal:data:${id}`;
      const handler = (_e: unknown, data: string) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
    onExit: (id: string, callback: (code: number) => void) => {
      const channel = `skipper:terminal:exit:${id}`;
      const handler = (_e: unknown, code: number) => callback(code);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },
  },
});
