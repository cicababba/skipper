import { CHAT_SALVAGE_DETAIL, type CodingEvent } from "@skipper/shared";
import type { LLMProviderInterface, LLMResponse } from "../llm/provider";
import { salvageableDeathSubtype } from "../llm/claude-cli";
import type { AgentRuntime } from "../runtime/types";
import type { MemoryMcp } from "../llm/memory-mcp";
import type { GraphifyMcp } from "../llm/graphify-mcp";
import type { RunConfinement } from "../llm/confinement";

// Generic agent-discussion dispatch (#170): the shared runtime.agent(...) call
// that the coder and reviewer chats build their prompts for. Mirrors the dispatch
// in planner/chat.ts (discussPlan) without folding the plan-specific Apply path in.
// Resume path requires a runtime; the fresh path uses runtime.agent() when
// available, else falls back to a single-turn ask() on the completions provider.

/** A broad question about existing code costs 20+ tool calls before the agent can
 *  answer it (#301), so the budget is generous; a run that still dies gets the
 *  wrap-up salvage below rather than throwing its exploration away. */
export const DEFAULT_AGENT_CHAT_MAX_TURNS = 60;
/** Wall-clock cap for a chat turn (#194, widened by #301). */
export const AGENT_CHAT_HARD_TIMEOUT_MS = 8 * 60_000;

/** Salvage budget (#301): the wrap-up calls no tools and a user is waiting on it. */
const CHAT_SALVAGE_MAX_TURNS = 4;
const CHAT_SALVAGE_HARD_TIMEOUT_MS = 60_000;

const CHAT_SALVAGE_PROMPT = [
  `You ran out of your exploration budget (time or tool calls) for this turn. Do NOT call any more tools.`,
  `Answer the user's question NOW from what you have already read in this session, and say explicitly what you could not verify.`,
].join("\n");

export interface RunAgentDiscussionOptions {
  llm: LLMProviderInterface;
  /** Agentic runtime for the resume/fresh-agent paths (#238); absent = ask() only. */
  runtime?: AgentRuntime;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  /** Resume an existing session (claude-cli); the model still holds its context. */
  resumeSessionId?: string;
  /** Persist a fresh run under this session id (claude-cli only). */
  sessionId?: string;
  maxTurns?: number;
  onEvent?: (event: CodingEvent) => void;
  memory?: MemoryMcp;
  /** Inject the graphify knowledge-graph MCP server (#233); the composer chat
   *  passes it, the coder/reviewer chats never do. */
  graph?: GraphifyMcp;
  signal?: AbortSignal;
  /** Keep the run inside its cwd (#196); passed only when cwd is the worktree. */
  confinement?: RunConfinement;
}

export async function runAgentDiscussion(
  opts: RunAgentDiscussionOptions,
): Promise<{ reply: string; sessionId?: string }> {
  const { llm, runtime, cwd, systemPrompt, prompt } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_AGENT_CHAT_MAX_TURNS;

  // A --resume forks and reports a NEW session id via agent-init: the dead turn's
  // exploration lives in the fork, so the salvage must resume that id.
  let driftedSessionId: string | undefined;
  const onEvent = (event: CodingEvent) => {
    if (event.kind === "agent-init" && event.sessionId) driftedSessionId = event.sessionId;
    opts.onEvent?.(event);
  };

  /** Budget death → resume the (possibly forked) session for a tool-free wrap-up
   *  (#301), the planner's salvage adapted to a user waiting on an answer. The
   *  original death is what surfaces when there is nothing to resume or the
   *  wrap-up dies too — its budget message is the honest one. */
  const salvage = async (err: unknown): Promise<LLMResponse> => {
    const sessionId = driftedSessionId ?? opts.resumeSessionId ?? opts.sessionId;
    if (!runtime || !sessionId || !salvageableDeathSubtype(err) || opts.signal?.aborted) throw err;
    onEvent({ kind: "status", phase: "resuming", detail: CHAT_SALVAGE_DETAIL });
    try {
      return await runtime.agent(CHAT_SALVAGE_PROMPT, {
        systemPrompt,
        cwd,
        maxTurns: CHAT_SALVAGE_MAX_TURNS,
        hardTimeoutMs: CHAT_SALVAGE_HARD_TIMEOUT_MS,
        resumeSessionId: sessionId,
        onEvent,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.confinement ? { confinement: opts.confinement } : {}),
      });
    } catch {
      throw err;
    }
  };

  if (opts.resumeSessionId) {
    if (!runtime) throw new Error("resuming an agent session needs an agent-capable runtime");
    const reply = await runtime
      .agent(prompt, {
        systemPrompt,
        cwd,
        maxTurns,
        hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
        resumeSessionId: opts.resumeSessionId,
        onEvent,
        ...(opts.memory ? { memory: opts.memory } : {}),
        ...(opts.graph ? { graph: opts.graph } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.confinement ? { confinement: opts.confinement } : {}),
      })
      .catch(salvage);
    return { reply: reply.text, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  if (runtime) {
    const reply = await runtime
      .agent(prompt, {
        systemPrompt,
        cwd,
        maxTurns,
        hardTimeoutMs: AGENT_CHAT_HARD_TIMEOUT_MS,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        onEvent,
        ...(opts.memory ? { memory: opts.memory } : {}),
        ...(opts.graph ? { graph: opts.graph } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.confinement ? { confinement: opts.confinement } : {}),
      })
      .catch(salvage);
    return { reply: reply.text, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  }

  const reply = await llm.ask(prompt, systemPrompt);
  return { reply: reply.text };
}
