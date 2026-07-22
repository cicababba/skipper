import { displayKey, isPlanChatText } from "@skipper/shared";
import type { CoderReport, CodingEvent, IssuePlan, PlanChatMessage } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { MemoryMcp } from "../llm/memory-mcp";
import type { RunConfinement } from "../llm/confinement";
import type { PlanIssueInput } from "../planner/generate";
import { runAgentDiscussion, AGENT_CHAT_HARD_TIMEOUT_MS } from "../agent-chat/discuss";
import { parseJsonReply } from "../llm/json";

// Coder chat (#170): interrogate the software engineer who implemented the diff
// in this worktree. Discuss-only — the chat never modifies any file. Resumes the
// coding session (repo exploration intact) when it survives, else runs a fresh,
// fully-seeded turn from the issue + plan + coder report + transcript.

const MAX_BODY_CHARS = 20_000;
const DEFAULT_DISTILL_MAX_TURNS = 12;

export const CODER_CHAT_SYSTEM_PROMPT = `You are the software engineer who implemented the changes in this worktree. The reviewer is asking you about your implementation before deciding what to do with it.

Answer conversationally in markdown. Your current working directory is the git worktree that holds your changes — you may use Read, Grep, Glob and read-only Bash to verify facts against it. Do NOT modify any files, including via Bash, and never touch anything outside your working directory — even if the conversation mentions absolute paths elsewhere on this machine. Do NOT re-emit the plan or the coder report — just answer the question.`;

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
    ...(opts.confinement ? { confinement: opts.confinement } : {}),
  });
}

// Coder-chat Apply (#188): distill the discussion into concrete change
// instructions for a new coding pass. Mirrors applyPlanFromDiscussion — resume
// the coding session when it survives, else run a fresh, fully-seeded turn,
// demanding a JSON-only final message validated with one repair round. The
// distillation never modifies any file; the real coder applies the changes.

/** One distilled change instruction; path scopes it to a file when known. */
export interface CoderChatInstruction {
  path?: string;
  body: string;
}

export interface DistillCoderChatOptions {
  llm: LLMProviderInterface;
  cwd: string;
  /** Resume the coding/chat session (claude-cli); the model already holds the discussion. */
  resumeSessionId?: string;
  /** Issue + plan + report + transcript — required when there is no session to resume. */
  context?: CoderChatContext;
  /** Persist the fallback run under this session id (claude-cli only). */
  sessionId?: string;
  maxTurns?: number;
  onEvent?: (event: CodingEvent) => void;
  memory?: MemoryMcp;
  signal?: AbortSignal;
  /** Keep the run inside its cwd (#196); passed only when cwd is the worktree. */
  confinement?: RunConfinement;
}

const CODER_INSTRUCTIONS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    instructions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          body: { type: "string", minLength: 1 },
        },
        required: ["body"],
      },
    },
  },
  required: ["instructions"],
};

const INSTRUCTIONS_JSON_DEMAND =
  "Your FINAL message must be ONLY a single JSON object matching this JSON Schema. No prose, no code fences, no preamble.";

function buildDistillResumePrompt(): string {
  return [
    `Distill the conclusions of this discussion into concrete change instructions for a new coding pass. Each instruction is one change to make to the worktree; attach a file path when the change is scoped to a single file, otherwise omit it. Do NOT modify any files.`,
    ``,
    INSTRUCTIONS_JSON_DEMAND,
    ``,
    `Schema:`,
    JSON.stringify(CODER_INSTRUCTIONS_SCHEMA),
  ].join("\n");
}

function buildDistillFallbackPrompt(ctx: CoderChatContext): string {
  const history = renderHistory(ctx.history);
  return [
    `You implemented the changes for the issue below in the git worktree at your current working directory, following the approved plan. Distill the conclusions reached in the discussion into concrete change instructions for a new coding pass. Each instruction is one change to make to the worktree; attach a file path when the change is scoped to a single file, otherwise omit it. Do NOT modify any files.`,
    ``,
    issueHeader(ctx.issue),
    ...(ctx.plan
      ? [``, `--- Approved plan (JSON) ---`, JSON.stringify(ctx.plan, null, 2), `--- End approved plan ---`]
      : []),
    ...(ctx.report ? [``, renderCoderReportBlock(ctx.report)] : []),
    ...(history ? [``, `--- Conversation so far ---`, history, `--- End conversation ---`] : []),
    ``,
    INSTRUCTIONS_JSON_DEMAND,
    ``,
    `Schema:`,
    JSON.stringify(CODER_INSTRUCTIONS_SCHEMA),
  ].join("\n");
}

function validateInstructionsShape(
  candidate: unknown,
): { ok: true; instructions: CoderChatInstruction[] } | { ok: false; error: string } {
  if (typeof candidate !== "object" || candidate === null || !("instructions" in candidate)) {
    return { ok: false, error: `expected an object with an "instructions" array` };
  }
  const raw = (candidate as { instructions: unknown }).instructions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: `"instructions" must be a non-empty array` };
  }
  const instructions: CoderChatInstruction[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "each instruction must be an object" };
    }
    const body = (entry as { body?: unknown }).body;
    if (typeof body !== "string" || body.trim() === "") {
      return { ok: false, error: `each instruction needs a non-empty "body" string` };
    }
    const path = (entry as { path?: unknown }).path;
    if (path !== undefined && typeof path !== "string") {
      return { ok: false, error: `"path" must be a string when present` };
    }
    instructions.push({
      body,
      ...(typeof path === "string" && path.trim() !== "" ? { path } : {}),
    });
  }
  return { ok: true, instructions };
}

function tryParseInstructions(
  text: string,
): { ok: true; instructions: CoderChatInstruction[] } | { ok: false; error: string } {
  let candidate: unknown;
  try {
    candidate = parseJsonReply<unknown>(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return validateInstructionsShape(candidate);
}

function buildInstructionsRepairPrompt(raw: string, error: string): string {
  return [
    `The text below was supposed to be a single JSON object matching the coder-instructions schema, but it failed validation: ${error}.`,
    ``,
    `--- Raw output ---`,
    raw,
    `--- End raw output ---`,
    ``,
    `Return ONLY the corrected JSON object. No prose, no code fences.`,
  ].join("\n");
}

/**
 * Validate an agent's final JSON reply against the instructions shape, with one
 * cheap askStructured repair round for format slips (mirrors validatePlanReply).
 */
async function validateInstructionsReply(
  llm: LLMProviderInterface,
  raw: string,
  signal?: AbortSignal,
): Promise<CoderChatInstruction[]> {
  const first = tryParseInstructions(raw);
  if (first.ok) return first.instructions;

  const repaired = await llm.askStructured<unknown>(
    buildInstructionsRepairPrompt(raw, first.error),
    CODER_INSTRUCTIONS_SCHEMA,
    signal ? { signal } : undefined,
  );
  const second = validateInstructionsShape(repaired);
  if (second.ok) return second.instructions;

  throw new Error(`coder chat instructions failed validation: ${second.error}`);
}

/**
 * Re-emit the discussion's conclusions as validated change instructions for a
 * new coding pass. Resumes the coding session when one is available; otherwise
 * runs a fresh, fully-seeded turn. Never modifies any file.
 */
export async function distillCoderChatInstructions(
  opts: DistillCoderChatOptions,
): Promise<{ instructions: CoderChatInstruction[]; sessionId?: string }> {
  const { llm, cwd } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_DISTILL_MAX_TURNS;
  const prompt = opts.resumeSessionId
    ? buildDistillResumePrompt()
    : opts.context
      ? buildDistillFallbackPrompt(opts.context)
      : undefined;
  if (prompt === undefined) throw new Error("distillCoderChatInstructions without a session needs context");

  if (opts.resumeSessionId) {
    if (!llm.agent) throw new Error("resuming a coder session needs an agent-capable provider");
    const reply = await llm.agent(prompt, {
      systemPrompt: CODER_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
      resumeSessionId: opts.resumeSessionId,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.confinement ? { confinement: opts.confinement } : {}),
    });
    const instructions = await validateInstructionsReply(llm, reply.text, opts.signal);
    return { instructions, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  if (llm.agent) {
    const reply = await llm.agent(prompt, {
      systemPrompt: CODER_CHAT_SYSTEM_PROMPT,
      cwd,
      maxTurns,
      hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.confinement ? { confinement: opts.confinement } : {}),
    });
    const instructions = await validateInstructionsReply(llm, reply.text, opts.signal);
    return { instructions, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  const raw = await llm.askStructured<unknown>(
    prompt,
    CODER_INSTRUCTIONS_SCHEMA,
    opts.signal ? { signal: opts.signal } : undefined,
  );
  const instructions = await validateInstructionsReply(llm, JSON.stringify(raw), opts.signal);
  return { instructions };
}
