import type { AgentRuntimeId } from "@skipper/shared";
import type { AgentOptions, LLMResponse } from "../llm/provider";
import { ClaudeCLIProvider } from "../llm/claude-cli";
import { runCodingAgent, type CodingRunResult, type RunCodingAgentOptions } from "../coder/run";
import type { AgentRuntime, RuntimeCapabilities, RuntimeStructuredOptions } from "./types";

/** The claude-cli runtime's capabilities (#238): streaming, resumable on-disk
 *  sessions, rule-based confinement (the Bash guard hook), and MCP servers.
 *  Read loads images and PDFs natively (#281). */
export const CLAUDE_CLI_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  confinement: "rules",
  mcp: true,
  images: true,
  pdfs: true,
};

/**
 * Wraps the existing claude-cli surface behind the AgentRuntime contract (#238):
 * `runCoding` → runCodingAgent (the write-capable stream), `agent` → the read-
 * leaning ClaudeCLIProvider.agent, `structured` → askStructured in tools mode.
 * The coding model comes per-run from opts.model; the agent/structured model is
 * fixed at construction — preserving the pre-seam asymmetry.
 */
export class ClaudeCliRuntime implements AgentRuntime {
  readonly id: AgentRuntimeId = "claude-cli";
  readonly capabilities = CLAUDE_CLI_CAPABILITIES;
  private readonly provider: ClaudeCLIProvider;

  constructor(model = "sonnet", maxTurns = 5) {
    this.provider = new ClaudeCLIProvider(model, maxTurns);
  }

  runCoding(opts: RunCodingAgentOptions): Promise<CodingRunResult> {
    return runCodingAgent(opts);
  }

  agent(prompt: string, opts?: AgentOptions): Promise<LLMResponse> {
    return this.provider.agent(prompt, opts);
  }

  structured<T>(
    prompt: string,
    schema: Record<string, unknown>,
    opts: RuntimeStructuredOptions,
  ): Promise<T> {
    return this.provider.askStructured<T>(prompt, schema, opts);
  }
}
