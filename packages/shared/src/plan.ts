// ============================================================
// Skipper — Issue plan types (issue #7; scored by #8, rendered by #13)
// ============================================================

import type { ConfidenceReport } from "./confidence";
import type { RepoRef } from "./inbox";

export interface PlanFileRef {
  /** Repo-relative path. */
  path: string;
  reason: string;
  /** "new" = the plan creates this file — exempt from groundedness (#8). */
  status?: "existing" | "new";
}

export interface PlanStep {
  title: string;
  detail: string;
  /** Repo-relative paths this step touches. */
  files: string[];
  /** Functions/classes/exports this step touches. */
  symbols: string[];
}

export interface PlanAcceptance {
  /** Acceptance criterion, quoted or derived from the issue. */
  criterion: string;
  /** How the plan addresses it. */
  addressedBy: string;
}

export interface IssuePlan {
  summary: string;
  /** Verified repo facts: gotchas, patterns, invariants (file:line where useful). */
  context?: string[];
  files: PlanFileRef[];
  steps: PlanStep[];
  /** What NOT to touch. */
  outOfScope?: string[];
  acceptance: PlanAcceptance[];
  risks: string[];
  /** lint/test/build commands that must pass. */
  verificationCommands?: string[];
  /** Manual verification checklist. */
  manualChecks?: string[];
  /** Empty when the issue is unambiguous. */
  openQuestions: string[];
  estimatedSize: "xs" | "s" | "m" | "l" | "xl";
}

/** One turn of the plan-review chat (#145). */
export interface PlanChatMessage {
  role: "user" | "assistant";
  text: string;
  at: string; // ISO 8601
}

/** On-disk transcript of the plan-review chat, one file per tracked item (#145). */
export interface StoredPlanChat {
  version: 1;
  itemId: string;
  /** The plan generation this transcript belongs to; a replan supersedes it. */
  planGeneratedAt: string;
  messages: PlanChatMessage[];
}

/** On-disk envelope for a generated plan (TrackedItem.plan.ref points at it). */
export interface StoredPlan {
  version: 2;
  itemId: string;
  repo: RepoRef;
  /** Work-item display key ("42" | "PROJ-123"); absent on pre-#71 files. */
  issueKey?: string;
  /** Present when the source numbers items; absent for Jira. */
  issueNumber?: number;
  generatedAt: string; // ISO 8601
  model: string;
  plan: IssuePlan;
  /** Absent while scoring runs, on scoring failure, or on v1 plans. */
  confidence?: ConfidenceReport;
  /** Set when the user edits the plan at the gate (#13). Confidence predates the edit. */
  editedAt?: string;
}
