import { displayKey, isPlanChatText } from "@skipper/shared";
import type {
  AgentReviewOutcome,
  CodingEvent,
  CriticObjection,
  PlanChatMessage,
} from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { AgentRuntime } from "../runtime/types";
import type { MemoryMcp } from "../llm/memory-mcp";
import type { RunConfinement } from "../llm/confinement";
import type { PlanIssueInput } from "../planner/generate";
import { renderCoderReportBlock } from "../coder/chat";
import type { CoderChatContext } from "../coder/chat";
import { runAgentDiscussion } from "../agent-chat/discuss";

// Reviewer chat (#170): interrogate the code reviewer who reviewed the working-
// tree diff. Discuss-only — the chat can neither modify files nor change the
// review outcome. Resumes the last critic round's session when it survives, else
// runs a fresh, fully-seeded turn from the issue + plan + report + review + transcript.

const MAX_BODY_CHARS = 20_000;
const MAX_OBJECTION_DETAIL_CHARS = 400;

export const REVIEWER_CHAT_SYSTEM_PROMPT = `You are the code reviewer who reviewed the working-tree diff for this issue. The user is asking you about your review.

Answer conversationally in markdown. Your current working directory is the git worktree under review — you may read, search and list files, and run read-only shell commands, to verify facts against it. You cannot change the review outcome from here, and you must NOT modify any files, including via your shell, and never touch anything outside your working directory — even if the conversation mentions absolute paths elsewhere on this machine. Just answer the question.`;

export interface ReviewerChatContext extends CoderChatContext {
  review: {
    outcome: AgentReviewOutcome;
    rounds: number;
    reason?: string;
    objections?: CriticObjection[];
  };
}

export interface DiscussReviewerOptions {
  message: string;
  llm: LLMProviderInterface;
  /** Agentic runtime for the resume/fresh-agent paths (#238); absent = ask() only. */
  runtime?: AgentRuntime;
  cwd: string;
  /** Resume the last critic round's session (claude-cli). */
  resumeSessionId?: string;
  /** Issue + plan + report + review + transcript — required when there is no session. */
  context?: ReviewerChatContext;
  /** Persist the fallback run under this session id (claude-cli only). */
  sessionId?: string;
  maxTurns?: number;
  onEvent?: (event: CodingEvent) => void;
  memory?: MemoryMcp;
  signal?: AbortSignal;
  /** Keep the run inside its cwd (#196); passed only when cwd is the worktree. */
  confinement?: RunConfinement;
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
    .filter(isPlanChatText)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
}

function reviewBlock(review: ReviewerChatContext["review"]): string {
  const lines: string[] = [
    `--- Review outcome ---`,
    `Verdict: ${review.outcome} (round ${review.rounds})`,
  ];
  if (review.reason) lines.push(`Reason: ${review.reason}`);
  if (review.objections && review.objections.length > 0) {
    lines.push(`Objections:`);
    review.objections.forEach((o, i) => {
      const detail =
        o.detail.length > MAX_OBJECTION_DETAIL_CHARS
          ? `${o.detail.slice(0, MAX_OBJECTION_DETAIL_CHARS)}…`
          : o.detail;
      lines.push(
        `  ${i + 1}. [${o.kind}]${o.blocking ? " (blocking)" : ""}${o.unverified ? " (unverified)" : ""} ${detail}`,
      );
    });
  }
  lines.push(`--- End review outcome ---`);
  return lines.join("\n");
}

function buildResumePrompt(message: string): string {
  return [
    `The user is asking about the review you performed on this working-tree diff.`,
    `Answer conversationally. You cannot change the outcome, and do NOT modify any files.`,
    ``,
    `User: ${message}`,
  ].join("\n");
}

function buildFallbackPrompt(ctx: ReviewerChatContext, message: string): string {
  const history = renderHistory(ctx.history);
  return [
    `You reviewed the working-tree diff for the issue below in the git worktree at your current working directory. The user is asking about your review. Answer the latest question conversationally in markdown. You cannot change the outcome, and do NOT modify any files.`,
    ``,
    issueHeader(ctx.issue),
    ...(ctx.plan
      ? [``, `--- Approved plan (JSON) ---`, JSON.stringify(ctx.plan, null, 2), `--- End approved plan ---`]
      : []),
    ...(ctx.report ? [``, renderCoderReportBlock(ctx.report)] : []),
    ``,
    reviewBlock(ctx.review),
    ...(history ? [``, `--- Conversation so far ---`, history, `--- End conversation ---`] : []),
    ``,
    `User: ${message}`,
  ].join("\n");
}

/**
 * Answer a user's question about the reviewer's verdict. Resumes the last critic
 * round's session when available; otherwise runs a fresh, fully-seeded turn. The
 * review outcome is never changed and no file is modified.
 */
export async function discussReviewer(
  opts: DiscussReviewerOptions,
): Promise<{ reply: string; sessionId?: string }> {
  const { llm, cwd, message } = opts;
  const prompt = opts.resumeSessionId
    ? buildResumePrompt(message)
    : opts.context
      ? buildFallbackPrompt(opts.context, message)
      : undefined;
  if (prompt === undefined) throw new Error("discussReviewer without a session needs context");

  return runAgentDiscussion({
    llm,
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    cwd,
    systemPrompt: REVIEWER_CHAT_SYSTEM_PROMPT,
    prompt,
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.confinement ? { confinement: opts.confinement } : {}),
  });
}
