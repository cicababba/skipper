import type { AuthProviderId, AuthProviderMeta, AuthState } from "./types";
import type {
  ArchiveItemResult,
  FollowCandidatesResult,
  LifecycleState,
  ListRepoBranchesResult,
  ListReposResult,
  OrchestratorSettings,
  OrchestratorState,
  OrchestratorTransitionResult,
  RepoIntakeSettings,
  RepoLinkResult,
  RepoSettingsRow,
  RepoUnlinkResult,
  ResumeRiteAction,
  SaveWorktreeFileResult,
  SetRepoBaseBranchResult,
  TrackerProjectsResult,
  UntrackItemResult,
  UpdatePlanResult,
  WorktreeChangesResult,
  WorktreeFileResult,
  WorktreeStatusResult,
} from "./orchestrator";
import type { CodingEventEnvelope } from "./coding";
import type { AgentChatKind, IssuePlan, PlanChatMessage, StoredPlan } from "./plan";
import type { MemoryPhase, SolutionRecord } from "./memory";
import type { StoredCoderReport } from "./coder-report";
import type { RepoRef } from "./inbox";

// Single source of truth for the Electron preload bridge (`window.skipper`).
// The preload declares `... satisfies WindowSkipper` and the renderer's global
// augmentation points `Window["skipper"]` at this interface, so any drift on
// either side is a build error. Payload DTOs come from the concrete sibling
// modules above; the helper types below cover the bridge-only shapes.

/** `process.platform` values, spelled out because shared has no @types/node. */
export type SkipperPlatform =
  | "aix"
  | "android"
  | "cygwin"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "netbsd"
  | "openbsd"
  | "sunos"
  | "win32";

interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
}

/**
 * The DOM `File` type where a DOM lib is present (web renderer, Electron
 * preload), falling back to a structural `FileLike` inside shared's own
 * lib-less compile.
 */
export type NativeFile = typeof globalThis extends { File: { prototype: infer F } } ? F : FileLike;

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface GitOpResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface CreateTerminalResult {
  id: string;
  cwd: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: Record<string, { index: string; worktree: string }>;
  hasUpstream: boolean;
}

export interface CliStatus {
  supported: boolean;
  target: string | null;
  source: string;
  installed: boolean;
  /** True when target exists but points at the wrong place (e.g. app moved). */
  stale: boolean;
}

export interface UpdateState {
  /** Why the updater is or isn't running. */
  status: "disabled" | "dev" | "idle" | "checking" | "downloading" | "ready" | "error";
  /** Running app version. */
  current: string;
  /** Newest version known from the feed (when found). */
  available?: string;
  /** Download progress 0..100 while status === "downloading". */
  percent?: number;
  error?: string;
  /** Strongest entitlement attached to the last check. */
  via?: "account" | "build";
}

export interface WindowSkipper {
  isElectron: true;
  platform: SkipperPlatform;
  getBootstrap: () => Promise<{
    isElectron: true;
    platform: SkipperPlatform;
  }>;
  selectDirectory: () => Promise<string | null>;
  session: {
    run: (
      mode: "save" | "resume",
      projectDir: string,
    ) => Promise<{ ok: boolean; output: string }>;
  };
  /** Resolve a DOM File to its absolute filesystem path (drag-drop). */
  getPathForFile: (file: NativeFile) => string;
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
    status: (repoPath: string) => Promise<GitStatus | null>;
    findRepo: (anyPath: string) => Promise<{ repoPath: string; status: GitStatus } | null>;
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
    refresh: (full?: boolean) => Promise<OrchestratorState>;
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
    linkRepo: (
      owner: string,
      name: string,
      localPath: string,
      baseBranch?: string,
    ) => Promise<RepoLinkResult>;
    cloneRepo: (
      owner: string,
      name: string,
      destParent: string,
      accountId?: string,
      baseBranch?: string,
    ) => Promise<RepoLinkResult>;
    inspectLinkTarget: (
      owner: string,
      name: string,
      localPath: string,
    ) => Promise<ListRepoBranchesResult>;
    listRemoteBranches: (
      owner: string,
      name: string,
      accountId?: string,
    ) => Promise<ListRepoBranchesResult>;
    unlinkRepo: (owner: string, name: string) => Promise<RepoUnlinkResult>;
    setRepoBaseBranch: (
      owner: string,
      name: string,
      baseBranch: string | null,
    ) => Promise<SetRepoBaseBranchResult>;
    listRepos: () => Promise<ListReposResult>;
    listRepoBranches: (owner: string, name: string) => Promise<ListRepoBranchesResult>;
    getPlan: (itemId: string) => Promise<StoredPlan | null>;
    getCoderReport: (itemId: string) => Promise<StoredCoderReport | null>;
    updatePlan: (itemId: string, plan: IssuePlan) => Promise<UpdatePlanResult>;
    openPr: (itemId: string) => Promise<OrchestratorTransitionResult>;
    archiveItem: (itemId: string, force?: boolean) => Promise<ArchiveItemResult>;
    untrackItem: (itemId: string, force?: boolean) => Promise<UntrackItemResult>;
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
  /** Conversational plan review (#145): chat with the planning session at the gate. */
  planChat: {
    send: (
      itemId: string,
      text: string,
    ) => Promise<
      { ok: true; reply: string } | { ok: false; error?: string; cancelled?: boolean }
    >;
    apply: (
      itemId: string,
    ) => Promise<
      { ok: true; stored: StoredPlan } | { ok: false; error?: string; cancelled?: boolean }
    >;
    getHistory: (itemId: string) => Promise<PlanChatMessage[]>;
  };
  /** Per-tab agent chat (#170): interrogate the coder / reviewer at their tabs. */
  agentChat: {
    send: (
      kind: AgentChatKind,
      itemId: string,
      text: string,
      ctx?: { selectedFile?: string },
    ) => Promise<
      | { ok: true; reply: string; mode: "resumed" | "fresh" }
      | { ok: false; error?: string; cancelled?: boolean }
    >;
    getHistory: (kind: AgentChatKind, itemId: string) => Promise<PlanChatMessage[]>;
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
    status: () => Promise<CliStatus>;
    install: () => Promise<CliStatus>;
    uninstall: () => Promise<CliStatus>;
  };
}
