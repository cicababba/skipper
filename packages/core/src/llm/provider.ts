import type { CodingEvent, LLMProvider } from "@skipper/shared";
import type { MemoryMcp } from "./memory-mcp";
import type { GraphifyMcp } from "./graphify-mcp";
import type { RunConfinement } from "./confinement";
import { ClaudeCLIProvider } from "./claude-cli";
import { OpenAIProvider } from "./openai";

export interface LLMResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Set only when session persistence was requested (opts.sessionId) — the
   *  on-disk session id, cwd-scoped, for a later `--resume` (#111). */
  sessionId?: string;
}

export interface AgentOptions {
  systemPrompt?: string;
  /** Working directory the agent runs in (so it can read local projects). */
  cwd?: string;
  /** Max agent turns (tool-use loops). */
  maxTurns?: number;
  /** Stream agent progress (text, tool use, result). Providers without streaming ignore it. */
  onEvent?: (event: CodingEvent) => void;
  /** Inject the skipper-memory MCP server, scoped to this repo (#45). */
  memory?: MemoryMcp;
  /** Inject the graphify knowledge-graph MCP server, scoped to this repo (#233).
   *  Planner-only by construction; honored by every CLI runtime (#259). */
  graph?: GraphifyMcp;
  /** Persist the run under this session id (drops --no-session-persistence) so it
   *  can be resumed later; cwd-scoped, the claude-cli runtime only (#111). */
  sessionId?: string;
  /** Resume an existing on-disk session (--resume); mutually exclusive with
   *  sessionId, cwd must match the session's origin; the claude-cli runtime only (#145). */
  resumeSessionId?: string;
  /** Abort the run; rejects with AgentAbortError. the claude-cli runtime only (#145). */
  signal?: AbortSignal;
  /** Keep the run inside its cwd (#196): adds the Bash guard hook + confined env.
   *  the claude-cli runtime only; the read-leaning agent toolset has no Edit/Write to scope. */
  confinement?: RunConfinement;
  /** Wall-clock cap for the run; on expiry the process is killed and a typed
   *  ClaudeCliError (subtype "error_hard_timeout") rejects. the claude-cli runtime only (#194). */
  hardTimeoutMs?: number;
  /** Kill the run when it produces no stdout for this long; rejects with a typed
   *  ClaudeCliError (subtype "error_inactivity"). Streaming agent path only, since
   *  non-streaming json buffers until the end. the claude-cli runtime only (#194). */
  inactivityTimeoutMs?: number;
}

/** Thrown by agent() when its AbortSignal fires (#145). */
export class AgentAbortError extends Error {
  constructor() {
    super("agent run aborted");
    this.name = "AgentAbortError";
  }
}

/** Options for a plain (single-turn) structured call — the completions surface
 *  every provider shares. Tools/session persistence live on the runtime's
 *  structured call (RuntimeStructuredOptions) instead (#238). */
export interface StructuredOptions {
  /** Abort the call; rejects with AgentAbortError. Runtimes without an abort
   *  capability ignore it. */
  signal?: AbortSignal;
}

/**
 * Completions-only LLM provider (#238): plain text and single-turn structured
 * replies. The agentic surface (multi-turn tool use, the coding run) moved
 * behind AgentRuntime — see runtime/types.ts.
 */
export interface LLMProviderInterface {
  readonly name: LLMProvider;
  ask(prompt: string, systemPrompt?: string): Promise<LLMResponse>;
  askStructured<T>(
    prompt: string,
    schema: Record<string, unknown>,
    opts?: StructuredOptions,
  ): Promise<T>;
}

export function createProvider(config: {
  provider: LLMProvider;
  model: string;
  maxTurns: number;
  apiKey?: string;
}): LLMProviderInterface {
  switch (config.provider) {
    case "claude-cli":
      return new ClaudeCLIProvider(config.model, config.maxTurns);
    case "openai":
      return new OpenAIProvider(config.model, config.apiKey);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
