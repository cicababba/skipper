// ============================================================
// NestBrain — Orchestrator lifecycle types (issue #6)
// ============================================================

import type { PlatformId, RepoRef } from "./inbox";

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
  /** Coding runner seam (#9). */
  worktree?: { path: string; branch: string };
  /** Agent review seam (#10) — rounds consumed, max 2. */
  agentReviewRounds?: number;
  /** Linked PR (#11 writes the authoritative link; reconcile has a branch heuristic). */
  pr?: { id: string; number: number; url: string };
}
