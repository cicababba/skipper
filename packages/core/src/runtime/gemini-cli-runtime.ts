import type { AgentRuntimeId } from "@skipper/shared";
import type { AgentOptions, LLMResponse } from "../llm/provider";
import { GeminiCli } from "../llm/gemini-cli";
import { runGeminiCodingAgent } from "../coder/gemini-run";
import type { CodingRunResult, RunCodingAgentOptions } from "../coder/run";
import type { AgentRuntime, RuntimeCapabilities, RuntimeStructuredOptions } from "./types";

/** The gemini-cli runtime's capabilities (#243): streaming JSONL events, resumable
 *  on-disk sessions (`--session-id` / `--resume`), and MCP servers via the project
 *  settings file. Confinement is "none" — the honest answer: gemini's approval
 *  mode can deny a whole tool but cannot path-scope a write, and its native
 *  sandbox needs docker/podman, which is not a portable default. The worktree
 *  tripwire is the real guard. */
export const GEMINI_CLI_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  confinement: "none",
  mcp: true,
  /** Assumption (#281), to verify against the installed CLI: gemini's read_file
   *  is multimodal and handles both images and PDFs. */
  images: true,
  pdfs: true,
};

/**
 * Google's Gemini CLI behind the AgentRuntime contract (#243). Options accepted
 * and ignored here, by construction: `maxTurns` (gemini's only turn budget,
 * `model.maxSessionTurns`, is cumulative per session — the wall-clock timers are
 * the whole per-run budget) and `confinement` (the claude rules/hook machinery
 * has no gemini equivalent).
 *
 * MCP and context leakage is closed by a Skipper-written `<cwd>/.gemini/settings.json`
 * (there is no inline flag for either): it points `context.fileName` at a name no
 * repo has, which kills the global and workspace GEMINI.md load, and declares the
 * skipper-memory and graphify servers, which `--allowed-mcp-server-names` then
 * isolates from the user's own. The file is backed up and restored around every run.
 */
export class GeminiCliRuntime implements AgentRuntime {
  readonly id: AgentRuntimeId = "gemini-cli";
  readonly capabilities = GEMINI_CLI_CAPABILITIES;
  private readonly cli: GeminiCli;

  constructor(private readonly model?: string) {
    this.cli = new GeminiCli(model);
  }

  /** The caller's model is discarded (#240): role models are Claude aliases, so
   *  only this runtime's own model — or gemini's configured default — may reach it. */
  runCoding(opts: RunCodingAgentOptions): Promise<CodingRunResult> {
    return runGeminiCodingAgent({ ...opts, model: this.model });
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
