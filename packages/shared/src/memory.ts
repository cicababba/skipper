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
  /** v2 (#256) adds the distilled lesson + the maintenance signals below. v1
   *  files stay valid and are read as-is; any write normalizes them to 2. */
  version: 1 | 2;
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
  /** Distilled lesson (#256): problem + insight + gotchas, embedded with the record. */
  lesson?: string;
  /** ISO 8601 — the backfill idempotency marker. */
  distilledAt?: string;
  /** Times the record entered an agent run's top-k (written by the MCP serve subprocess). */
  offeredCount?: number;
  lastOfferedAt?: string;
  /** Times an agent called get_memory on the record — the strong usage signal. */
  fetchedCount?: number;
  lastFetchedAt?: string;
  /** 0–1 fraction of filesTouched missing at the repo's base ref; undefined = no data. */
  staleness?: number;
  stalenessCheckedAt?: string;
  /** "Keep" from the review queue — hides the record from prune candidates for 90 days. */
  reviewDismissedAt?: string;
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
  /** Distilled lesson (#256) — the gist an agent should read before the plan. */
  lesson?: string;
  filesTouched: string[];
  capturedAt: string;
  feedback?: SolutionRecord["feedback"];
}
