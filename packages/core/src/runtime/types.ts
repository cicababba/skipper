import type { AgentRuntimeId } from "@skipper/shared";
import type { AgentOptions, LLMResponse } from "../llm/provider";
import type { CodingRunResult, RunCodingAgentOptions } from "../coder/run";

// The AgentRuntime seam (#238): every agentic path — the write-capable coding
// run, the read-leaning agent completion, and the tools-enabled structured call —
// runs through one runtime whose capability matrix declares what it can do. A
// second runtime (Codex/Gemini CLI) implements this same contract under #236.

/** What a runtime can do — probed by consumers instead of name-checking a provider. */
export interface RuntimeCapabilities {
  /** Streams progress events during a run (onEvent). */
  readonly streaming: boolean;
  /** Persists + resumes on-disk sessions (sessionId / resumeSessionId). */
  readonly resume: boolean;
  /** How a run is kept inside its cwd. "rules" = the claude-cli Bash guard hook +
   *  path-scoped write rules; "sandbox" = an OS sandbox; "none" = no confinement. */
  readonly confinement: "sandbox" | "rules" | "none";
  /** Accepts MCP servers (skipper-memory, graphify). */
  readonly mcp: boolean;
  /** Can read local image files during an agentic run (multimodal file tool). */
  readonly images: boolean;
  /** Can read local PDF files during an agentic run. */
  readonly pdfs: boolean;
}

/** Options for a runtime's tools-enabled structured call — the wide surface the
 *  plain provider's StructuredOptions dropped (#238). */
export interface RuntimeStructuredOptions {
  /** Comma-separated CLI tool list; enables multi-turn tool use for this call. */
  tools: string;
  cwd?: string;
  sessionId?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface AgentRuntime {
  readonly id: AgentRuntimeId;
  readonly capabilities: RuntimeCapabilities;
  /** The write-capable coding run — model comes from opts.model. */
  runCoding(opts: RunCodingAgentOptions): Promise<CodingRunResult>;
  /** Read-leaning agentic completion — model comes from the runtime's construction. */
  agent(prompt: string, opts?: AgentOptions): Promise<LLMResponse>;
  /** Tools-enabled structured call — model comes from the runtime's construction. */
  structured<T>(
    prompt: string,
    schema: Record<string, unknown>,
    opts: RuntimeStructuredOptions,
  ): Promise<T>;
}
