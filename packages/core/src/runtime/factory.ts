import type { LLMProvider } from "@skipper/shared";
import type { AgentRuntime } from "./types";
import { ClaudeCliRuntime } from "./claude-cli-runtime";

/**
 * The agent runtime for a provider, or undefined when the provider wraps no
 * runtime (#238) — openai is completions-only. `undefined` replaces every
 * `if (!llm.agent)` probe: a consumer that needs an agentic path checks for it.
 */
export function createRuntime(config: {
  provider: LLMProvider;
  model: string;
  maxTurns: number;
}): AgentRuntime | undefined {
  switch (config.provider) {
    case "claude-cli":
      return new ClaudeCliRuntime(config.model, config.maxTurns);
    default:
      return undefined;
  }
}
