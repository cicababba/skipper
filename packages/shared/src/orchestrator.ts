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
import { DEFAULT_LLM_SETTINGS, type AgentRuntimeId } from "./types";

export type AgentReviewOutcome = CriticVerdict | "skipped" | "unavailable";

/** One snapshotted prior review record (#205), oldest-first on AgentReview.history.
 *  Position in the history array = the record's attempt ordinal. */
export interface ReviewRound {
  /** Chain-local rounds at snapshot time (resets on re-entry). */
  round: number;
  outcome: AgentReviewOutcome;
  reason?: string;
  objections?: CriticObjection[];
  resolvedObjections?: CriticObjection[];
  at: string; // ISO 8601
}

export interface AgentReview {
  /** Reviews performed in the current fix chain. A round = one review of one coding attempt; first review = 1. */
  rounds: number;
  outcome: AgentReviewOutcome;
  /** Skip explanation (never/auto), non-convergence note, or error message. */
  reason?: string;
  /** Full objection list from the last review (UI surface for #13). */
  objections?: CriticObjection[];
  /** Prior-round objections this round's diff genuinely addressed (#205). */
  resolvedObjections?: CriticObjection[];
  /** Set only when the reviewer sent the item back to coding — the coder's fix-round seam. */
  pendingObjections?: CriticObjection[];
  /** Last critic round's Claude session, cwd-scoped to worktree.path, overwritten each round (#111). */
  sessionId?: string;
  /** Runtime that minted sessionId (#238) — a mismatch with the active runtime = no resume. */
  sessionRuntime?: AgentRuntimeId;
  /** Prior review records snapshotted before overwrite (#205), oldest-first. */
  history?: ReviewRound[];
  at: string; // ISO 8601
}

/** Snapshot a review record for history — strips the transient/derived fields
 *  (pendingObjections, sessionId, history) that never belong on a past round. */
export function toReviewRound(review: AgentReview): ReviewRound {
  return {
    round: review.rounds,
    outcome: review.outcome,
    ...(review.reason ? { reason: review.reason } : {}),
    ...(review.objections ? { objections: review.objections } : {}),
    ...(review.resolvedObjections ? { resolvedObjections: review.resolvedObjections } : {}),
    at: review.at,
  };
}

/** Merge a fresh review over the previous one, snapshotting the previous record
 *  onto history (#205). No prior = passthrough. */
export function appendReviewHistory(prev: AgentReview | undefined, next: AgentReview): AgentReview {
  return prev ? { ...next, history: [...(prev.history ?? []), toReviewRound(prev)] } : next;
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
  /** Model handed to the planner's LLM provider (also scores confidence, #8).
   *  #125: absent = inherit llm.claudeModel. */
  plannerModel?: string;
  /** Gate thresholds + convergence sample count (#8). Hand-editable by design (#62). */
  confidence: ConfidenceThresholds & { extraPlanRuns: number };
  /** Model handed to the coding agent (#9). #125: absent = inherit llm.claudeModel. */
  coderModel?: string;
  /** Wall-clock budget per coding run, in minutes (#194). When it fires, the coder
   *  is asked for a final honest report and review continues from there. Turns are a
   *  high anti-runaway backstop (AGENT_MAX_TURNS_BACKSTOP), not the work budget. */
  coderTimeBudgetMin: number;
  /** Wall-clock budget per plan run, in minutes (#194). When it fires, the planner
   *  is asked to emit the plan from what it has already learned. */
  plannerTimeBudgetMin: number;
  /** #62: on = always queue, off = always plan-gate, auto = composite >= confidence.high. */
  autoCoding: GateMode;
  /** #62 (was reviewMode): auto = the mechanical skip heuristic in core/reviewer/auto.ts. */
  review: GateMode;
  /** #62: review rounds per fix chain. Applies to on + auto, irrelevant under off. */
  reviewMaxRounds: number;
  /** Model handed to the diff critic (#10). #125: absent = inherit llm.claudeModel. */
  reviewerModel?: string;
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
  confidence: { ...DEFAULT_CONFIDENCE_THRESHOLDS, extraPlanRuns: DEFAULT_EXTRA_PLAN_RUNS },
  coderTimeBudgetMin: 60,
  plannerTimeBudgetMin: 15,
  autoCoding: "auto",
  review: "auto",
  reviewMaxRounds: 2,
  shepherdRepush: "human",
  ciReentry: "off",
  codingWipPerRepo: 1,
};

/**
 * Turns are no longer the work budget (#194) — wall-clock time is. This is a high
 * anti-runaway backstop: a run that somehow burns this many turns is stuck, and the
 * salvage path still extracts an honest report from the dead session.
 */
export const AGENT_MAX_TURNS_BACKSTOP = 300;

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
  /** #233 opt-in per-repo Graphify knowledge-graph index. Absent = off. */
  graphify?: boolean;
}

export const DEFAULT_AUTO_PLAN_LABEL = "ai-ready";

export interface ResolvedRepoIntakeSettings {
  followed: boolean;
  priority: RepoPriority;
  autoPlan: AutoPlanMode;
  autoPlanLabel: string;
  graphify: boolean;
}

export function resolveRepoIntakeSettings(s?: RepoIntakeSettings): ResolvedRepoIntakeSettings {
  return {
    followed: s?.followed !== false,
    priority: s?.priority ?? "normal",
    autoPlan: s?.autoPlan ?? "on",
    autoPlanLabel: s?.autoPlanLabel?.trim() || DEFAULT_AUTO_PLAN_LABEL,
    graphify: s?.graphify === true,
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
  defaultModel?: string,
): ResolvedRepoOrchestratorSettings {
  // #125: the per-role globals are optional overrides of llm.claudeModel. The floor
  // covers a hand-edited "" and an omitted arg, so modelForRole never receives "".
  const dm = defaultModel?.trim() || DEFAULT_LLM_SETTINGS.claudeModel;
  return {
    ...resolveRepoIntakeSettings(repo),
    wipLimit: repo?.wipLimit ?? global.codingWipPerRepo,
    autoCoding: repo?.autoCoding ?? global.autoCoding,
    review: repo?.review ?? global.review,
    reviewMaxRounds: repo?.reviewMaxRounds ?? global.reviewMaxRounds,
    ciReentry: repo?.ciReentry ?? global.ciReentry,
    plannerModel: repo?.plannerModel ?? global.plannerModel ?? dm,
    coderModel: repo?.coderModel ?? global.coderModel ?? dm,
    reviewerModel: repo?.reviewerModel ?? global.reviewerModel ?? dm,
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
  /** Issue body/description as reported by the source (GFM markdown). */
  body?: string;
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
  /** Plan + confidence seam (#7/#8). sessionId is the last plan run's Claude session,
   *  cwd-scoped to worktree.path, overwritten each run (#111). sessionRuntime is the
   *  runtime that minted it (#238). */
  plan?: {
    confidence?: number;
    ref?: string;
    sessionId?: string;
    sessionRuntime?: AgentRuntimeId;
    rescoring?: boolean;
  };
  /** Structured coder report (#146). ref into plansDir; overwritten each run,
   *  deleted when a run degrades to a prose summary. */
  coderReport?: { ref: string };
  /** Shared worktree, created at planning (#110) and reused for coding/review (#9).
   *  sessionId is cwd-scoped: only resumable from the same worktree path.
   *  sessionRuntime is the runtime that minted it (#238). */
  worktree?: { path: string; branch: string; sessionId?: string; sessionRuntime?: AgentRuntimeId };
  /** Agent review overlay (#10). Written only via completeReview; the prior record is
   *  snapshotted onto review.history before overwrite (#205). */
  review?: AgentReview;
  /** Linked PR (#11 writes the authoritative link; reconcile has a branch heuristic). */
  pr?: { id: string; number: number; url: string };
  /** PR shepherding overlay (#11). */
  shepherd?: ShepherdState;
  /** Solutions memory fetched via get_memory during each run (#46). Reset per run; vote is the local 👍/👎 anchor. */
  usedMemory?: { planning?: UsedMemoryRef[]; coding?: UsedMemoryRef[] };
  /** Set when the item's project was remapped to a different repo but the item
   *  wasn't auto-migratable (#120); cleared when its repo matches the mapping again. */
  staleRepo?: boolean;
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
  queued: ["coding", "planning", "needs-input", "blocked", "closed"],
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

/**
 * States from which the coder chat's Apply distills the discussion into a coding
 * re-entry (#188). Limited to the review-gate states that already allow → coding
 * in TRANSITIONS; pr-open/in-review re-entry is a deferred follow-up. Single
 * source for the desktop guard and the renderer predicate.
 */
export const CODER_CHAT_APPLY_STATES: readonly LifecycleState[] = [
  "agent-review",
  "human-review",
  "changes-requested",
];

export function canCoderChatApply(state: LifecycleState): boolean {
  return CODER_CHAT_APPLY_STATES.includes(state);
}

/**
 * Timestamp of the item's most recent entry into planning — the planner's run
 * token (#159). Any fresh re-entry (re-admit, replan, base-change, needs-input
 * resume) mints a new transition event, so a zombie run captured against an
 * older token is detectably stale. `undefined` when the item never entered
 * planning (legacy/test items with an empty transition log compare equal).
 */
export function latestPlanningTransitionAt(item: TrackedItem): string | undefined {
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    if (item.transitions[i].to === "planning") return item.transitions[i].at;
  }
  return undefined;
}

/**
 * Timestamp of the item's most recent entry into coding — the coder's run token
 * (#159, mirrors latestPlanningTransitionAt). An untrack → re-admit that mints a
 * newer coding transition makes a zombie run captured against the older token
 * detectably stale, so it can't land its report on the fresh lifecycle.
 * `undefined` when the item never entered coding.
 */
export function latestCodingTransitionAt(item: TrackedItem): string | undefined {
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    if (item.transitions[i].to === "coding") return item.transitions[i].at;
  }
  return undefined;
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

/** A tracker project with open issues but no repo mapping yet (#79) — surfaced as
 *  a warning so the user can map it. count = open, unadmitted issues in the project. */
export interface UnmappedProject {
  source: string;
  host: string;
  projectKey: string;
  count: number;
  accountId: string;
}

/** One project listed from a tracker for the mapping editor (#79). */
export interface TrackerProject {
  id: string;
  key: string;
  name: string;
}

/** Result of listing a tracker account's projects for the mapping editor (#79). */
export type TrackerProjectsResult =
  | { ok: true; source: string; host: string; projects: TrackerProject[] }
  | { ok: false; error: string };

/** Renderer-visible capability flags per issue source (#132), derived from the
 *  adapter registry. closeIssue = the source can close the issue on its tracker. */
export interface IssueSourceCapabilities {
  closeIssue: boolean;
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
  /** projectMappingKey → canonical repoKey (#79). */
  projectMappings: Record<string, string>;
  /** Tracker projects with open issues but no repo mapping yet (#79). */
  unmappedProjects: UnmappedProject[];
  /** Pending resume-rite prompt (#15); null when none. */
  resumeRite: { itemIds: string[] } | null;
  /** The global settings bag (#62), so the UI can read and write it. */
  settings: OrchestratorSettings;
  /** Per-source capability flags (#132), derived from the adapter registry. */
  sourceCapabilities: Record<IssueSourceId, IssueSourceCapabilities>;
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

/** Summed added/deleted line counts across a worktree diff (#169). */
export interface WorktreeDiffTotals {
  additions: number;
  deletions: number;
}

export type WorktreeChangesResult =
  | { ok: true; files: WorktreeFileChange[]; totals: WorktreeDiffTotals }
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

// Markdown export (#216): the worktree's HEAD diff as a unified patch string,
// exposed to the renderer for the worktree/dossier export. Carries only the diff
// text — DiffStats is a @skipper/core type shared cannot import.
export type WorktreeDiffResult = { ok: true; diff: string } | { ok: false; error: string };

// Worktree control center (#40): worktree location + liveness for any tracked
// item that has one, regardless of lifecycle state.

export type WorktreeStatusResult =
  | {
      ok: true;
      path: string;
      branch: string;
      sessionId?: string;
      present: boolean;
      dirtyFiles?: string[] | null;
    }
  | { ok: false; error: string };

// End-of-flow cleanup (#115): manual archive of a closed item — removes its
// worktree and archives the plan. needsConfirm gates on uncommitted work.
export type ArchiveItemResult =
  | { ok: true; item: TrackedItem }
  | { ok: false; needsConfirm: true; dirtyFiles: number }
  | { ok: false; needsConfirm?: undefined; error: string };

// Manifest cleanup (#120): untrack an item — remove it from the manifest and the
// raw cache. needsConfirm gates when the item carries a worktree or PR.
export type UntrackItemResult =
  | { ok: true }
  | { ok: false; needsConfirm: true; hasWorktree: boolean; dirtyFiles: number; hasPr: boolean }
  | { ok: false; needsConfirm?: undefined; error: string };

// Close-on-tracker (#132): close the issue on its tracker via the adapter's
// closeIssue capability. reconcile then settles the item through its existing
// "closed on GitHub" path.
export type CloseItemOnTrackerResult = { ok: true } | { ok: false; error: string };

// Dirty-worktree cleanup (#204): reset the item's worktree to its base ref +
// clean untracked files, discarding leftover uncommitted work and local commits.
export type CleanWorktreeResult = { ok: true } | { ok: false; error: string };

export type RepoLinkResult = { ok: true; localPath: string } | { ok: false; error: string };

export type RepoUnlinkResult = { ok: true } | { ok: false; error: string };

export interface BaseChangeReport {
  replanned: string[];
  skipped: { id: string; key: string; reason: BaseChangeSkipReason }[];
}
export type BaseChangeSkipReason = "dirty" | "own-commits" | "unresolved-base" | "illegal-transition";
export type SetRepoBaseBranchResult =
  | { ok: true; replan?: BaseChangeReport }
  | { ok: false; error: string };

export type ListRepoBranchesResult =
  | { ok: true; branches: string[]; defaultBranch?: string }
  | { ok: false; error: string };

export interface ListReposResult {
  linked: { key: string; localPath: string; linkedAt: string; baseBranch?: string; linked: true }[];
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

// Per-repo agent instructions (#227): a Skipper-owned conventions doc, seeded
// from the repo's CLAUDE.md or generated at link, editable in repo settings,
// injected into the planner/coder system prompts. Stored in userData, never
// committed.

export type RepoInstructionsSource = "claude-md" | "generated" | "edited";
export type RepoInstructionsStatus = "ready" | "generating" | "failed";

export interface RepoInstructionsDoc {
  version: 1;
  /** "" while generating / failed-with-no-doc. */
  content: string;
  /** ISO 8601 — UI "last updated". */
  updatedAt: string;
  source: RepoInstructionsSource;
  status: RepoInstructionsStatus;
  /** Set when status === "failed". */
  error?: string;
  /** Clobber guard: a concurrent user edit mid-generation wins. */
  generationStartedAt?: string;
}

export type GetRepoInstructionsResult =
  | { ok: true; doc: RepoInstructionsDoc | null }
  | { ok: false; error: string };

export type SetRepoInstructionsResult =
  | { ok: true; doc: RepoInstructionsDoc }
  | { ok: false; error: string };

export type RegenerateRepoInstructionsResult = { ok: true } | { ok: false; error: string };

// Per-repo Graphify knowledge-graph index (#233): an opt-in, fully local
// tree-sitter AST index of the repo at its resolved base ref, extracted into a
// throwaway worktree and queried by the planner via the graphify-mcp server.
// Stored in userData, keyed by repoKey, never committed.

export type GraphifyStatus = "installing" | "indexing" | "ready" | "failed";

export interface GraphifyDoc {
  version: 1;
  status: GraphifyStatus;
  /** Base SHA the on-disk graph was extracted at. Presence + graph.json on disk
   *  is the last-good-graph signal (status gates only the UI). */
  indexedSha?: string;
  /** ISO 8601 — UI "last updated". */
  updatedAt: string;
  /** Set when status === "failed". */
  error?: string;
  /** Anti-clobber guard: a stale run's final save is dropped if this moved on. */
  runStartedAt?: string;
}

export type GetRepoGraphifyResult =
  | { ok: true; doc: GraphifyDoc | null }
  | { ok: false; error: string };

export type ReindexRepoGraphifyResult = { ok: true } | { ok: false; error: string };

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
