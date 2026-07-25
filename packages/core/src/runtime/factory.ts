import type { AgentRuntimeId, LLMProvider } from "@skipper/shared";
import type { AgentRuntime } from "./types";
import { ClaudeCliRuntime } from "./claude-cli-runtime";
import { CodexCliRuntime } from "./codex-cli-runtime";
import { CopilotCliRuntime } from "./copilot-cli-runtime";

/**
 * The agent runtime for a provider, or undefined when the provider wraps no
 * runtime (#238) — openai is completions-only. `undefined` replaces every
 * `if (!llm.agent)` probe: a consumer that needs an agentic path checks for it.
 *
 * `runtime` selects a runtime that isn't the provider's own (#239): codex is a
 * CLI agent, not a completions backend, so it is picked explicitly and the
 * provider still governs the non-agentic calls. Per-role selection lands in #240.
 */
export function createRuntime(config: {
  provider: LLMProvider;
  model: string;
  maxTurns: number;
  runtime?: AgentRuntimeId;
}): AgentRuntime | undefined {
  if (config.runtime === "codex-cli") return new CodexCliRuntime(config.model);
  if (config.runtime === "copilot-cli") return new CopilotCliRuntime(config.model);
  switch (config.provider) {
    case "claude-cli":
      return new ClaudeCliRuntime(config.model, config.maxTurns);
    default:
      return undefined;
  }
}
