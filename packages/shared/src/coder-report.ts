// ============================================================
// Skipper — Structured coder report types (issue #146)
// ============================================================
// The coding run's final message is a JSON CoderReport instead of free prose:
// Done / Deviations / Verification / Open. Ported from the implementer.md
// contract so the agent reviewer (#10) can tell declared deviations from silent
// drift and see what verification actually ran. Persisted as a sibling file in
// plansDir (TrackedItem.coderReport.ref points at it).

import type { RepoRef } from "./inbox";

export interface CoderReportDoneEntry {
  path: string;
  summary: string;
}

export interface CoderReportVerification {
  command: string;
  passed: boolean;
  detail?: string;
}

export interface CoderReport {
  done: CoderReportDoneEntry[];
  /** "None" collapses to an empty array (normalized at parse). */
  deviations: string[];
  verification: CoderReportVerification[];
  open: string[];
}

/** On-disk envelope for a coder report (TrackedItem.coderReport.ref points at it). */
export interface StoredCoderReport {
  version: 1;
  itemId: string;
  repo: RepoRef;
  /** Work-item display key ("42" | "PROJ-123"). */
  issueKey?: string;
  /** Present when the source numbers items; absent for Jira. */
  issueNumber?: number;
  generatedAt: string; // ISO 8601
  model: string;
  report: CoderReport;
}
