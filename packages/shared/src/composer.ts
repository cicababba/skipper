// ============================================================
// Skipper — Chat composer types (issue #136)
// ============================================================

import type { AgentRuntimeId } from "./types";
import type { RepoRef } from "./inbox";
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

/**
 * A composer chat promoted to a saved draft (#138), one JSON file per draft
 * under <userData>/drafts/. The session fields ride along with the repo and the
 * runtime that minted them: a session id only resumes under the same
 * (cwd, runtime) pair (#111), so a resume that no longer matches degrades to a
 * fresh run seeded from `messages`.
 */
export interface StoredComposerDraft {
  version: 1;
  draftId: string;
  repo: RepoRef;
  chatId: string;
  title: string;
  sessionId?: string;
  sessionRuntime?: AgentRuntimeId;
  messages: PlanChatMessage[];
  draft?: ComposerDraft;
  editedFlags?: ComposerEditedFlags;
  /** Auto-saved on abandonment (#272) rather than saved on purpose: at most one
   *  per repo, overwritten by the next abandoned session until an explicit save
   *  or a publish ends its life. */
  unfinished?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A saved draft as the /drafts list renders it. */
export interface ComposerDraftListItem {
  draftId: string;
  repo: RepoRef;
  title: string;
  updatedAt: string;
  unfinished?: boolean;
  /** No transcript, so the session was the quick path (#137) — resuming it
   *  reopens quick mode, not the chat. */
  quick?: boolean;
}

export type SaveComposerDraftResult =
  | { ok: true; draftId: string }
  | { ok: false; error: string };

export type ResumeComposerChatResult =
  | { ok: true; chatId: string; unfinished?: boolean }
  | { ok: false; error: string };

/** The account's provider username, for self-assignment. Absent when it cannot
 *  be resolved (legacy account, offline, non-GitHub provider) — creation then
 *  proceeds unassigned. */
export interface ComposerSelfLogin {
  login?: string;
}
