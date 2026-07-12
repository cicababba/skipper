// Auto-mode decision for the agent review (issue #10): mechanical and
// explainable by design — never "ask an LLM whether review is needed".
// Hot-files and tests-green-on-first-try are v2 signals (memory).

export type ReviewMode = "always" | "never" | "auto";

export interface DiffStats {
  filesChanged: number;
  totalChangedLines: number;
  files: string[];
}

export interface ReviewModeInput {
  mode: ReviewMode;
  stats: DiffStats;
  /** TrackedItem.plan.confidence (composite 0..1); undefined = scoring failed/absent. */
  planConfidence?: number;
  /** settings.confidence.high. */
  highThreshold: number;
}

export const AUTO_MAX_CHANGED_LINES = 60;
export const AUTO_MAX_FILES = 5;
export const RISKY_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\//,
  /(^|\/)migrations?\//i,
  /\.sql$/i,
  /(^|\/)(auth|security|secrets?|crypto)/i,
  /dockerfile|docker-compose/i,
  /(^|\/)package\.json$/,
  /pnpm-workspace/,
];

export function resolveReviewMode(input: ReviewModeInput): { review: boolean; reason: string } {
  if (input.mode === "always") return { review: true, reason: "reviewMode: always" };
  if (input.mode === "never") return { review: false, reason: "review skipped (mode: never)" };

  const { stats, planConfidence, highThreshold } = input;
  if (planConfidence === undefined) {
    return { review: true, reason: "review required (auto): plan confidence unavailable" };
  }
  if (planConfidence < highThreshold) {
    return {
      review: true,
      reason: `review required (auto): plan confidence ${planConfidence.toFixed(2)} < ${highThreshold}`,
    };
  }
  if (stats.totalChangedLines > AUTO_MAX_CHANGED_LINES) {
    return {
      review: true,
      reason: `review required (auto): ${stats.totalChangedLines} changed lines > ${AUTO_MAX_CHANGED_LINES}`,
    };
  }
  if (stats.filesChanged > AUTO_MAX_FILES) {
    return {
      review: true,
      reason: `review required (auto): ${stats.filesChanged} files > ${AUTO_MAX_FILES}`,
    };
  }
  const risky = stats.files.find((f) => RISKY_FILE_PATTERNS.some((re) => re.test(f)));
  if (risky) {
    return { review: true, reason: `review required (auto): risky path ${risky}` };
  }
  return {
    review: false,
    reason: `review skipped (auto): plan confidence ${planConfidence.toFixed(2)} >= ${highThreshold}, ${stats.totalChangedLines} changed lines in ${stats.filesChanged} files, no risky paths`,
  };
}
