import type { StoredCoderReport } from "@skipper/shared";
import { coderReportMarkdown } from "./coder-report-markdown";
import { fenceBlock, joinBlocks } from "./md";

// Worktree-tab serializer for the markdown export (#216): the coder report plus
// the unified diff fenced as a patch. Null when there is neither.

export interface WorktreeMarkdownInput {
  report: StoredCoderReport | null;
  diff: string | null;
}

export function worktreeMarkdown({ report, diff }: WorktreeMarkdownInput): string | null {
  const body = joinBlocks([
    report ? coderReportMarkdown(report) : null,
    diff && diff.trim() !== "" ? joinBlocks(["# Diff", fenceBlock(diff, "diff")]) : null,
  ]);
  return body || null;
}
