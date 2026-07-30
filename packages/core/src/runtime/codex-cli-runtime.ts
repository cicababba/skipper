import type { AgentRuntimeId } from "@skipper/shared";
import type { AgentOptions, LLMResponse } from "../llm/provider";
import { CodexCli } from "../llm/codex-cli";
import { runCodexCodingAgent } from "../coder/codex-run";
import type { CodingRunResult, RunCodingAgentOptions } from "../coder/run";
import type { AgentRuntime, RuntimeCapabilities, RuntimeStructuredOptions } from "./types";

/** The codex-cli runtime's capabilities (#239): streaming `--json` events,
 *  resumable on-disk sessions (`codex exec resume`), OS-level sandbox
 *  confinement instead of rules, and MCP servers via `-c mcp_servers.*`. */
export const CODEX_CLI_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  confinement: "sandbox",
  mcp: true,
  /** Assumption (#281), to verify against the installed CLI: codex loads images
   *  through its `view_image` tool but has no native PDF reader. */
  images: true,
  pdfs: false,
};

/**
 * OpenAI's Codex CLI behind the AgentRuntime contract (#239). Two options the
 * claude runtime honours are accepted and ignored here, by construction:
 * `maxTurns` (codex has no turn budget — the wall-clock timers are the whole
 * budget, so no max-turns death exists) and `confinement` (codex's native
 * `workspace-write` sandbox replaces the rules/hook machinery). Session ids are
 * minted by codex itself, so a pre-minted `sessionId` is ignored and the real
 * id arrives on the agent-init event.
 */
export class CodexCliRuntime implements AgentRuntime {
  readonly id: AgentRuntimeId = "codex-cli";
  readonly capabilities = CODEX_CLI_CAPABILITIES;
  private readonly cli: CodexCli;

  constructor(private readonly model?: string) {
    this.cli = new CodexCli(model);
  }

  /** The caller's model is discarded (#240): role models are Claude aliases, so
   *  only this runtime's own model — or codex's configured default — may reach it. */
  runCoding(opts: RunCodingAgentOptions): Promise<CodingRunResult> {
    return runCodexCodingAgent({ ...opts, model: this.model });
  }

  agent(prompt: string, opts?: AgentOptions): Promise<LLMResponse> {
    return this.cli.agent(prompt, opts);
  }

  structured<T>(
    prompt: string,
    schema: Record<string, unknown>,
    opts: RuntimeStructuredOptions,
  ): Promise<T> {
    return this.cli.structured<T>(prompt, schema, opts);
  }
}
