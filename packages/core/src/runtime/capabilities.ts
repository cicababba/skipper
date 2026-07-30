import type { AgentRuntimeId } from "@skipper/shared";
import type { RuntimeCapabilities } from "./types";
import { CLAUDE_CLI_CAPABILITIES } from "./claude-cli-runtime";
import { CODEX_CLI_CAPABILITIES } from "./codex-cli-runtime";
import { COPILOT_CLI_CAPABILITIES } from "./copilot-cli-runtime";
import { GEMINI_CLI_CAPABILITIES } from "./gemini-cli-runtime";

/** Every runtime's capability matrix, keyed by id (#281) — lets a consumer answer
 *  "can this runtime read a PDF?" without constructing the runtime. */
export const RUNTIME_CAPABILITIES: Record<AgentRuntimeId, RuntimeCapabilities> = {
  "claude-cli": CLAUDE_CLI_CAPABILITIES,
  "codex-cli": CODEX_CLI_CAPABILITIES,
  "copilot-cli": COPILOT_CLI_CAPABILITIES,
  "gemini-cli": GEMINI_CLI_CAPABILITIES,
};
