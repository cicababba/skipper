// ============================================================
// NestBrain — Orchestrator lifecycle types (issue #6)
// ============================================================

import type { CriticObjection, CriticVerdict } from "./confidence";
import type { PlatformId, RepoRef } from "./inbox";

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
}
