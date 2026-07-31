import type {
  CodingEvent,
  ComposerDraft,
  ComposerEditedFlags,
  PlanChatMessage,
} from "@skipper/shared";
import { isPlanChatText } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { AgentRuntime } from "../runtime/types";
import { structuredCall } from "../runtime/structured";
import type { MemoryMcp } from "../llm/memory-mcp";
import type { GraphifyContext } from "../llm/graphify-mcp";
import type { RunConfinement } from "../llm/confinement";
import { AGENT_CHAT_HARD_TIMEOUT_MS } from "../agent-chat/discuss";
import { parseJsonReply } from "../llm/json";
import { COMPOSER_DRAFT_JSON_SCHEMA, validateComposerDraft } from "./schema";
import { buildComposerSystemPrompt, renderDraftBlock } from "./prompts";

// Chat composer, distillation half (#136): re-emit the discussion as a
// structured multi-issue draft. Mirrors distillCoderChatInstructions — resume
// the composer session when it survives, else a fresh, fully-seeded turn, with a
// JSON-only final message validated through one cheap repair round.

const DEFAULT_DISTILL_MAX_TURNS = 12;

const DRAFT_JSON_DEMAND =
  "Your FINAL message must be ONLY a single JSON object matching this JSON Schema. No prose, no code fences, no preamble.";

const DISTILL_INSTRUCTION = `Distill this discussion into the issues to open on this repository. One issue per independently shippable, reviewable change — split the work when the scope demands it, and keep it to a single issue when it does not. Each issue needs a title following the repository's conventions, a body a maintainer could act on, its acceptance criteria, and its labels. Express dependencies between the issues as relations, by 0-based index into the issues array. Do NOT modify any file.`;

const PRESERVE_INSTRUCTION =
  "Fields marked [edited by user] in the draft above were written by the user: reproduce them verbatim unless the discussion explicitly asked to change them.";

export interface DistillComposerDraftOptions {
  llm: LLMProviderInterface;
  /** Agentic runtime for the resume/fresh-agent paths (#238); absent = askStructured only. */
  runtime?: AgentRuntime;
  /** The user's local checkout of the repo. */
  cwd: string;
  repoInstructions?: string;
  graphify?: GraphifyContext;
  /** Resume the composer session; the model still holds the discussion. */
  resumeSessionId?: string;
  /** Persist a fresh run under this session id (claude-cli only). */
  sessionId?: string;
  /** Transcript — required when there is no session to resume. */
  context?: { history: PlanChatMessage[] };
  /** The previous draft, so a regeneration builds on it instead of starting over. */
  draft?: ComposerDraft;
  edited?: ComposerEditedFlags;
  maxTurns?: number;
  onEvent?: (event: CodingEvent) => void;
  memory?: MemoryMcp;
  signal?: AbortSignal;
  confinement?: RunConfinement;
}

function draftLines(draft?: ComposerDraft, edited?: ComposerEditedFlags): string[] {
  if (!draft) return [];
  return [``, renderDraftBlock(draft, edited), ``, PRESERVE_INSTRUCTION];
}

function schemaLines(): string[] {
  return [``, DRAFT_JSON_DEMAND, ``, `Schema:`, JSON.stringify(COMPOSER_DRAFT_JSON_SCHEMA)];
}

function buildResumePrompt(draft?: ComposerDraft, edited?: ComposerEditedFlags): string {
  return [DISTILL_INSTRUCTION, ...draftLines(draft, edited), ...schemaLines()].join("\n");
}

function buildFallbackPrompt(
  history: PlanChatMessage[],
  draft?: ComposerDraft,
  edited?: ComposerEditedFlags,
): string {
  const transcript = history
    .filter(isPlanChatText)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
  return [
    `You discussed with the user which issues to open on the repository at your current working directory.`,
    DISTILL_INSTRUCTION,
    ...(transcript
      ? [``, `--- Conversation so far ---`, transcript, `--- End conversation ---`]
      : []),
    ...draftLines(draft, edited),
    ...schemaLines(),
  ].join("\n");
}

function tryParseDraft(text: string): { ok: true; draft: ComposerDraft } | { ok: false; error: string } {
  let candidate: unknown;
  try {
    candidate = parseJsonReply<unknown>(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return validateComposerDraft(candidate);
}

function buildRepairPrompt(raw: string, error: string): string {
  return [
    `The text below was supposed to be a single JSON object matching the issue-draft schema, but it failed validation: ${error}.`,
    ``,
    `--- Raw output ---`,
    raw,
    `--- End raw output ---`,
    ``,
    `Return ONLY the corrected JSON object. No prose, no code fences.`,
  ].join("\n");
}

/** Validate the agent's final JSON reply, with one cheap structured repair round
 *  for format slips — on the composer's own runtime when it has one (mirrors
 *  validatePlanReply). */
async function validateDraftReply(
  runtime: AgentRuntime | undefined,
  llm: LLMProviderInterface,
  raw: string,
  signal?: AbortSignal,
): Promise<ComposerDraft> {
  const first = tryParseDraft(raw);
  if (first.ok) return first.draft;

  const repaired = await structuredCall<unknown>(
    runtime,
    llm,
    buildRepairPrompt(raw, first.error),
    COMPOSER_DRAFT_JSON_SCHEMA,
    signal ? { signal } : undefined,
  );
  const second = validateComposerDraft(repaired);
  if (second.ok) return second.draft;

  throw new Error(`composer draft failed validation: ${second.error}`);
}

/**
 * Re-emit the discussion's conclusions as a validated multi-issue draft.
 * Resumes the composer session when one is available; otherwise runs a fresh,
 * fully-seeded turn. Never modifies any file.
 */
export async function distillComposerDraft(
  opts: DistillComposerDraftOptions,
): Promise<{ draft: ComposerDraft; sessionId?: string }> {
  const { llm, runtime, cwd } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_DISTILL_MAX_TURNS;
  const prompt = opts.resumeSessionId
    ? buildResumePrompt(opts.draft, opts.edited)
    : opts.context
      ? buildFallbackPrompt(opts.context.history, opts.draft, opts.edited)
      : undefined;
  if (prompt === undefined) throw new Error("distillComposerDraft without a session needs context");

  const systemPrompt = buildComposerSystemPrompt({
    ...(opts.repoInstructions ? { repoInstructions: opts.repoInstructions } : {}),
    ...(opts.graphify ? { graphify: opts.graphify } : {}),
  });
  const common = {
    systemPrompt,
    cwd,
    maxTurns,
    hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.graphify ? { graph: opts.graphify.mcp } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.confinement ? { confinement: opts.confinement } : {}),
  };

  if (opts.resumeSessionId) {
    if (!runtime) throw new Error("resuming a composer session needs an agent-capable runtime");
    const reply = await runtime.agent(prompt, { ...common, resumeSessionId: opts.resumeSessionId });
    const draft = await validateDraftReply(runtime, llm, reply.text, opts.signal);
    return { draft, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  if (runtime) {
    const reply = await runtime.agent(prompt, {
      ...common,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });
    const draft = await validateDraftReply(runtime, llm, reply.text, opts.signal);
    return { draft, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  const raw = await llm.askStructured<unknown>(
    prompt,
    COMPOSER_DRAFT_JSON_SCHEMA,
    opts.signal ? { signal: opts.signal } : undefined,
  );
  const draft = await validateDraftReply(runtime, llm, JSON.stringify(raw), opts.signal);
  return { draft };
}
