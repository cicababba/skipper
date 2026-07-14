// ============================================================
// Skipper — Solutions memory types (issue #11)
// ============================================================

import type { RepoRef } from "./inbox";
import type { StoredPlan } from "./plan";

/**
 * One completed issue captured as problema → piano → diff → esito.
 * Written on merge (capture from day 1); retrieval arrives with v2.
 */
export interface SolutionRecord {
  version: 1;
  itemId: string;
  repo: RepoRef;
  issueNumber: number;
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
}
