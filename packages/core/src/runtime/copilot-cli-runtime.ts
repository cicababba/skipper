import type { AgentRuntimeId } from "@skipper/shared";
import type { AgentOptions, LLMResponse } from "../llm/provider";
import { CopilotCli } from "../llm/copilot-cli";
import { runCopilotCodingAgent } from "../coder/copilot-run";
import type { CodingRunResult, RunCodingAgentOptions } from "../coder/run";
import type { AgentRuntime, RuntimeCapabilities, RuntimeStructuredOptions } from "./types";

/** The copilot-cli runtime's capabilities (#242): streaming JSONL events,
 *  resumable on-disk sessions (`--session-id` / `--resume`), and MCP servers via
 *  `--additional-mcp-config`. Confinement is "rules", not "sandbox": copilot
 *  verifies paths in-process and honours tool deny rules, but runs no OS sandbox
 *  (its `--sandbox` is experimental), so the worktree tripwire stays the backstop. */
export const COPILOT_CLI_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  confinement: "rules",
  mcp: true,
};

/**
 * GitHub's Copilot CLI behind the AgentRuntime contract (#242). Options accepted
 * and ignored here, by construction: `maxTurns` (copilot has no turn budget — the
 * wall-clock timers are the whole budget, so no max-turns death exists),
 * `confinement` (copilot's native path verification replaces the claude
 * rules/hook machinery) and `graph` (graphify is claude-only for now).
 *
 * MCP leakage is documented, not prevented: copilot has no strict-MCP flag
 * (copilot-cli#3380), so beyond the skipper-memory server Skipper attaches, the
 * user's global `~/.copilot/mcp-config.json` and the repo's own `.mcp.json` /
 * `.github/mcp-config.json` servers still load into every run. Isolating them
 * with `--config-dir` would orphan the user's copilot login, so they stay.
 */
export class CopilotCliRuntime implements AgentRuntime {
  readonly id: AgentRuntimeId = "copilot-cli";
  readonly capabilities = COPILOT_CLI_CAPABILITIES;
  private readonly cli: CopilotCli;

  constructor(private readonly model?: string) {
    this.cli = new CopilotCli(model);
  }

  /** The caller's model is discarded (#240): role models are Claude aliases, so
   *  only this runtime's own model — or copilot's configured default — may reach it. */
  runCoding(opts: RunCodingAgentOptions): Promise<CodingRunResult> {
    return runCopilotCodingAgent({ ...opts, model: this.model });
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
