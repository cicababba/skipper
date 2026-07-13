// ============================================================
// NestBrain — Orchestrator lifecycle types (issue #6)
// ============================================================

import type { CriticObjection, CriticVerdict } from "./confidence";
import type { Issue, PlatformId, PullRequest, RepoRef } from "./inbox";
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
  /** Solutions-memory record ref — presence means the post-merge capture ran. */
  memoryRef?: string;
}

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

/** An issue tracked through the lifecycle. Mirrors platform metadata + orchestrator overlay. */
export interface TrackedItem {
  /** Same id as the inbox Issue, e.g. "github:1234567890". */
  id: string;
  platform: PlatformId;
  accountId: string;
  repo: RepoRef;
  number: number;
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
  /** Where needs-input/blocked returns once resolved. */
  resumeTo?: LifecycleState;
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

// Renderer-facing orchestrator snapshot (pushed on nestbrain:orchestrator:stateChanged).

export interface OrchestratorAccountState {
  accountId: string;
  status: "idle" | "polling" | "error" | "auth-error";
  lastSyncAt?: number;
  /** Epoch ms before which polls are skipped (rate-limit backoff). */
  nextPollAt?: number;
  error?: string;
  issues: Issue[];
  pullRequests: PullRequest[];
}

export interface OrchestratorState {
  status: "idle" | "polling";
  intakePaused: boolean;
  parkedCount: number;
  items: TrackedItem[];
  accounts: Record<string, OrchestratorAccountState>;
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

export type RepoLinkResult = { ok: true; localPath: string } | { ok: false; error: string };

export type RepoUnlinkResult = { ok: true } | { ok: false; error: string };

export interface ListReposResult {
  linked: { key: string; localPath: string; linkedAt: string; linked: true }[];
  unlinked: { key: string; repo: RepoRef; linked: false }[];
}
