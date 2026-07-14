import type { CodingEvent, LLMProvider } from "@skipper/shared";
import type { MemoryMcp } from "./memory-mcp";

export interface LLMResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
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
}

export interface LLMProviderInterface {
  readonly name: LLMProvider;
  ask(prompt: string, systemPrompt?: string): Promise<LLMResponse>;
  askStructured<T>(prompt: string, schema: Record<string, unknown>): Promise<T>;
  /**
   * Agentic completion: the model may use tools (read files, search/fetch the
   * web, run commands) across multiple turns before producing its answer.
   * Optional — only providers that wrap a tool-capable runtime implement it
   * (today: claude-cli). Callers should fall back to `ask` when absent.
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
      // Lazy require to avoid circular deps (dynamic import would force the API async)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new (require("./claude-cli").ClaudeCLIProvider)(config.model, config.maxTurns);
    case "openai":
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new (require("./openai").OpenAIProvider)(config.model, config.apiKey);
    case "ollama":
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new (require("./ollama").OllamaProvider)(config.model);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
