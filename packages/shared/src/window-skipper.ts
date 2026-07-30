import type { AgentRuntimeId, AuthProviderId, AuthProviderMeta, AuthState } from "./types";
import type {
  ArchiveItemResult,
  CleanWorktreeResult,
  CloseItemOnTrackerResult,
  CreateIssueOnTrackerParams,
  CreateIssueOnTrackerResult,
  FollowCandidatesResult,
  LifecycleState,
  ListRepoBranchesResult,
  ListReposResult,
  OrchestratorSettings,
  OrchestratorState,
  OrchestratorTransitionResult,
  PrReviewComment,
  RegenerateRepoInstructionsResult,
  GetRepoGraphifyResult,
  ReindexRepoGraphifyResult,
  RepoIntakeSettings,
  RepoLinkResult,
  RepoSettingsRow,
  RepoUnlinkResult,
  ResumeRiteAction,
  SaveWorktreeFileResult,
  SetRepoBaseBranchResult,
  GetRepoInstructionsResult,
  SetRepoInstructionsResult,
  TrackerProjectsResult,
  UntrackItemResult,
  UpdatePlanResult,
  WorktreeChangesResult,
  WorktreeDiffResult,
  WorktreeFileResult,
  WorktreeStatusResult,
} from "./orchestrator";
import type { CodingEventEnvelope } from "./coding";
import type {
  ComposerChatSnapshot,
  ComposerDraft,
  ComposerDraftListItem,
  ComposerEditedFlags,
  ComposerSelfLogin,
  GenerateComposerDraftResult,
  ResumeComposerChatResult,
  SaveComposerDraftResult,
  SendComposerChatResult,
  StartComposerChatResult,
} from "./composer";
import type { AgentChatKind, IssuePlan, PlanChatMessage, StoredPlan } from "./plan";
import type { MemoryHit, MemoryPhase, SolutionRecord } from "./memory";
import type { StoredCoderReport } from "./coder-report";
import type { RepoRef } from "./inbox";
import type { AppSettings, AppSettingsPatch } from "./settings";

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

/** Which agent CLIs are reachable right now (#287) — probed per call against the
 *  main process' PATH, so a CLI installed mid-session shows up after a restart. */
export type RuntimeAvailability = Record<AgentRuntimeId, boolean>;

/** Markdown export save-dialog result (#216). canceled = user dismissed the dialog. */
export type SaveMarkdownResult = { ok: true; canceled?: boolean } | { ok: false; error: string };

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
  /** App settings (settings.json) — moved off the embedded server onto IPC (#208).
   *  `get` returns the openaiApiKey masked; `set` merges a patch and persists. */
  settings: {
    get: () => Promise<AppSettings>;
    set: (patch: AppSettingsPatch) => Promise<{ ok: boolean }>;
  };
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
    signIn: (provider: AuthProviderId, options?: { baseUrl?: string; clientId?: string }) => Promise<void>;
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
    /** Per-repo agent instructions (#227) — Skipper-owned conventions doc. */
    getRepoInstructions: (owner: string, name: string) => Promise<GetRepoInstructionsResult>;
    setRepoInstructions: (
      owner: string,
      name: string,
      content: string,
    ) => Promise<SetRepoInstructionsResult>;
    regenerateRepoInstructions: (
      owner: string,
      name: string,
    ) => Promise<RegenerateRepoInstructionsResult>;
    /** Per-repo Graphify knowledge-graph index (#233). */
    getRepoGraphify: (owner: string, name: string) => Promise<GetRepoGraphifyResult>;
    reindexRepoGraphify: (owner: string, name: string) => Promise<ReindexRepoGraphifyResult>;
    listRepos: () => Promise<ListReposResult>;
    listRepoBranches: (owner: string, name: string) => Promise<ListRepoBranchesResult>;
    getPlan: (itemId: string) => Promise<StoredPlan | null>;
    getCoderReport: (itemId: string) => Promise<StoredCoderReport | null>;
    updatePlan: (itemId: string, plan: IssuePlan) => Promise<UpdatePlanResult>;
    openPr: (itemId: string) => Promise<OrchestratorTransitionResult>;
    archiveItem: (itemId: string, force?: boolean) => Promise<ArchiveItemResult>;
    untrackItem: (itemId: string, force?: boolean) => Promise<UntrackItemResult>;
    closeItemOnTracker: (itemId: string) => Promise<CloseItemOnTrackerResult>;
    createIssueOnTracker: (
      params: CreateIssueOnTrackerParams,
    ) => Promise<CreateIssueOnTrackerResult>;
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
    getWorktreeDiff: (itemId: string) => Promise<WorktreeDiffResult>;
    cleanWorktree: (itemId: string) => Promise<CleanWorktreeResult>;
    onStateChanged: (callback: (state: OrchestratorState) => void) => () => void;
  };
  /** Markdown export (#216): save an artifact/dossier to a user-chosen .md file. */
  export: {
    saveMarkdown: (defaultFilename: string, content: string) => Promise<SaveMarkdownResult>;
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
    /** Abort the in-flight turn (#260): send resolves { ok: false, cancelled: true }
     *  and nothing is persisted — the transcript is untouched. No-op when idle. */
    cancel: (itemId: string) => Promise<void>;
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
    /** Coder-only (#188): distill the discussion into re-entry instructions for a preview. */
    prepareApply: (
      itemId: string,
    ) => Promise<
      | { ok: true; instructions: PrReviewComment[] }
      | { ok: false; error?: string; cancelled?: boolean }
    >;
    /** Coder-only (#188): commit the previewed instructions — transitions the item to coding. */
    confirmApply: (
      itemId: string,
      instructions: PrReviewComment[],
    ) => Promise<{ ok: true } | { ok: false; error?: string }>;
    /** Abort the in-flight turn (#260): send resolves { ok: false, cancelled: true }
     *  and nothing is persisted — the transcript is untouched. No-op when idle. */
    cancel: (kind: AgentChatKind, itemId: string) => Promise<void>;
  };
  /** Chat composer (#136): a repo-grounded chat that distills into an issue draft.
   *  A chat lives in main's memory until dispose or quit unless it is promoted to
   *  a saved draft (#138), which survives both. */
  composer: {
    start: (repo: RepoRef) => Promise<StartComposerChatResult>;
    send: (repo: RepoRef, chatId: string, text: string) => Promise<SendComposerChatResult>;
    getChat: (repo: RepoRef, chatId: string) => Promise<ComposerChatSnapshot | null>;
    /** Explicit distillation of the discussion into the structured draft. */
    generateDraft: (repo: RepoRef, chatId: string) => Promise<GenerateComposerDraftResult>;
    /** Push the renderer's edits so the next send/distill prompt carries them. */
    updateDraft: (
      repo: RepoRef,
      chatId: string,
      draft: ComposerDraft,
      editedFlags: ComposerEditedFlags,
    ) => Promise<{ ok: boolean; error?: string }>;
    /** Abort the in-flight turn: send/generateDraft resolve cancelled, nothing is recorded. */
    cancel: (repo: RepoRef, chatId: string) => Promise<void>;
    /** Drop the chat record (view unmount). A promoted chat leaves its file
     *  behind; an unpromoted one is auto-saved as an unfinished draft (#272)
     *  unless `discard` says its content is deliberately gone. */
    dispose: (repo: RepoRef, chatId: string, opts?: { discard?: boolean }) => Promise<void>;
    /** Promote the chat to a saved draft — from here on every turn re-persists it. */
    saveDraft: (repo: RepoRef, chatId: string) => Promise<SaveComposerDraftResult>;
    /** Rehydrate a saved draft into a live chat; the returned id replaces start's. */
    resume: (repo: RepoRef, draftId: string) => Promise<ResumeComposerChatResult>;
    /** The account's provider username, for the self-assign toggle. */
    getSelfLogin: (accountId: string) => Promise<ComposerSelfLogin>;
    getEvents: (key: string) => Promise<CodingEventEnvelope[]>;
    onEvent: (key: string, callback: (envelope: CodingEventEnvelope) => void) => () => void;
  };
  /** Saved composer drafts (#138): pre-issue and temporary — deleted on publish. */
  drafts: {
    list: () => Promise<ComposerDraftListItem[]>;
    remove: (draftId: string) => Promise<{ ok: boolean; error?: string }>;
    onChanged: (callback: () => void) => () => void;
  };
  /** Reviewer progress stream (#113). */
  review: {
    getEvents: (itemId: string) => Promise<CodingEventEnvelope[]>;
    onEvent: (itemId: string, callback: (envelope: CodingEventEnvelope) => void) => () => void;
  };
  /** Solutions memory — "memories used" card + 👍/👎 (#46), Memory tab (#255). */
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
    /** Result object rather than a throw: the first search of a session may
     * download the embedding model and fail offline — the renderer offers a retry. */
    search: (
      repo: RepoRef,
      query: string,
      k?: number,
    ) => Promise<{ ok: true; hits: MemoryHit[] } | { ok: false; error: string }>;
    curate: (id: string, vote: "up" | "down" | null) => Promise<{ ok: boolean; error?: string }>;
    createNote: (
      repo: RepoRef,
      body: string,
      files?: string[],
      title?: string,
    ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    updateNote: (
      id: string,
      body: string,
      files?: string[],
      title?: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    repoFiles: (repo: RepoRef) => Promise<{ ok: true; files: string[] } | { ok: false; error: string }>;
    /** "Keep" a prune candidate — hides it from the review queue for 90 days (#256). */
    dismissReview: (id: string) => Promise<{ ok: boolean; error?: string }>;
    /** Backfill lessons for every lesson-less captured solution of a repo (#256). */
    distill: (
      repo: RepoRef,
    ) => Promise<
      { ok: true; distilled: number; failed: number; remaining: number } | { ok: false; error: string }
    >;
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
  runtimes: {
    status: () => Promise<RuntimeAvailability>;
  };
}
