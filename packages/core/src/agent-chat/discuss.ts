import type { CodingEvent } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { AgentRuntime } from "../runtime/types";
import type { MemoryMcp } from "../llm/memory-mcp";
import type { RunConfinement } from "../llm/confinement";

// Generic agent-discussion dispatch (#170): the shared runtime.agent(...) call
// that the coder and reviewer chats build their prompts for. Mirrors the dispatch
// in planner/chat.ts (discussPlan) without folding the plan-specific Apply path in.
// Resume path requires a runtime; the fresh path uses runtime.agent() when
// available, else falls back to a single-turn ask() on the completions provider.

export const DEFAULT_AGENT_CHAT_MAX_TURNS = 12;
/** Wall-clock cap for a chat turn (#194): a dead chat surfaces as a panel error the
 *  user retries — no salvage — so the budget is short. */
export const AGENT_CHAT_HARD_TIMEOUT_MS = 3 * 60_000;

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
  signal?: AbortSignal;
  /** Keep the run inside its cwd (#196); passed only when cwd is the worktree. */
  confinement?: RunConfinement;
}

export async function runAgentDiscussion(
  opts: RunAgentDiscussionOptions,
): Promise<{ reply: string; sessionId?: string }> {
  const { llm, runtime, cwd, systemPrompt, prompt } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_AGENT_CHAT_MAX_TURNS;

  if (opts.resumeSessionId) {
    if (!runtime) throw new Error("resuming an agent session needs an agent-capable runtime");
    const reply = await runtime.agent(prompt, {
      systemPrompt,
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

  if (runtime) {
    const reply = await runtime.agent(prompt, {
      systemPrompt,
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

  const reply = await llm.ask(prompt, systemPrompt);
  return { reply: reply.text };
}
