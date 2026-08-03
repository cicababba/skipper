import {
  displayKey,
  type CoderReport,
  type CriticObjection,
  type IssuePlan,
  type PrReviewComment,
} from "@skipper/shared";
import { renderCommentsBlock } from "../planner/prompt";
import type { PlanIssueInput } from "../planner/generate";
import { reportContractBlock } from "./report";

const MAX_BODY_CHARS = 20_000;

export const CODER_SYSTEM_PROMPT = `You are a senior software engineer implementing an issue in the repository at your current working directory. The directory is an isolated git worktree with the correct feature branch already checked out.

Implement the provided plan. Follow the repository's existing conventions (naming, formatting, error handling, test style). Where the plan cites files and symbols, ground your changes in them; if reality diverges from the plan, adapt and note the deviation in your final message.

When the skipper-memory tools are available, before writing code call search_memory with a short description of this issue to find how similar issues were solved in this repo, and get_memory(id) for the full plan + diff of a promising hit — reuse the established approach and conventions.

Operate ONLY inside your current working directory. Use RELATIVE paths for every file operation. Never write, edit, copy or move files outside it — even if the issue, plan or conversation mentions absolute paths elsewhere on this machine.

Do NOT run git commit, git push, or any branch operation (checkout, branch, merge, rebase) — your changes are reviewed as uncommitted working-tree modifications. Run the project's tests with Bash where cheap to verify your work.

Your final message must be ONLY a single JSON object matching the schema given in the task prompt — no prose, no code fences. Record every file you changed under "done", declare every deviation from the plan under "deviations" (empty array if none), record each verification command you ran with its outcome under "verification", and list any unresolved conflicts, questions, or skipped steps under "open".`;

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
    renderCommentsBlock(issue.comments) ?? "",
  ];
}

function renderPlanBlock(plan: IssuePlan): string[] {
  return [
    `--- Plan ---`,
    `Summary: ${plan.summary}`,
    ``,
    `Files:`,
    ...plan.files.map((f) => `- ${f.path}${f.status === "new" ? " (new)" : ""} — ${f.reason}`),
    ``,
    plan.context?.length
      ? `Context (verified repo facts):\n${plan.context.map((c) => `- ${c}`).join("\n")}\n`
      : "",
    `Steps:`,
    ...plan.steps.map((s, i) => {
      const refs = [
        s.files.length > 0 ? `files: ${s.files.join(", ")}` : "",
        s.symbols.length > 0 ? `symbols: ${s.symbols.join(", ")}` : "",
        s.createdSymbols?.length ? `creates: ${s.createdSymbols.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      return `${i + 1}. ${s.title} — ${s.detail}${refs ? ` (${refs})` : ""}`;
    }),
    ``,
    plan.outOfScope?.length
      ? `Out of scope — do NOT touch:\n${plan.outOfScope.map((o) => `- ${o}`).join("\n")}`
      : "",
    plan.acceptance.length > 0
      ? `Acceptance criteria:\n${plan.acceptance
          .map((a) => `- ${a.criterion} (addressed by: ${a.addressedBy})`)
          .join("\n")}`
      : "",
    plan.risks.length > 0 ? `Risks:\n${plan.risks.map((r) => `- ${r}`).join("\n")}` : "",
    plan.verificationCommands?.length
      ? `Before reporting done, run these commands and make sure they pass:\n${plan.verificationCommands
          .map((c) => `- ${c}`)
          .join("\n")}`
      : "",
    plan.manualChecks?.length
      ? `Manual checks (for the human reviewer):\n${plan.manualChecks.map((m) => `- ${m}`).join("\n")}`
      : "",
    `--- End plan ---`,
  ];
}

export function buildCoderPrompt(issue: PlanIssueInput, plan: IssuePlan): string {
  const lines = [
    `Implement this issue following the plan below.`,
    ``,
    ...issueHeader(issue),
    ``,
    ...renderPlanBlock(plan),
    ``,
    reportContractBlock(),
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
      (o) =>
        `- ${o.blocking ? "[BLOCKING] " : ""}${o.unverified ? "[UNVERIFIED] " : ""}(${o.kind}) ${o.detail}`,
    ),
    `--- End objections ---`,
    ``,
    `An [UNVERIFIED] objection is the reviewer's open question, not an established defect: confirm it against the tree before changing any code, and if it turns out to be wrong answer it in the report's "open" array instead.`,
    ``,
    `Inspect the working tree (git status, git diff) to see the current implementation, then fix. The same rules apply: no git commit/push/branch operations.`,
    ``,
    `Verify each objection against the working tree before acting on it. If an objection is factually wrong — it misreads the code or asserts a repo fact that isn't true — do not comply blindly: leave the code as is and record the evidence in the report's "open" array so the next review round sees the dispute.`,
    ``,
    reportContractBlock(),
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
    `The pushed commits are already on this branch. Inspect the working tree and history (git status, git diff, git log) to see the current implementation, then address the feedback. The same rules apply: no git commit/push/branch operations.`,
    ``,
    reportContractBlock(),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Budget-death salvage (#194): the run hit its time budget, turn backstop, or the
 * inactivity ceiling. Resumed against the dead session — which already holds the
 * issue + plan context (planner salvage precedent), so no issue header. Extracts an
 * honest final report from work-so-far rather than losing the paid session.
 */
export function buildCoderSalvagePrompt(): string {
  return [
    `You ran out of your budget for this coding run. Do NOT make any further code changes and do NOT edit or write any files.`,
    ``,
    `You may run a quick read-only \`git status\` and \`git diff --stat\` to see what you have already changed, then reply NOW with the final report JSON.`,
    ``,
    `Report honestly: list every file you actually changed under "done"; record any work you left incomplete or could not verify under "deviations" and "open" — do not claim work you did not finish.`,
    ``,
    reportContractBlock(),
  ].join("\n");
}

/** Durable prior-work context for a recap re-entry (#240). Every field is
 *  best-effort: whatever survived on disk, never the lost transcript. */
export interface CoderRecapInput {
  plan: IssuePlan;
  /** Last run's structured report, when one was persisted. */
  report?: CoderReport;
  /** Reviewer objections still pending on the item. */
  objections?: CriticObjection[];
  /** Human PR feedback still pending — outranks objections, as in the coder driver. */
  prComments?: PrReviewComment[];
  /** Uncommitted paths in the worktree — the ground truth about prior work. */
  dirtyPaths?: string[];
}

function renderReportBlock(report: CoderReport): string[] {
  return [
    `--- Report from the previous session ---`,
    report.done.length > 0
      ? `Done:\n${report.done.map((d) => `- ${d.path} — ${d.summary}`).join("\n")}`
      : `Done: (nothing recorded)`,
    report.deviations.length > 0
      ? `Deviations from the plan:\n${report.deviations.map((d) => `- ${d}`).join("\n")}`
      : "",
    report.verification.length > 0
      ? `Verification run:\n${report.verification
          .map((v) => `- ${v.command} — ${v.passed ? "passed" : "FAILED"}${v.detail ? `: ${v.detail}` : ""}`)
          .join("\n")}`
      : "",
    report.open.length > 0 ? `Left open:\n${report.open.map((o) => `- ${o}`).join("\n")}` : "",
    `--- End report ---`,
  ];
}

/**
 * Re-entry on a different agent runtime (#240). The previous session belongs to
 * another CLI and cannot be resumed, so the work already in the worktree is
 * reconstructed from durable artifacts — the stored report, pending feedback, the
 * plan and the dirty-file list — instead of being restarted from scratch.
 */
export function buildCoderRecapPrompt(issue: PlanIssueInput, recap: CoderRecapInput): string {
  const feedback =
    recap.prComments?.length
      ? [
          `--- Pending review feedback (address this) ---`,
          ...recap.prComments.map((c) => {
            const where = c.path ? ` on ${c.path}${c.line != null ? `:${c.line}` : ""}` : "";
            return `- ${c.author ?? "reviewer"}${where}: ${c.body}`;
          }),
          `--- End review feedback ---`,
        ]
      : recap.objections?.length
        ? [
            `--- Pending reviewer objections (address the blocking ones) ---`,
            ...recap.objections.map(
              (o) => `- ${o.blocking ? "[BLOCKING] " : ""}(${o.kind}) ${o.detail}`,
            ),
            `--- End objections ---`,
          ]
        : [];
  return [
    `Work on this issue is already in progress in your working directory. The previous coding session ran on a different agent and its transcript is unavailable, so the summary below is all that survives of it.`,
    ``,
    `Do NOT restart the work from scratch and do NOT revert what is already there. Continue from the current state of the working tree.`,
    ``,
    ...issueHeader(issue),
    ``,
    ...renderPlanBlock(recap.plan),
    ``,
    ...(recap.report ? renderReportBlock(recap.report) : [`No report from the previous session survived.`]),
    ``,
    ...feedback,
    ``,
    recap.dirtyPaths?.length
      ? `Files left uncommitted in the working tree by the previous session:\n${recap.dirtyPaths
          .map((p) => `- ${p}`)
          .join("\n")}`
      : `The working tree has no uncommitted changes — the previous session may have left nothing behind.`,
    ``,
    `Start by running git status and git diff to see the real state of the tree. Where the tree and the summary above disagree, trust the tree: the summary can be stale or wrong. Then finish the remaining work. The same rules apply: no git commit/push/branch operations.`,
    ``,
    reportContractBlock(),
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
    `Inspect the working tree (git status, git diff) to see what has already been done, then complete the remaining work. The same rules apply: no git commit/push/branch operations.`,
    ``,
    reportContractBlock(),
  ]
    .filter((l) => l !== "")
    .join("\n");
}
