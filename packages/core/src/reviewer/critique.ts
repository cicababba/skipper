import type { CriticSignal, PlanAcceptance } from "@nestbrain/shared";
import type { LLMProviderInterface } from "../llm";
import type { PlanIssueInput } from "../planner";
import { runCritic } from "../confidence";

// Second mount point of the #8 adversarial critic (issue #10): same
// component, artifactKind "diff". Core stays git-free — the diff arrives
// as a string; capture lives in the desktop layer.

/** askStructured is single-turn — bound the prompt. ~30k tokens. */
export const DIFF_CHAR_BUDGET = 120_000;

const MAX_BODY_CHARS = 20_000;

export function truncateDiff(
  diff: string,
  budget = DIFF_CHAR_BUDGET,
): { text: string; truncated: boolean } {
  if (diff.length <= budget) return { text: diff, truncated: false };
  return {
    text: `${diff.slice(0, budget)}\n[diff truncated — showing first ${budget} of ${diff.length} characters]`,
    truncated: true,
  };
}

export interface CritiqueDiffArgs {
  /** Unified diff of the worktree (uncommitted changes vs HEAD). */
  diff: string;
  issue: PlanIssueInput;
  /** The plan's acceptance mapping — what the reviewer reviews AGAINST. */
  acceptance: PlanAcceptance[];
}

export async function critiqueDiff(
  args: CritiqueDiffArgs,
  llm: LLMProviderInterface,
): Promise<CriticSignal> {
  const { issue, acceptance } = args;
  const body =
    issue.body && issue.body.length > MAX_BODY_CHARS
      ? `${issue.body.slice(0, MAX_BODY_CHARS)}\n[... issue body truncated ...]`
      : issue.body;
  const context = [
    `Issue #${issue.number}: ${issue.title}`,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
    body ?? "(no issue body)",
    ``,
    acceptance.length > 0
      ? `Acceptance criteria:\n${acceptance.map((a) => `- ${a.criterion}`).join("\n")}`
      : `(No explicit acceptance criteria — review strictly against the issue body.)`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return runCritic(
    {
      artifactKind: "diff",
      artifactLabel: `working-tree diff for issue #${issue.number}: ${issue.title}`,
      artifact: truncateDiff(args.diff).text,
      context,
    },
    llm,
  );
}
