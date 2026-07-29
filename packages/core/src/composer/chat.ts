import type {
  CodingEvent,
  ComposerDraft,
  ComposerEditedFlags,
  PlanChatMessage,
} from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { AgentRuntime } from "../runtime/types";
import type { MemoryMcp } from "../llm/memory-mcp";
import type { GraphifyContext } from "../llm/graphify-mcp";
import type { RunConfinement } from "../llm/confinement";
import { runAgentDiscussion } from "../agent-chat/discuss";
import { buildComposerFallbackPrompt, buildComposerResumePrompt, buildComposerSystemPrompt } from "./prompts";

// Chat composer, conversation half (#136): one repo-grounded discussion turn.
// Resumes the composer session when it survives, else runs a fresh turn seeded
// with the transcript (and the current draft, when one exists). Never modifies
// any file — the cwd is the user's own checkout, so there is no confinement to
// lean on, only the read-leaning toolset and the driver's dirty-checkout tripwire.

export interface ComposerChatContext {
  history: PlanChatMessage[];
}

export interface DiscussComposerOptions {
  message: string;
  llm: LLMProviderInterface;
  /** Agentic runtime for the resume/fresh-agent paths (#238); absent = ask() only. */
  runtime?: AgentRuntime;
  /** The user's local checkout of the repo. */
  cwd: string;
  /** The repo's Skipper-owned agent-instructions doc content (#227). */
  repoInstructions?: string;
  /** The repo's Graphify knowledge-graph index (#233), when it is opted in. */
  graphify?: GraphifyContext;
  /** Resume the composer session; the model still holds the discussion. */
  resumeSessionId?: string;
  /** Persist a fresh run under this session id (claude-cli only). */
  sessionId?: string;
  /** Transcript — required when there is no session to resume. */
  context?: ComposerChatContext;
  /** The draft generated so far, injected so the reply reasons about it. */
  draft?: ComposerDraft;
  /** Fields the user hand-edited, marked preserve-verbatim in the prompt. */
  edited?: ComposerEditedFlags;
  maxTurns?: number;
  onEvent?: (event: CodingEvent) => void;
  memory?: MemoryMcp;
  signal?: AbortSignal;
  confinement?: RunConfinement;
}

/**
 * Answer one composer message. Resumes the composer session when one is
 * available; otherwise runs a fresh, fully-seeded turn.
 */
export async function discussComposer(
  opts: DiscussComposerOptions,
): Promise<{ reply: string; sessionId?: string }> {
  const { llm, cwd, message } = opts;
  const prompt = opts.resumeSessionId
    ? buildComposerResumePrompt({
        message,
        ...(opts.draft ? { draft: opts.draft } : {}),
        ...(opts.edited ? { edited: opts.edited } : {}),
      })
    : opts.context
      ? buildComposerFallbackPrompt({
          message,
          history: opts.context.history,
          ...(opts.draft ? { draft: opts.draft } : {}),
          ...(opts.edited ? { edited: opts.edited } : {}),
        })
      : undefined;
  if (prompt === undefined) throw new Error("discussComposer without a session needs context");

  return runAgentDiscussion({
    llm,
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    cwd,
    systemPrompt: buildComposerSystemPrompt({
      ...(opts.repoInstructions ? { repoInstructions: opts.repoInstructions } : {}),
      ...(opts.graphify ? { graphify: opts.graphify } : {}),
    }),
    prompt,
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.graphify ? { graph: opts.graphify.mcp } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.confinement ? { confinement: opts.confinement } : {}),
  });
}
