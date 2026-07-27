// ============================================================
// Skipper — Solutions memory types (issue #11)
// ============================================================

import type { RepoRef } from "./inbox";
import type { StoredPlan } from "./plan";

/** Which run consulted a memory — planner or coder (#46). */
export type MemoryPhase = "planning" | "coding";

/**
 * One completed issue captured as problema → piano → diff → esito, or a manual
 * note written by the user (#255). Notes carry `kind: "note"` and none of the
 * capture fields (pr/outcome/plan/diff) — hence those being optional.
 */
export interface SolutionRecord {
  version: 1;
  itemId: string;
  repo: RepoRef;
  /** Work-item display key ("42" | "PROJ-123"); absent on pre-#71 files. */
  issueKey?: string;
  /** Present when the source numbers items; absent for Jira. */
  issueNumber?: number;
  title: string;
  url: string;
  pr?: { number: number; url: string };
  /** Full snapshot — retrieval (v2) decides what to embed. */
  plan?: StoredPlan;
  /** Branch vs base at capture time; absent when the worktree is already gone. */
  diff?: string;
  diffStats?: { filesChanged: number; totalChangedLines: number; files: string[] };
  outcome?: "merged";
  capturedAt: string; // ISO 8601
  /** 👍/👎 from the "memories used" UI (#46); weighs retrieval ranking at query time. */
  feedback?: { up: number; down: number };
  /** Manual note (#255) rather than a captured solution. */
  kind?: "note";
  note?: { body: string; files?: string[] };
  /** Direct curation vote from the memory browser (#255) — the idempotency
   * anchor for the aggregate counters, one per record (single-user app). */
  curationVote?: "up" | "down";
}

/** One ranked result of a memory search. */
export interface MemoryHit {
  /** SolutionRecord.itemId — the id `get_memory` (#45) accepts. */
  id: string;
  /** Record filename under the memory dir. */
  ref: string;
  score: number;
  title: string;
  /** Work-item display key; the number on pre-#71 records, "" on notes. */
  issueKey: string;
  url: string;
  pr?: { number: number; url: string };
  kind?: "note";
  planSummary?: string;
  filesTouched: string[];
  capturedAt: string;
  feedback?: SolutionRecord["feedback"];
}
