export {};

import type {
  ArchiveItemResult,
  AuthProviderId,
  AuthProviderMeta,
  AuthState,
  CodingEventEnvelope,
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

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface GitOpResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface CreateTerminalResult {
  id: string;
  cwd: string;
}

declare global {
  interface UpdateState {
    status: "disabled" | "dev" | "idle" | "checking" | "downloading" | "ready" | "error";
    current: string;
    available?: string;
    percent?: number;
    error?: string;
    via?: "account" | "build";
  }

  interface Window {
    skipper?: {
      isElectron: true;
      platform: NodeJS.Platform;
      getBootstrap: () => Promise<{
        isElectron: true;
        platform: NodeJS.Platform;
      }>;
      selectDirectory: () => Promise<string | null>;
      session: {
        run: (
          mode: "save" | "resume",
          projectDir: string,
        ) => Promise<{ ok: boolean; output: string }>;
      };
      /** Resolve a DOM File to its absolute filesystem path (drag-drop). */
      getPathForFile: (file: File) => string;
      fs: {
        list: (dirPath: string) => Promise<FsEntry[]>;
        createDir: (dirPath: string) => Promise<{ ok: true; path: string }>;
        readFile: (filePath: string) => Promise<{
          content: string;
          size: number;
          binary: boolean;
          tooLarge: boolean;
        }>;
        writeFile: (
          filePath: string,
          content: string,
        ) => Promise<{ ok: true; size: number }>;
        delete: (targetPath: string) => Promise<{ ok: true }>;
        rename: (
          oldPath: string,
          newName: string,
        ) => Promise<{ ok: true; newPath: string }>;
        onChange: (callback: () => void) => () => void;
      };
      auth: {
        getState: () => Promise<AuthState>;
        getProviders: () => Promise<AuthProviderMeta[]>;
        signIn: (provider: AuthProviderId, options?: { baseUrl?: string }) => Promise<void>;
        signInWithPat: (
          provider: AuthProviderId,
          pat: string,
          options?: { baseUrl?: string },
        ) => Promise<void>;
        signOut: (provider: AuthProviderId, accountId: string) => Promise<void>;
        cancelSignIn: (provider: AuthProviderId) => Promise<void>;
        chooseResource: (provider: AuthProviderId, resourceId: string) => Promise<void>;
        onStateChanged: (callback: (state: AuthState) => void) => () => void;
      };
      openExternal: (url: string) => Promise<void>;
      onShowAbout: (callback: () => void) => () => void;
      terminal: {
        create: (opts: { cwd: string; cols?: number; rows?: number }) => Promise<CreateTerminalResult>;
        write: (id: string, data: string) => void;
        resize: (id: string, cols: number, rows: number) => void;
        kill: (id: string) => void;
        onData: (id: string, callback: (data: string) => void) => () => void;
        onExit: (id: string, callback: (code: number) => void) => () => void;
      };
      git: {
        status: (repoPath: string) => Promise<{
          branch: string;
          ahead: number;
          behind: number;
          files: Record<string, { index: string; worktree: string }>;
          hasUpstream: boolean;
        } | null>;
        findRepo: (anyPath: string) => Promise<{
          repoPath: string;
          status: {
            branch: string;
            ahead: number;
            behind: number;
            files: Record<string, { index: string; worktree: string }>;
            hasUpstream: boolean;
          };
        } | null>;
        stage: (repoPath: string, paths: string[]) => Promise<GitOpResult>;
        unstage: (repoPath: string, paths: string[]) => Promise<GitOpResult>;
        discard: (repoPath: string, paths: string[]) => Promise<GitOpResult>;
        commit: (repoPath: string, message: string) => Promise<GitOpResult>;
        push: (repoPath: string) => Promise<GitOpResult>;
        pull: (repoPath: string) => Promise<GitOpResult>;
        stashList: (
          repoPath: string,
        ) => Promise<GitOpResult & { stashes: { ref: string; message: string }[] }>;
        stashPush: (
          repoPath: string,
          message?: string,
          includeUntracked?: boolean,
        ) => Promise<GitOpResult>;
        stashPop: (repoPath: string, ref?: string) => Promise<GitOpResult>;
        stashDrop: (repoPath: string, ref: string) => Promise<GitOpResult>;
      };
      orchestrator: {
        getState: () => Promise<OrchestratorState>;
        refresh: () => Promise<OrchestratorState>;
        requestTransition: (
          itemId: string,
          to: LifecycleState,
          reason?: string,
        ) => Promise<OrchestratorTransitionResult>;
        setIntakePaused: (paused: boolean) => Promise<OrchestratorState>;
        updateSettings: (patch: Partial<OrchestratorSettings>) => Promise<OrchestratorState>;
        setRepoSettings: (
          owner: string,
          name: string,
          patch: Partial<RepoIntakeSettings>,
        ) => Promise<OrchestratorState>;
        listRepoSettings: () => Promise<RepoSettingsRow[]>;
        setProjectMapping: (
          mappingKey: string,
          repo: string | null,
        ) => Promise<OrchestratorState>;
        listTrackerProjects: (accountId: string) => Promise<TrackerProjectsResult>;
        listFollowCandidates: (
          accountId?: string,
          providerId?: AuthProviderId,
        ) => Promise<FollowCandidatesResult>;
        resolveResumeRite: (
          action: ResumeRiteAction,
          itemIds?: string[],
        ) => Promise<OrchestratorState>;
        setPinned: (itemId: string, pinned: boolean) => Promise<OrchestratorTransitionResult>;
        linkRepo: (owner: string, name: string, localPath: string) => Promise<RepoLinkResult>;
        cloneRepo: (
          owner: string,
          name: string,
          destParent: string,
          accountId?: string,
        ) => Promise<RepoLinkResult>;
        unlinkRepo: (owner: string, name: string) => Promise<RepoUnlinkResult>;
        listRepos: () => Promise<ListReposResult>;
        getPlan: (itemId: string) => Promise<StoredPlan | null>;
        updatePlan: (itemId: string, plan: IssuePlan) => Promise<UpdatePlanResult>;
        openPr: (itemId: string) => Promise<OrchestratorTransitionResult>;
        archiveItem: (itemId: string, force?: boolean) => Promise<ArchiveItemResult>;
        getWorktreeChanges: (itemId: string) => Promise<WorktreeChangesResult>;
        readWorktreeFile: (
          itemId: string,
          path: string,
          oldPath?: string,
        ) => Promise<WorktreeFileResult>;
        saveWorktreeFile: (
          itemId: string,
          path: string,
          content: string,
        ) => Promise<SaveWorktreeFileResult>;
        getWorktreeStatus: (itemId: string) => Promise<WorktreeStatusResult>;
        onStateChanged: (callback: (state: OrchestratorState) => void) => () => void;
      };
      /** Coding runner progress stream (#9). */
      coding: {
        getEvents: (itemId: string) => Promise<CodingEventEnvelope[]>;
        onEvent: (itemId: string, callback: (envelope: CodingEventEnvelope) => void) => () => void;
      };
      /** Planner progress stream (#32). */
      planning: {
        getEvents: (itemId: string) => Promise<CodingEventEnvelope[]>;
        onEvent: (itemId: string, callback: (envelope: CodingEventEnvelope) => void) => () => void;
      };
      /** Reviewer progress stream (#113). */
      review: {
        getEvents: (itemId: string) => Promise<CodingEventEnvelope[]>;
        onEvent: (itemId: string, callback: (envelope: CodingEventEnvelope) => void) => () => void;
      };
      /** Solutions memory — "memories used" card + 👍/👎 (#46). */
      memory: {
        get: (id: string) => Promise<SolutionRecord | null>;
        list: (repo: RepoRef) => Promise<SolutionRecord[]>;
        feedback: (
          itemId: string,
          phase: MemoryPhase,
          id: string,
          vote: "up" | "down" | null,
        ) => Promise<{ ok: boolean; error?: string }>;
        delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      };
      updates: {
        getState: () => Promise<UpdateState>;
        check: () => Promise<UpdateState>;
        restart: () => Promise<void>;
        onStateChanged: (callback: (state: UpdateState) => void) => () => void;
      };
      cli: {
        status: () => Promise<{
          supported: boolean;
          target: string | null;
          source: string;
          installed: boolean;
          stale: boolean;
        }>;
        install: () => Promise<{
          supported: boolean;
          target: string | null;
          source: string;
          installed: boolean;
          stale: boolean;
        }>;
        uninstall: () => Promise<{
          supported: boolean;
          target: string | null;
          source: string;
          installed: boolean;
          stale: boolean;
        }>;
      };
    };
  }
}
