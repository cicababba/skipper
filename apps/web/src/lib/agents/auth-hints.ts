import type { AgentRuntimeId } from "@skipper/shared";
import type { RuntimeLabelKey } from "./runtime-options";

// How the user authenticates each agent CLI (#287) — the hint under the Default
// agent picker follows the selected runtime instead of always naming Claude.

export type AuthHintAfterKey =
  | "authHintAfterTerminal"
  | "authHintAfterCopilot"
  | "authHintAfterGemini";

export interface AuthHint {
  command: string;
  runtimeLabelKey: RuntimeLabelKey;
  afterKey: AuthHintAfterKey;
}

const HINTS: Record<AgentRuntimeId, AuthHint> = {
  "claude-cli": {
    command: "claude auth login",
    runtimeLabelKey: "runtimeClaude",
    afterKey: "authHintAfterTerminal",
  },
  "codex-cli": {
    command: "codex login",
    runtimeLabelKey: "runtimeCodex",
    afterKey: "authHintAfterTerminal",
  },
  "copilot-cli": {
    command: "copilot",
    runtimeLabelKey: "runtimeCopilot",
    afterKey: "authHintAfterCopilot",
  },
  "gemini-cli": {
    command: "gemini",
    runtimeLabelKey: "runtimeGemini",
    afterKey: "authHintAfterGemini",
  },
};

export function authHintFor(runtime: AgentRuntimeId): AuthHint {
  return HINTS[runtime];
}
