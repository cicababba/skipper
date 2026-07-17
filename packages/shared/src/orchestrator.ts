// ============================================================
// Skipper — Orchestrator lifecycle types (issue #6)
// ============================================================

import {
  DEFAULT_CONFIDENCE_THRESHOLDS,
  DEFAULT_EXTRA_PLAN_RUNS,
  type ConfidenceThresholds,
  type CriticObjection,
  type CriticVerdict,
} from "./confidence";
import type { CodeHostId, Issue, IssueSourceId, PullRequest, RepoRef, SourceRef } from "./inbox";
import type { StoredPlan } from "./plan";

export type AgentReviewOutcome = CriticVerdict | "skipped" | "unavailable";

export interface AgentReview {
  /** Reviews performed in the current fix chain. A round = one review of one coding attempt; first review = 1. */
  rounds: number;
  outcome: AgentReviewOutcome;
  /** Skip explanation (never/auto), non-convergence note, or error message. */
  reason?: string;
  /** Full objection list from the last review (UI surface for #13). */
  objections?: CriticObjection[];
  /** Set only when the reviewer sent the item back to coding — the coder's fix-round seam. */
  pendingObjections?: CriticObjection[];
  at: string; // ISO 8601
}

/** One piece of human PR feedback — a change-request review body or an inline comment (#11). */
export interface PrReviewComment {
  author?: string;
  path?: string;
  line?: number;
  body: string;
  url?: string;
  submittedAt?: string; // ISO 8601
}

/** PR shepherding overlay (#11). */
export interface ShepherdState {
  /** Set on changes-requested re-entry (replaced wholesale each re-entry); cleared on push. */
  pendingReviewComments?: PrReviewComment[];
  /** HEAD sha of the last successful push. */
  lastPushedSha?: string;
  /** Last sha CI-failure re-entry reacted to — one reaction per push. */
  lastCiSha?: string;
  /** Consecutive CI-fix re-entries; reset when CI goes green. Capped by CI_FIX_MAX_ROUNDS. */
  ciFixRounds?: number;
  /** Solutions-memory record ref — presence means the post-merge capture ran. */
  memoryRef?: string;
}

/** After this many consecutive CI-fix rounds the item parks for a human. */
export const CI_FIX_MAX_ROUNDS = 2;

/** Lifecycle states from docs/DIRECTION.md ("Il ciclo di vita"). */
export type LifecycleState =
  | "triage"
  | "planning"
  | "plan-gate"
  | "queued"
  | "coding"
  | "agent-review"
  | "human-review"
  | "pr-open"
  | "in-review"
  | "changes-requested"
  | "merged"
  | "needs-input"
  | "blocked"
  | "failed"
  | "closed";

/** Who drove a transition. planner/coder/reviewer/shepherd are seams for #7-#11. */
export type TransitionActor =
  | "reconcile"
  | "user"
  | "system"
  | "planner"
  | "coder"
  | "reviewer"
  | "shepherd";

export interface TransitionEvent {
  at: string; // ISO 8601
  /** null = admission into the orchestrator. */
  from: LifecycleState | null;
  to: LifecycleState;
  actor: TransitionActor;
  reason?: string;
}

// Per-repo intake settings (#15). Stored in the orchestrator manifest keyed by
// repoKey(repo); absent record / absent field = defaults (follow-all).

export type RepoPriority = "high" | "normal" | "low";

export type AutoPlanMode = "on" | "off" | "label";

/**
 * Shared vocabulary for the two gate axes (#62): autoCoding and review.
 * "auto" means the same thing on both — the score/heuristic decides.
 */
export type GateMode = "on" | "off" | "auto";

export interface OrchestratorSettings {
  intakePaused: boolean;
  /**
   * Global auto-plan master switch (#62). true = nothing auto-plans anywhere,
   * whatever a repo's autoPlan says. Deliberately a master switch, not a default:
   * a topbar toggle cannot express the per-repo tri-state, and one that silently
   * does nothing because a repo overrides it is worse than no toggle.
   */
  autoPlanPaused: boolean;
  /** Model handed to the planner's LLM provider (also scores confidence, #8). */
  plannerModel: string;
  /** Gate thresholds + convergence sample count (#8). Hand-editable by design (#62). */
  confidence: ConfidenceThresholds & { extraPlanRuns: number };
  /** Model handed to the coding agent (#9). */
  coderModel: string;
  /** Max agent turns per coding run (#9). Not reviewMaxRounds. */
  coderMaxTurns: number;
  /** #62: on = always queue, off = always plan-gate, auto = composite >= confidence.high. */
  autoCoding: GateMode;
  /** #62 (was reviewMode): auto = the mechanical skip heuristic in core/reviewer/auto.ts. */
  review: GateMode;
  /** #62: review rounds per fix chain. Applies to on + auto, irrelevant under off. */
  reviewMaxRounds: number;
  /** Model handed to the diff critic (#10). */
  reviewerModel: string;
  /** After a change-request fix round (#11): hold at human-review or repush unattended. */
  shepherdRepush: "human" | "auto";
  /** auto = a red CI on the agent's own push re-enters coding (round-capped). off = evidence only. */
  ciReentry: "off" | "auto";
  /** Coding WIP limit per repo (#15); parallelism is across repos. */
  codingWipPerRepo: number;
}

export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = {
  intakePaused: false,
  autoPlanPaused: false,
  plannerModel: "opus",
  confidence: { ...DEFAULT_CONFIDENCE_THRESHOLDS, extraPlanRuns: DEFAULT_EXTRA_PLAN_RUNS },
  coderModel: "opus",
  coderMaxTurns: 60,
  autoCoding: "auto",
  review: "auto",
  reviewMaxRounds: 2,
  reviewerModel: "opus",
  shepherdRepush: "human",
  ciReentry: "off",
  codingWipPerRepo: 1,
};

export interface RepoIntakeSettings {
  /** false = ignored at admission. Absent/true = followed (default-all). */
  followed?: boolean;
  priority?: RepoPriority;
  autoPlan?: AutoPlanMode;
  /** Only issues carrying this label auto-plan when autoPlan === "label". */
  autoPlanLabel?: string;
  /** Per-repo coding WIP override (#47). Absent = fall back to the global codingWipPerRepo. */
  wipLimit?: number;
  /** #62 per-repo gate overrides. Absent = inherit the global setting. */
  autoCoding?: GateMode;
  review?: GateMode;
  reviewMaxRounds?: number;
  ciReentry?: "off" | "auto";
  /** #58 per-role model overrides. Absent = inherit the global setting. */
  plannerModel?: string;
  coderModel?: string;
  reviewerModel?: string;
}

export const DEFAULT_AUTO_PLAN_LABEL = "ai-ready";

export interface ResolvedRepoIntakeSettings {
  followed: boolean;
  priority: RepoPriority;
  autoPlan: AutoPlanMode;
  autoPlanLabel: string;
}

export function resolveRepoIntakeSettings(s?: RepoIntakeSettings): ResolvedRepoIntakeSettings {
  return {
    followed: s?.followed !== false,
    priority: s?.priority ?? "normal",
    autoPlan: s?.autoPlan ?? "on",
    autoPlanLabel: s?.autoPlanLabel?.trim() || DEFAULT_AUTO_PLAN_LABEL,
  };
}

export interface ResolvedRepoOrchestratorSettings extends ResolvedRepoIntakeSettings {
  /** #47 — the override resolveRepoIntakeSettings never covered. */
  wipLimit: number;
  autoCoding: GateMode;
  review: GateMode;
  reviewMaxRounds: number;
  ciReentry: "off" | "auto";
  /** #58 — the model each role's run hands to its provider. */
  plannerModel: string;
  coderModel: string;
  reviewerModel: string;
}

/**
 * Every global-overridable per-repo field, resolved in one place (#62).
 *
 * Deliberately does NOT fold in settings.autoPlanPaused: that master switch is
 * applied at the planner's triage branch. Folding it in would make the repo
 * settings <select> — which binds to resolved.autoPlan — render "off" and write
 * autoPlan:"off" to the manifest on the next change, destroying the real setting.
 */
export function resolveRepoOrchestratorSettings(
  repo: RepoIntakeSettings | undefined,
  global: OrchestratorSettings,
): ResolvedRepoOrchestratorSettings {
  return {
    ...resolveRepoIntakeSettings(repo),
    wipLimit: repo?.wipLimit ?? global.codingWipPerRepo,
    autoCoding: repo?.autoCoding ?? global.autoCoding,
    review: repo?.review ?? global.review,
    reviewMaxRounds: repo?.reviewMaxRounds ?? global.reviewMaxRounds,
    ciReentry: repo?.ciReentry ?? global.ciReentry,
    plannerModel: repo?.plannerModel ?? global.plannerModel,
    coderModel: repo?.coderModel ?? global.coderModel,
    reviewerModel: repo?.reviewerModel ?? global.reviewerModel,
  };
}

/** An issue tracked through the lifecycle. Mirrors source metadata + orchestrator overlay. */
export interface TrackedItem {
  /** Same id as the inbox Issue, e.g. "github:1234567890". */
  id: string;
  source: IssueSourceId;
  sourceRef: SourceRef;
  codeHost: CodeHostId;
  /** The owning account's key (Account.key), not a provider-native id. */
  accountId: string;
  repo: RepoRef;
  /** Display id: "42" (GitHub) or "PROJ-123" (Jira). Same as sourceRef.key. */
  key: string;
  /** Present when the source numbers items (GitHub); Jira has none. */
  number?: number;
  title: string;
  url: string;
  state: LifecycleState;
  /** Admission time (orchestrator clock), ISO 8601. */
  createdAt: string;
  /** Last transition or metadata refresh, ISO 8601. */
  updatedAt: string;
  transitions: TransitionEvent[];
  /** Manual queue-priority pin (#15). */
  pinned?: boolean;
  /** Suppresses planner auto-plan while in triage (#15 resume rite). */
  holdAutoPlan?: boolean;
  /** Where needs-input/blocked returns once resolved. */
  resumeTo?: LifecycleState;
  /** Prerequisite work items in the same tracker (#85), last fetched by the adapter.
   *  Only refs that resolve to a tracked, not-yet-merged/closed item actually block. */
  blockedBy?: SourceRef[];
  /** Deps the user waived by manually resuming a dependency-block (#85) —
   *  reconcile never re-parks for these; a newly appearing dep still blocks. */
  blockedByWaived?: SourceRef[];
  /** Plan + confidence seam (#7/#8). */
  plan?: { confidence?: number; ref?: string };
  /** Coding runner (#9). sessionId is cwd-scoped: only resumable from the same worktree path. */
  worktree?: { path: string; branch: string; sessionId?: string };
  /** Agent review overlay (#10). Written only via completeReview; replaced wholesale each review. */
  review?: AgentReview;
  /** Linked PR (#11 writes the authoritative link; reconcile has a branch heuristic). */
  pr?: { id: string; number: number; url: string };
  /** PR shepherding overlay (#11). */
  shepherd?: ShepherdState;
  /** Solutions memory fetched via get_memory during each run (#46). Reset per run; vote is the local 👍/👎 anchor. */
  usedMemory?: { planning?: UsedMemoryRef[]; coding?: UsedMemoryRef[] };
}

/** One memory a run consulted, with the user's local 👍/👎 (#46). */
export interface UsedMemoryRef {
  /** SolutionRecord id (the fetched memory's itemId). */
  id: string;
  /** Local vote — the idempotency anchor; maps to a delta on SolutionRecord.feedback. */
  vote?: "up" | "down";
}

const ACTIVE_STATES: readonly LifecycleState[] = [
  "triage",
  "planning",
  "plan-gate",
  "queued",
  "coding",
  "agent-review",
  "human-review",
  "pr-open",
  "in-review",
  "changes-requested",
];

export const TERMINAL_STATES: readonly LifecycleState[] = ["merged"];

export const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  triage: ["planning", "needs-input", "blocked", "closed"],
  planning: ["plan-gate", "queued", "needs-input", "failed", "blocked", "closed"],
  "plan-gate": ["queued", "planning", "needs-input", "blocked", "closed"],
  queued: ["coding", "needs-input", "blocked", "closed"],
  coding: ["agent-review", "needs-input", "failed", "blocked", "closed"],
  "agent-review": ["human-review", "coding", "needs-input", "failed", "closed"],
  "human-review": ["pr-open", "coding", "needs-input", "failed", "closed"],
  "pr-open": ["in-review", "merged", "changes-requested", "needs-input", "closed"],
  "in-review": ["merged", "changes-requested", "needs-input", "blocked", "closed"],
  "changes-requested": ["coding", "needs-input", "closed"],
  "needs-input": [...ACTIVE_STATES, "failed", "closed"],
  blocked: [...ACTIVE_STATES, "failed", "closed"],
  failed: ["triage", "closed"],
  merged: [],
  closed: ["triage"],
};

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return TRANSITIONS[from].includes(to);
}

// Renderer-facing orchestrator snapshot (pushed on skipper:orchestrator:stateChanged).

export interface OrchestratorAccountState {
  /** The account key (Account.key) this snapshot belongs to. */
  accountId: string;
  status: "idle" | "polling" | "error" | "auth-error";
  lastSyncAt?: number;
  /** Epoch ms before which polls are skipped (rate-limit backoff). */
  nextPollAt?: number;
  error?: string;
  issues: Issue[];
  pullRequests: PullRequest[];
}

export interface QueueStatus {
  coding: number;
  queued: number;
  /** @deprecated (#62) mirrors settings.codingWipPerRepo — read that instead. */
  wipLimitPerRepo: number;
}

export interface OrchestratorState {
  status: "idle" | "polling";
  /** @deprecated (#62) mirrors settings.intakePaused — read that instead. */
  intakePaused: boolean;
  parkedCount: number;
  queue: QueueStatus;
  items: TrackedItem[];
  /** Keyed by account key (Account.key). */
  accounts: Record<string, OrchestratorAccountState>;
  /** repoKey(repo) → per-repo intake settings (#15). */
  repoSettings: Record<string, RepoIntakeSettings>;
  /** Pending resume-rite prompt (#15); null when none. */
  resumeRite: { itemIds: string[] } | null;
  /** The global settings bag (#62), so the UI can read and write it. */
  settings: OrchestratorSettings;
}

// IPC result shapes shared by the preload bridge and the renderer types.

export type OrchestratorTransitionResult =
  | { ok: true; item: TrackedItem }
  | { ok: false; error: string };

export type UpdatePlanResult = { ok: true; stored: StoredPlan } | { ok: false; error: string };

// Pre-PR diff review (#14): worktree changes exposed to the renderer while an
// item sits in human-review.

export type WorktreeFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface WorktreeFileChange {
  /** Worktree-relative POSIX path (the new path for renames). */
  path: string;
  /** HEAD-side path, renames only. */
  oldPath?: string;
  status: WorktreeFileStatus;
}

export type WorktreeChangesResult =
  | { ok: true; files: WorktreeFileChange[] }
  | { ok: false; error: string };

export interface WorktreeFileContents {
  /** HEAD blob; null when the file was added. */
  original: string | null;
  /** Working-tree content; null when the file was deleted. */
  modified: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export type WorktreeFileResult =
  | { ok: true; file: WorktreeFileContents }
  | { ok: false; error: string };

export type SaveWorktreeFileResult = { ok: true } | { ok: false; error: string };

// Worktree control center (#40): worktree location + liveness for any tracked
// item that has one, regardless of lifecycle state.

export type WorktreeStatusResult =
  | { ok: true; path: string; branch: string; sessionId?: string; present: boolean }
  | { ok: false; error: string };

export type RepoLinkResult = { ok: true; localPath: string } | { ok: false; error: string };

export type RepoUnlinkResult = { ok: true } | { ok: false; error: string };

export interface ListReposResult {
  linked: { key: string; localPath: string; linkedAt: string; linked: true }[];
  unlinked: { key: string; repo: RepoRef; linked: false }[];
}

// Queue + intake controls (#15).

export interface RepoSettingsRow {
  key: string;
  repo: RepoRef;
  linked: boolean;
  localPath?: string;
  settings: RepoIntakeSettings;
  resolved: ResolvedRepoOrchestratorSettings;
}

export interface FollowCandidate {
  repo: RepoRef;
  private?: boolean;
  /** installation = visible via the GitHub App; membership = a GitLab membership
   *  project; polled = seen in the assigned-issues poll. */
  source: "installation" | "membership" | "polled";
  followed: boolean;
  linked: boolean;
}

export type FollowCandidatesResult =
  | {
      ok: true;
      /** GitHub only: number of GitHub App installations for the account. */
      installationCount?: number;
      /** GitHub only: App installation page (fallback: user installations settings). */
      installUrl?: string;
      repos: FollowCandidate[];
    }
  | { ok: false; error: string };

export type ResumeRiteAction = "plan-all" | "plan-selected" | "dismiss";
