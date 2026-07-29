// ============================================================
// Skipper — Chat composer types (issue #136)
// ============================================================

import type { PlanChatMessage } from "./plan";

/**
 * One issue of a composer draft. acceptanceCriteria stays its own field because
 * CreateIssueParams has no slot for it — the renderer folds it into the body at
 * create time.
 */
export interface ComposerDraftIssue {
  title: string;
  body: string;
  acceptanceCriteria: string[];
  labels: string[];
}

/** A relation between two drafted issues, by 0-based index into draft.issues.
 *  Displayed read-only; never cross-posted into created bodies (#131). */
export interface ComposerRelation {
  from: number;
  to: number;
  kind: "blocks" | "part-of" | "relates-to";
}

export interface ComposerDraft {
  issues: ComposerDraftIssue[];
  relations: ComposerRelation[];
}

/**
 * Fields the user hand-edited, per issue index (e.g. `{ 0: ["title", "body"] }`).
 * Deliberately layered outside the draft schema: the agent never emits it, the
 * driver only renders it into the prompt as a preserve-verbatim marker, and a
 * regeneration clears it.
 */
export type ComposerEditedFlags = Record<number, string[]>;

/** The desktop-owned chat record as the renderer sees it. */
export interface ComposerChatSnapshot {
  messages: PlanChatMessage[];
  draft?: ComposerDraft;
  editedFlags?: ComposerEditedFlags;
}

export type StartComposerChatResult =
  | { ok: true; chatId: string }
  | { ok: false; error: string };

export type SendComposerChatResult =
  | { ok: true; reply: string }
  | { ok: false; error?: string; cancelled?: boolean };

export type GenerateComposerDraftResult =
  | { ok: true; draft: ComposerDraft }
  | { ok: false; error?: string; cancelled?: boolean };

/** The account's provider username, for self-assignment. Absent when it cannot
 *  be resolved (legacy account, offline, non-GitHub provider) — creation then
 *  proceeds unassigned. */
export interface ComposerSelfLogin {
  login?: string;
}
