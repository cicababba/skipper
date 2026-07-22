import type { CodingEvent, LLMProvider } from "@skipper/shared";
import type { MemoryMcp } from "./memory-mcp";
import type { RunConfinement } from "./confinement";
import { ClaudeCLIProvider } from "./claude-cli";
import { OpenAIProvider } from "./openai";
import { OllamaProvider } from "./ollama";

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
  /** Persist the run under this session id (drops --no-session-persistence) so it
   *  can be resumed later; cwd-scoped, claude-cli only (#111). */
  sessionId?: string;
  /** Resume an existing on-disk session (--resume); mutually exclusive with
   *  sessionId, cwd must match the session's origin; claude-cli only (#145). */
  resumeSessionId?: string;
  /** Abort the run; rejects with AgentAbortError. claude-cli only (#145). */
  signal?: AbortSignal;
  /** Keep the run inside its cwd (#196): adds the Bash guard hook + confined env.
   *  claude-cli only; the read-leaning agent toolset has no Edit/Write to scope. */
  confinement?: RunConfinement;
}

/** Thrown by agent() when its AbortSignal fires (#145). */
export class AgentAbortError extends Error {
  constructor() {
    super("agent run aborted");
    this.name = "AgentAbortError";
  }
}

/** Opt-in persistence + cwd for a single structured call (#111). */
export interface StructuredOptions {
  /** Working directory the structured call runs in (so the on-disk session lands there). */
  cwd?: string;
  /** Persist under this session id (drops --no-session-persistence); claude-cli only. */
  sessionId?: string;
  /** Abort the call; rejects with AgentAbortError. claude-cli only (#159). */
  signal?: AbortSignal;
}

export interface LLMProviderInterface {
  readonly name: LLMProvider;
  ask(prompt: string, systemPrompt?: string): Promise<LLMResponse>;
  askStructured<T>(
    prompt: string,
    schema: Record<string, unknown>,
    opts?: StructuredOptions,
  ): Promise<T>;
  /**
   * Agentic completion: the model may use tools (read files, search/fetch the
   * web, run commands) across multiple turns before producing its answer.
   * Optional — only providers that wrap a tool-capable runtime implement it
   * (today: claude-cli and ollama). Callers should fall back to `ask` when absent.
   */
  agent?(prompt: string, opts?: AgentOptions): Promise<LLMResponse>;
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
    case "ollama":
      return new OllamaProvider(config.model);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
