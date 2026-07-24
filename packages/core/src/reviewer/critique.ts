import { displayKey, type CoderReport, type CriticSignal, type PlanAcceptance } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm";
import type { AgentRuntime } from "../runtime/types";
import type { PlanIssueInput } from "../planner";
import { runCritic, type CriticPriorRound } from "../confidence";

// Second mount point of the #8 adversarial critic (issue #10): same
// component, artifactKind "diff". Core stays git-free — the diff arrives
// as a string; capture lives in the desktop layer.

/** Bound the prompt even though the diff reviewer runs askStructured in
 *  bounded-tools mode (Read/Grep/Glob) — the diff itself is the artifact. ~30k tokens. */
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
  /** The coder's structured report (#146) — declared deviations + verification
   *  as review context, never a verdict gate. */
  report?: CoderReport;
  /** Persist this round under a session (#111). id + cwd are bundled — a session
   *  id is only resumable from the worktree it was minted in. */
  session?: { id: string; cwd: string };
  /** Prior review round for continuity classification (#205). */
  prior?: CriticPriorRound;
  /** The planner's verified repo facts (IssuePlan.context) — grounds the reviewer
   *  so it trusts these over its own assumptions (#226). */
  planContext?: string[];
}

export async function critiqueDiff(
  args: CritiqueDiffArgs,
  llm: LLMProviderInterface,
  runtime?: AgentRuntime,
): Promise<CriticSignal> {
  const { issue, acceptance } = args;
  const body =
    issue.body && issue.body.length > MAX_BODY_CHARS
      ? `${issue.body.slice(0, MAX_BODY_CHARS)}\n[... issue body truncated ...]`
      : issue.body;
  const report = args.report;
  const deviationsBlock = report
    ? report.deviations.length > 0
      ? `Coder-declared deviations from the plan:\n${report.deviations.map((d) => `- ${d}`).join("\n")}`
      : `The coder declared NO deviations from the plan — treat any drift you find in the diff as silent, undeclared drift.`
    : "";
  const verificationBlock =
    report && report.verification.length > 0
      ? `Verification commands the coder ran:\n${report.verification
          .map((v) => `- [${v.passed ? "PASS" : "FAIL"}] ${v.command}${v.detail ? ` — ${v.detail}` : ""}`)
          .join("\n")}`
      : "";
  const context = [
    `Issue ${displayKey(issue.key)}: ${issue.title}`,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
    body ?? "(no issue body)",
    ``,
    acceptance.length > 0
      ? `Acceptance criteria:\n${acceptance.map((a) => `- ${a.criterion}`).join("\n")}`
      : `(No explicit acceptance criteria — review strictly against the issue body.)`,
    args.planContext && args.planContext.length > 0
      ? `Verified repo facts from the planner (trust these over your own assumptions):\n${args.planContext
          .map((c) => `- ${c}`)
          .join("\n")}`
      : "",
    deviationsBlock,
    verificationBlock,
  ]
    .filter((l) => l !== "")
    .join("\n");

  // Repo-inspecting critic only when a session is minted AND a runtime can host
  // the tools-enabled call (#238); otherwise the plain diff critic.
  const inspect = args.session !== undefined && runtime !== undefined;
  return runCritic(
    {
      artifactKind: "diff",
      artifactLabel: `working-tree diff for issue ${displayKey(issue.key)}: ${issue.title}`,
      artifact: truncateDiff(args.diff).text,
      context,
      ...(args.prior ? { prior: args.prior } : {}),
      ...(inspect ? { canInspectRepo: true } : {}),
    },
    llm,
    inspect
      ? { runtime, cwd: args.session!.cwd, sessionId: args.session!.id, tools: "Read,Grep,Glob", maxTurns: 8 }
      : undefined,
  );
}
