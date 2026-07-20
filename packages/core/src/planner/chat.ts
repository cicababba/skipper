import { displayKey } from "@skipper/shared";
import type { CodingEvent, IssuePlan, PlanChatMessage } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { MemoryMcp } from "../llm/memory-mcp";
import { planJsonSchema } from "./schema";
import { validatePlanReply } from "./generate";
import type { PlanIssueInput } from "./generate";

// Conversational plan review (#145): the reviewer chats with the same session
// that wrote the plan (resume path, cwd-scoped) or, when that session is gone,
// with a fresh run seeded from the issue + plan + transcript (fallback path).
// Two modes: Discuss (pure Q&A, plan untouched) and Apply (re-emit the plan).

const DEFAULT_CHAT_MAX_TURNS = 12;
const MAX_BODY_CHARS = 20_000;

export const PLAN_CHAT_SYSTEM_PROMPT = `You are the senior software engineer who wrote the implementation plan under review. A reviewer is discussing it with you before deciding whether to approve it.

Answer conversationally in markdown. You may use Read, Grep and Glob to verify facts against the repository at your current working directory. Do NOT modify any files. Unless explicitly asked to update the plan, do NOT output plan JSON — just answer the question.`;

export interface PlanChatContext {
  issue: PlanIssueInput;
  plan: IssuePlan;
  history: PlanChatMessage[];
}

export interface DiscussPlanOptions {
  message: string;
  llm: LLMProviderInterface;
  cwd: string;
  /** Resume the plan session (claude-cli); the model already holds the plan + repo. */
  resumeSessionId?: string;
  /** Issue + plan + transcript — required when there is no session to resume. */
  context?: PlanChatContext;
  /** Persist the fallback run under this session id (claude-cli only). */
  sessionId?: string;
  maxTurns?: number;
  onEvent?: (event: CodingEvent) => void;
  memory?: MemoryMcp;
  signal?: AbortSignal;
}

export interface ApplyPlanFromDiscussionOptions {
  llm: LLMProviderInterface;
  cwd: string;
  /** The CURRENT stored plan — always embedded: the session's memory is stale after inline edits. */
  plan: IssuePlan;
  resumeSessionId?: string;
  /** Fallback context — required when there is no session to resume. */
  issue?: PlanIssueInput;
  history?: PlanChatMessage[];
  sessionId?: string;
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

function planBlock(plan: IssuePlan): string {
  return `--- Current plan (JSON) ---\n${JSON.stringify(plan, null, 2)}\n--- End current plan ---`;
}

function buildDiscussResumePrompt(message: string): string {
  return [
    `A reviewer is asking about the plan you wrote, before deciding whether to approve it.`,
    `Answer conversationally. Do NOT re-emit or modify the plan.`,
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
    ...(history
      ? [``, `--- Conversation so far ---`, history, `--- End conversation ---`]
      : []),
    ``,
    `Reviewer: ${message}`,
  ].join("\n");
}

function buildApplyResumePrompt(plan: IssuePlan, schema: Record<string, unknown>): string {
  return [
    `Update the implementation plan to incorporate the conclusions reached in this discussion. Keep everything that was not discussed unchanged. Treat the JSON below as the current source of truth for the plan (it may differ from what you last emitted).`,
    ``,
    planBlock(plan),
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
): string {
  const rendered = renderHistory(history);
  return [
    `You wrote the implementation plan below for the issue that follows. Update it to incorporate the conclusions reached in the discussion. Keep everything that was not discussed unchanged.`,
    ``,
    issueHeader(issue),
    ``,
    planBlock(plan),
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
  const { llm, cwd, message } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_CHAT_MAX_TURNS;

  if (opts.resumeSessionId) {
    if (!llm.agent) throw new Error("resuming a plan session needs an agent-capable provider");
    const reply = await llm.agent(buildDiscussResumePrompt(message), {
      systemPrompt: PLAN_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      resumeSessionId: opts.resumeSessionId,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { reply: reply.text, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  if (!opts.context) throw new Error("discussPlan without a session needs context");
  const prompt = buildDiscussFallbackPrompt(opts.context, message);
  if (llm.agent) {
    const reply = await llm.agent(prompt, {
      systemPrompt: PLAN_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
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
  const { llm, cwd, plan } = opts;
  const schema = planJsonSchema();
  const maxTurns = opts.maxTurns ?? DEFAULT_CHAT_MAX_TURNS;

  if (opts.resumeSessionId) {
    if (!llm.agent) throw new Error("resuming a plan session needs an agent-capable provider");
    const reply = await llm.agent(buildApplyResumePrompt(plan, schema), {
      systemPrompt: PLAN_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      resumeSessionId: opts.resumeSessionId,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const updated = await validatePlanReply(llm, reply.text);
    return { plan: updated, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  if (opts.issue === undefined || opts.history === undefined) {
    throw new Error("applyPlanFromDiscussion without a session needs issue + history");
  }
  const prompt = buildApplyFallbackPrompt(plan, schema, opts.issue, opts.history);
  if (llm.agent) {
    const reply = await llm.agent(prompt, {
      systemPrompt: PLAN_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const updated = await validatePlanReply(llm, reply.text);
    return { plan: updated, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }
  const raw = await llm.askStructured<unknown>(prompt, schema);
  const updated = await validatePlanReply(llm, JSON.stringify(raw));
  return { plan: updated };
}
