import { displayKey } from "@skipper/shared";
import type { CoderReport, CodingEvent, IssuePlan, PlanChatMessage } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { MemoryMcp } from "../llm/memory-mcp";
import type { PlanIssueInput } from "../planner/generate";
import { runAgentDiscussion } from "../agent-chat/discuss";

// Coder chat (#170): interrogate the software engineer who implemented the diff
// in this worktree. Discuss-only — the chat never modifies any file. Resumes the
// coding session (repo exploration intact) when it survives, else runs a fresh,
// fully-seeded turn from the issue + plan + coder report + transcript.

const MAX_BODY_CHARS = 20_000;

export const CODER_CHAT_SYSTEM_PROMPT = `You are the software engineer who implemented the changes in this worktree. The reviewer is asking you about your implementation before deciding what to do with it.

Answer conversationally in markdown. Your current working directory is the git worktree that holds your changes — you may use Read, Grep, Glob and read-only Bash to verify facts against it. Do NOT modify any files, and do NOT re-emit the plan or the coder report — just answer the question.`;

export interface CoderChatContext {
  issue: PlanIssueInput;
  plan?: IssuePlan;
  report?: CoderReport;
  history: PlanChatMessage[];
}

export interface DiscussCoderOptions {
  message: string;
  llm: LLMProviderInterface;
  cwd: string;
  /** Resume the coding session (claude-cli); the model already holds its work. */
  resumeSessionId?: string;
  /** Issue + plan + report + transcript — required when there is no session to resume. */
  context?: CoderChatContext;
  /** Persist the fallback run under this session id (claude-cli only). */
  sessionId?: string;
  /** The file the user currently has open in the worktree, treated as the subject. */
  selectedFile?: string;
  maxTurns?: number;
  onEvent?: (event: CodingEvent) => void;
  memory?: MemoryMcp;
  signal?: AbortSignal;
}

function issueHeader(issue: PlanIssueInput): string {
  const body =
    issue.body && issue.body.length > MAX_BODY_CHARS
      ? `${issue.body.slice(0, MAX_BODY_CHARS)}\n[... issue body truncated ...]`
      : issue.body;
  return [
    `Issue ${displayKey(issue.key)}: ${issue.title}`,
    `URL: ${issue.url}`,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
    body ? `--- Issue body ---\n${body}\n--- End issue body ---` : "(The issue has no body.)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function renderHistory(history: PlanChatMessage[]): string {
  return history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
}

function selectedFileLine(selectedFile?: string): string[] {
  if (!selectedFile) return [];
  return [
    ``,
    `The user currently has \`${selectedFile}\` selected in the worktree — treat it as the subject unless they say otherwise.`,
  ];
}

/** Compact rendering of the coder report for injection into the fallback context. */
export function renderCoderReportBlock(report: CoderReport): string {
  const lines: string[] = [`--- Coder report ---`];
  if (report.done.length > 0) {
    lines.push(`Done:`);
    for (const d of report.done) lines.push(`- ${d.path} — ${d.summary}`);
  }
  lines.push(
    report.deviations.length > 0
      ? `Deviations:\n${report.deviations.map((d) => `- ${d}`).join("\n")}`
      : `Deviations: none declared.`,
  );
  if (report.verification.length > 0) {
    lines.push(
      `Verification:\n${report.verification
        .map((v) => `- [${v.passed ? "PASS" : "FAIL"}] ${v.command}${v.detail ? ` — ${v.detail}` : ""}`)
        .join("\n")}`,
    );
  }
  if (report.open.length > 0) {
    lines.push(`Open:\n${report.open.map((o) => `- ${o}`).join("\n")}`);
  }
  lines.push(`--- End coder report ---`);
  return lines.join("\n");
}

function buildResumePrompt(message: string, selectedFile?: string): string {
  return [
    `The reviewer is asking about the changes you implemented in this worktree.`,
    `Answer conversationally. Do NOT modify any files or re-emit the plan or report.`,
    ...selectedFileLine(selectedFile),
    ``,
    `Reviewer: ${message}`,
  ].join("\n");
}

function buildFallbackPrompt(ctx: CoderChatContext, message: string, selectedFile?: string): string {
  const history = renderHistory(ctx.history);
  return [
    `You implemented the changes for the issue below in the git worktree at your current working directory, following the approved plan. The reviewer is asking about your implementation. Answer the latest question conversationally in markdown. Do NOT modify any files or re-emit the plan or report.`,
    ``,
    issueHeader(ctx.issue),
    ...(ctx.plan
      ? [``, `--- Approved plan (JSON) ---`, JSON.stringify(ctx.plan, null, 2), `--- End approved plan ---`]
      : []),
    ...(ctx.report ? [``, renderCoderReportBlock(ctx.report)] : []),
    ...(history ? [``, `--- Conversation so far ---`, history, `--- End conversation ---`] : []),
    ...selectedFileLine(selectedFile),
    ``,
    `Reviewer: ${message}`,
  ].join("\n");
}

/**
 * Answer a reviewer's question about the coder's implementation. Resumes the
 * coding session when one is available; otherwise runs a fresh, fully-seeded
 * turn. Never modifies any file.
 */
export async function discussCoder(
  opts: DiscussCoderOptions,
): Promise<{ reply: string; sessionId?: string }> {
  const { llm, cwd, message } = opts;
  const prompt = opts.resumeSessionId
    ? buildResumePrompt(message, opts.selectedFile)
    : opts.context
      ? buildFallbackPrompt(opts.context, message, opts.selectedFile)
      : undefined;
  if (prompt === undefined) throw new Error("discussCoder without a session needs context");

  return runAgentDiscussion({
    llm,
    cwd,
    systemPrompt: CODER_CHAT_SYSTEM_PROMPT,
    prompt,
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}
