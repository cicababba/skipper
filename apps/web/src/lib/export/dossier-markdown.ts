import { displayKey, type StoredCoderReport, type StoredPlan, type TrackedItem } from "@skipper/shared";
import { coderReportMarkdown } from "./coder-report-markdown";
import { fenceBlock, bullet, joinBlocks, pct } from "./md";
import { planMarkdown } from "./plan-markdown";
import { reviewMarkdown } from "./review-markdown";

// Full-dossier serializer for the markdown export (#216): title + metadata, the
// issue body, then every available artifact (plan, coder report, review, diff)
// separated by horizontal rules. Missing artifacts are skipped.

export interface DossierInput {
  item: TrackedItem;
  plan: StoredPlan | null;
  report: StoredCoderReport | null;
  diff: string | null;
}

export function dossierMarkdown({ item, plan, report, diff }: DossierInput): string {
  const composite = plan?.confidence?.composite ?? item.plan?.confidence;
  const header = joinBlocks([
    `# ${item.title} (${displayKey(item.key)})`,
    joinBlocks(
      [
        bullet("Repo", `${item.repo.owner}/${item.repo.name}`),
        bullet("Issue", item.url),
        bullet("State", item.state),
        composite != null ? bullet("Confidence", pct(composite)) : null,
      ],
      "\n",
    ),
  ]);

  const issue = item.body ? `## Issue\n\n${item.body}` : null;
  const diffBlock = diff && diff.trim() !== "" ? joinBlocks(["# Diff", fenceBlock(diff, "diff")]) : null;

  return joinBlocks(
    [
      header,
      issue,
      plan ? planMarkdown(plan) : null,
      report ? coderReportMarkdown(report) : null,
      item.review ? reviewMarkdown(item.review) : null,
      diffBlock,
    ],
    "\n\n---\n\n",
  );
}
