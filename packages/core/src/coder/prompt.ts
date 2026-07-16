import { displayKey, type CriticObjection, type IssuePlan, type PrReviewComment } from "@skipper/shared";
import type { PlanIssueInput } from "../planner/generate";

const MAX_BODY_CHARS = 20_000;

export const CODER_SYSTEM_PROMPT = `You are a senior software engineer implementing a GitHub issue in the repository at your current working directory. The directory is an isolated git worktree with the correct feature branch already checked out.

Implement the provided plan. Follow the repository's existing conventions (naming, formatting, error handling, test style). Where the plan cites files and symbols, ground your changes in them; if reality diverges from the plan, adapt and note the deviation in your final message.

When the skipper-memory tools are available, before writing code call search_memory with a short description of this issue to find how similar issues were solved in this repo, and get_memory(id) for the full plan + diff of a promising hit — reuse the established approach and conventions.

Do NOT run git commit, git push, or any branch operation (checkout, branch, merge, rebase) — your changes are reviewed as uncommitted working-tree modifications. Run the project's tests with Bash where cheap to verify your work.

Your final message must be a concise summary of the changes you made and any deviations from the plan.`;

function issueHeader(issue: PlanIssueInput): string[] {
  const body =
    issue.body && issue.body.length > MAX_BODY_CHARS
      ? `${issue.body.slice(0, MAX_BODY_CHARS)}\n[... issue body truncated ...]`
      : issue.body;
  return [
    `Issue ${displayKey(issue.key)}: ${issue.title}`,
    `URL: ${issue.url}`,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
    ``,
    body ? `--- Issue body ---\n${body}\n--- End issue body ---` : `(The issue has no body.)`,
  ];
}

export function buildCoderPrompt(issue: PlanIssueInput, plan: IssuePlan): string {
  const lines = [
    `Implement this GitHub issue following the plan below.`,
    ``,
    ...issueHeader(issue),
    ``,
    `--- Plan ---`,
    `Summary: ${plan.summary}`,
    ``,
    `Files:`,
    ...plan.files.map((f) => `- ${f.path}${f.status === "new" ? " (new)" : ""} — ${f.reason}`),
    ``,
    `Steps:`,
    ...plan.steps.map((s, i) => {
      const refs = [
        s.files.length > 0 ? `files: ${s.files.join(", ")}` : "",
        s.symbols.length > 0 ? `symbols: ${s.symbols.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      return `${i + 1}. ${s.title} — ${s.detail}${refs ? ` (${refs})` : ""}`;
    }),
    ``,
    plan.acceptance.length > 0
      ? `Acceptance criteria:\n${plan.acceptance
          .map((a) => `- ${a.criterion} (addressed by: ${a.addressedBy})`)
          .join("\n")}`
      : "",
    plan.risks.length > 0 ? `Risks:\n${plan.risks.map((r) => `- ${r}`).join("\n")}` : "",
    `--- End plan ---`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Reviewer-driven fix round (#10). Plan-free and self-sufficient so the same
 * prompt works for a resumed session and a fresh fallback session.
 */
export function buildFixPrompt(issue: PlanIssueInput, objections: CriticObjection[]): string {
  return [
    `An independent reviewer examined your uncommitted changes for this issue and raised objections. Address the blocking ones; use your judgment on the rest.`,
    ``,
    ...issueHeader(issue),
    ``,
    `--- Reviewer objections ---`,
    ...objections.map(
      (o) => `- ${o.blocking ? "[BLOCKING] " : ""}(${o.kind}) ${o.detail}`,
    ),
    `--- End objections ---`,
    ``,
    `Inspect the working tree (git status, git diff) to see the current implementation, then fix. The same rules apply: no git commit/push/branch operations; finish with a concise summary of all changes.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Change-request re-entry (#11). Plan-free and self-sufficient so the same
 * prompt works for a resumed session and a fresh fallback session.
 */
export function buildPrFixPrompt(issue: PlanIssueInput, comments: PrReviewComment[]): string {
  return [
    `A human reviewer requested changes on the pull request for this issue. Address the review feedback below.`,
    ``,
    ...issueHeader(issue),
    ``,
    `--- Review feedback ---`,
    ...comments.map((c) => {
      const where = c.path ? ` on ${c.path}${c.line != null ? `:${c.line}` : ""}` : "";
      return `- ${c.author ?? "reviewer"}${where}: ${c.body}`;
    }),
    `--- End review feedback ---`,
    ``,
    `The pushed commits are already on this branch. Inspect the working tree and history (git status, git diff, git log) to see the current implementation, then address the feedback. The same rules apply: no git commit/push/branch operations; finish with a concise summary of all changes.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Re-entry after an interrupted run: the session already carries the plan context. */
export function buildResumePrompt(issue: PlanIssueInput): string {
  return [
    `The previous coding session for this issue was interrupted. Continue executing the plan.`,
    ``,
    ...issueHeader(issue),
    ``,
    `Inspect the working tree (git status, git diff) to see what has already been done, then complete the remaining work. The same rules apply: no git commit/push/branch operations; finish with a concise summary of all changes.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
