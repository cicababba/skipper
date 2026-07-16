// ============================================================
// Skipper — Solutions memory types (issue #11)
// ============================================================

import type { RepoRef } from "./inbox";
import type { StoredPlan } from "./plan";

/** Which run consulted a memory — planner or coder (#46). */
export type MemoryPhase = "planning" | "coding";

/**
 * One completed issue captured as problema → piano → diff → esito.
 * Written on merge (capture from day 1); retrieval arrives with v2.
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
  pr: { number: number; url: string };
  /** Full snapshot — retrieval (v2) decides what to embed. */
  plan?: StoredPlan;
  /** Branch vs base at capture time; absent when the worktree is already gone. */
  diff?: string;
  diffStats?: { filesChanged: number; totalChangedLines: number; files: string[] };
  outcome: "merged";
  capturedAt: string; // ISO 8601
  /** 👍/👎 from the "memories used" UI (#46); weighs retrieval ranking at query time. */
  feedback?: { up: number; down: number };
}
