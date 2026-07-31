import { displayKey, isPlanChatText } from "@skipper/shared";
import type {
  CodingEvent,
  ConfidenceReport,
  IssuePlan,
  PlanChatMessage,
} from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { AgentRuntime } from "../runtime/types";
import type { MemoryMcp } from "../llm/memory-mcp";
import type { RunConfinement } from "../llm/confinement";
import { planJsonSchema } from "./schema";
import { validatePlanReply } from "./generate";
import type { PlanIssueInput } from "./generate";
import { AGENT_CHAT_HARD_TIMEOUT_MS } from "../agent-chat/discuss";

// Conversational plan review (#145): the reviewer chats with the same session
// that wrote the plan (resume path, cwd-scoped) or, when that session is gone,
// with a fresh run seeded from the issue + plan + transcript (fallback path).
// Two modes: Discuss (pure Q&A, plan untouched) and Apply (re-emit the plan).

const DEFAULT_CHAT_MAX_TURNS = 12;
const MAX_BODY_CHARS = 20_000;

export const PLAN_CHAT_SYSTEM_PROMPT = `You are the senior software engineer who wrote the implementation plan under review. A reviewer is discussing it with you before deciding whether to approve it.

Answer conversationally in markdown. You may use Read, Grep and Glob to verify facts against the repository at your current working directory. Do NOT modify any files, including via Bash, and never touch anything outside your working directory — even if the conversation mentions absolute paths elsewhere on this machine. Unless explicitly asked to update the plan, do NOT output plan JSON — just answer the question.

A confidence report may be included — it was computed by an external scoring pipeline after you wrote the plan; treat its signals and objections as reviewer input, not as your own claims.`;

export interface PlanChatContext {
  issue: PlanIssueInput;
  plan: IssuePlan;
  history: PlanChatMessage[];
  confidence?: ConfidenceReport;
}

export interface DiscussPlanOptions {
  message: string;
  llm: LLMProviderInterface;
  /** Agentic runtime for the resume/fresh-agent paths (#238); absent = ask() only. */
  runtime?: AgentRuntime;
  cwd: string;
  /** Resume the plan session (claude-cli); the model already holds the plan + repo. */
  resumeSessionId?: string;
  /**
   * Confidence report to inject on the RESUME path — the resumed session holds
   * the plan + repo but NOT the score (scoring ran after the session ended).
   */
  confidence?: ConfidenceReport;
  /** Issue + plan + transcript — required when there is no session to resume. */
  context?: PlanChatContext;
  /** Persist the fallback run under this session id (claude-cli only). */
  sessionId?: string;
  maxTurns?: number;
  onEvent?: (event: CodingEvent) => void;
  memory?: MemoryMcp;
  signal?: AbortSignal;
  /** Keep the run inside its cwd (#196); passed only when cwd is the worktree. */
  confinement?: RunConfinement;
}

export interface ApplyPlanFromDiscussionOptions {
  llm: LLMProviderInterface;
  /** Agentic runtime for the resume/fresh-agent paths (#238); absent = askStructured only. */
  runtime?: AgentRuntime;
  cwd: string;
  /** The CURRENT stored plan — always embedded: the session's memory is stale after inline edits. */
  plan: IssuePlan;
  /** Confidence report — its critic objections are the input to "address the objections". */
  confidence?: ConfidenceReport;
  resumeSessionId?: string;
  /** Fallback context — required when there is no session to resume. */
  issue?: PlanIssueInput;
  history?: PlanChatMessage[];
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

function planBlock(plan: IssuePlan): string {
  return `--- Current plan (JSON) ---\n${JSON.stringify(plan, null, 2)}\n--- End current plan ---`;
}

const MAX_OBJECTION_DETAIL_CHARS = 400;
const MAX_LIST_ITEMS = 10;

function n2(x: number): string {
  return x.toFixed(2);
}

function capList(items: string[]): string {
  if (items.length <= MAX_LIST_ITEMS) return items.join(", ");
  return `${items.slice(0, MAX_LIST_ITEMS).join(", ")}, … +${items.length - MAX_LIST_ITEMS} more`;
}

/**
 * Compact text rendering of the confidence report for injection into the chat
 * context. Pure function (no I/O); only signals present in the report are shown.
 */
export function renderConfidenceBlock(report: ConfidenceReport): string {
  const lines: string[] = [
    `--- Confidence report (computed by the orchestrator's scoring pipeline after the plan was written) ---`,
  ];

  const w = report.weights;
  const s = report.signals;
  const weightParts: string[] = [];
  if (s.groundedness) weightParts.push(`groundedness ${n2(w.groundedness)}`);
  if (s.convergence) weightParts.push(`convergence ${n2(w.convergence)}`);
  if (s.critic) weightParts.push(`critic ${n2(w.critic)}`);
  if (s.clarity) weightParts.push(`clarity ${n2(w.clarity)}`);
  lines.push(
    `Composite: ${n2(report.composite)} (weighted over available signals; weights: ${weightParts.join(", ")})`,
  );

  if (s.groundedness) {
    const g = s.groundedness;
    const parts = [`files ${g.filesFound}/${g.filesChecked}`, `symbols ${g.symbolsFound}/${g.symbolsChecked}`];
    if (g.missingFiles.length > 0) parts.push(`missing files: ${capList(g.missingFiles)}`);
    if (g.missingSymbols.length > 0) parts.push(`missing symbols: ${capList(g.missingSymbols)}`);
    if (g.newFiles.length > 0) parts.push(`new files: ${capList(g.newFiles)}`);
    lines.push(`- groundedness ${n2(g.score)} — ${parts.join("; ")}`);
  }

  if (s.convergence) {
    const c = s.convergence;
    const parts = [
      `${c.planCount} plans`,
      `file Jaccard ${n2(c.fileJaccard)}`,
      `size agreement ${n2(c.sizeAgreement)}`,
      `step-count agreement ${n2(c.stepCountAgreement)}`,
      c.divergent ? "divergent" : "convergent",
    ];
    if (c.disputedFiles.length > 0) parts.push(`disputed files: ${capList(c.disputedFiles)}`);
    lines.push(`- convergence ${n2(c.score)} — ${parts.join("; ")}`);
  }

  if (s.critic) {
    const c = s.critic;
    lines.push(
      `- critic ${n2(c.score)} — verdict "${c.verdict}", ${c.objections.length} objection${c.objections.length === 1 ? "" : "s"}:`,
    );
    c.objections.forEach((o, i) => {
      const detail =
        o.detail.length > MAX_OBJECTION_DETAIL_CHARS
          ? `${o.detail.slice(0, MAX_OBJECTION_DETAIL_CHARS)}…`
          : o.detail;
      lines.push(`  ${i + 1}. [${o.kind}]${o.blocking ? " (blocking)" : ""} ${detail}`);
    });
  }

  if (s.clarity) {
    const c = s.clarity;
    lines.push(
      `- clarity ${n2(c.score)} — issue body present: ${c.bodyPresent ? "yes" : "no"}, acceptance criteria: ${c.hasAcceptanceCriteria ? "yes" : "no"}, repro steps: ${c.hasReproSteps ? "yes" : "no"}, open questions: ${c.openQuestionCount}`,
    );
  }

  if (report.convergenceSkipped) {
    lines.push(
      `- convergence: skipped (${report.convergenceSkipped.reason}) — ${report.convergenceSkipped.detail}`,
    );
  }

  if (report.errors.length > 0) {
    lines.push(`- errors: ${report.errors.join("; ")}`);
  }

  lines.push(`--- End confidence report ---`);
  return lines.join("\n");
}

function buildDiscussResumePrompt(message: string, confidence?: ConfidenceReport): string {
  return [
    `A reviewer is asking about the plan you wrote, before deciding whether to approve it.`,
    `Answer conversationally. Do NOT re-emit or modify the plan.`,
    ...(confidence ? [``, renderConfidenceBlock(confidence)] : []),
    ``,
    `Reviewer: ${message}`,
  ].join("\n");
}

function buildDiscussFallbackPrompt(ctx: PlanChatContext, message: string): string {
  const history = renderHistory(ctx.history);
  return [
    `You wrote the implementation plan below for the issue that follows. A reviewer is asking about it before deciding whether to approve it. Answer the latest question conversationally in markdown. Do NOT re-emit or modify the plan.`,
    ``,
    issueHeader(ctx.issue),
    ``,
    planBlock(ctx.plan),
    ...(ctx.confidence ? [``, renderConfidenceBlock(ctx.confidence)] : []),
    ...(history
      ? [``, `--- Conversation so far ---`, history, `--- End conversation ---`]
      : []),
    ``,
    `Reviewer: ${message}`,
  ].join("\n");
}

function buildApplyResumePrompt(
  plan: IssuePlan,
  schema: Record<string, unknown>,
  confidence?: ConfidenceReport,
): string {
  return [
    `Update the implementation plan to incorporate the conclusions reached in this discussion. Keep everything that was not discussed unchanged. Treat the JSON below as the current source of truth for the plan (it may differ from what you last emitted).`,
    ``,
    planBlock(plan),
    ...(confidence ? [``, renderConfidenceBlock(confidence)] : []),
    ``,
    `Your FINAL message must be ONLY a single JSON object matching this JSON Schema. No prose, no code fences, no preamble.`,
    ``,
    `Schema:`,
    JSON.stringify(schema),
  ].join("\n");
}

function buildApplyFallbackPrompt(
  plan: IssuePlan,
  schema: Record<string, unknown>,
  issue: PlanIssueInput,
  history: PlanChatMessage[],
  confidence?: ConfidenceReport,
): string {
  const rendered = renderHistory(history);
  return [
    `You wrote the implementation plan below for the issue that follows. Update it to incorporate the conclusions reached in the discussion. Keep everything that was not discussed unchanged.`,
    ``,
    issueHeader(issue),
    ``,
    planBlock(plan),
    ...(confidence ? [``, renderConfidenceBlock(confidence)] : []),
    ...(rendered
      ? [``, `--- Conversation so far ---`, rendered, `--- End conversation ---`]
      : []),
    ``,
    `Your FINAL message must be ONLY a single JSON object matching this JSON Schema. No prose, no code fences, no preamble.`,
    ``,
    `Schema:`,
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Answer a reviewer's question about the plan. Resumes the plan session when
 * one is available (the model still holds the plan and its repo exploration);
 * otherwise runs a fresh, fully-seeded turn. The plan is never modified.
 */
export async function discussPlan(
  opts: DiscussPlanOptions,
): Promise<{ reply: string; sessionId?: string }> {
  const { llm, runtime, cwd, message } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_CHAT_MAX_TURNS;

  if (opts.resumeSessionId) {
    if (!runtime) throw new Error("resuming a plan session needs an agent-capable runtime");
    const reply = await runtime.agent(buildDiscussResumePrompt(message, opts.confidence), {
      systemPrompt: PLAN_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
      resumeSessionId: opts.resumeSessionId,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.confinement ? { confinement: opts.confinement } : {}),
    });
    return { reply: reply.text, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  if (!opts.context) throw new Error("discussPlan without a session needs context");
  const prompt = buildDiscussFallbackPrompt(opts.context, message);
  if (runtime) {
    const reply = await runtime.agent(prompt, {
      systemPrompt: PLAN_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.confinement ? { confinement: opts.confinement } : {}),
    });
    return { reply: reply.text, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }
  const reply = await llm.ask(prompt, PLAN_CHAT_SYSTEM_PROMPT);
  return { reply: reply.text };
}

/**
 * Re-emit the complete plan JSON amended with the discussion's conclusions,
 * validated (with a repair round) against the plan schema. The current stored
 * plan is always embedded as the source of truth — the session's memory of the
 * plan is stale after any inline edit.
 */
export async function applyPlanFromDiscussion(
  opts: ApplyPlanFromDiscussionOptions,
): Promise<{ plan: IssuePlan; sessionId?: string }> {
  const { llm, runtime, cwd, plan } = opts;
  const schema = planJsonSchema();
  const maxTurns = opts.maxTurns ?? DEFAULT_CHAT_MAX_TURNS;

  if (opts.resumeSessionId) {
    if (!runtime) throw new Error("resuming a plan session needs an agent-capable runtime");
    const reply = await runtime.agent(buildApplyResumePrompt(plan, schema, opts.confidence), {
      systemPrompt: PLAN_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
      resumeSessionId: opts.resumeSessionId,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.confinement ? { confinement: opts.confinement } : {}),
    });
    const updated = await validatePlanReply(runtime, llm, reply.text, opts.signal);
    return { plan: updated, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  if (opts.issue === undefined || opts.history === undefined) {
    throw new Error("applyPlanFromDiscussion without a session needs issue + history");
  }
  const prompt = buildApplyFallbackPrompt(plan, schema, opts.issue, opts.history, opts.confidence);
  if (runtime) {
    const reply = await runtime.agent(prompt, {
      systemPrompt: PLAN_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.confinement ? { confinement: opts.confinement } : {}),
    });
    const updated = await validatePlanReply(runtime, llm, reply.text, opts.signal);
    return { plan: updated, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }
  const raw = await llm.askStructured<unknown>(prompt, schema, opts.signal ? { signal: opts.signal } : undefined);
  const updated = await validatePlanReply(runtime, llm, JSON.stringify(raw), opts.signal);
  return { plan: updated };
}
