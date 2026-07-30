import { describe, expect, it } from "vitest";
import type { AgentRuntimeId } from "@skipper/shared";
import { authHintFor } from "./auth-hints";

describe("authHintFor", () => {
  it.each([
    ["claude-cli", "claude auth login", "runtimeClaude", "authHintAfterTerminal"],
    ["codex-cli", "codex login", "runtimeCodex", "authHintAfterTerminal"],
    ["copilot-cli", "copilot", "runtimeCopilot", "authHintAfterCopilot"],
    ["gemini-cli", "gemini", "runtimeGemini", "authHintAfterGemini"],
  ] as const)("names the %s login path", (runtime, command, runtimeLabelKey, afterKey) => {
    expect(authHintFor(runtime as AgentRuntimeId)).toEqual({
      command,
      runtimeLabelKey,
      afterKey,
    });
  });
});
