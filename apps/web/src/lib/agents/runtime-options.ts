import { AGENT_RUNTIME_IDS, type AgentRuntimeId, type RuntimeAvailability } from "@skipper/shared";

// Which runtimes the picker offers (#287). Availability comes from the main
// process; outside Electron there is nothing to probe, so null means "offer them
// all". A saved runtime is never dropped from the list — it stays selectable and
// marked, so an uninstalled CLI can't be silently rewritten by the UI.

export type RuntimeLabelKey = "runtimeClaude" | "runtimeCodex" | "runtimeCopilot" | "runtimeGemini";

export interface RuntimeOption {
  value: AgentRuntimeId;
  /** Key into the settings.orchestration dictionary — labels stay in i18n. */
  labelKey: RuntimeLabelKey;
  installed: boolean;
}

const LABEL_KEYS: Record<AgentRuntimeId, RuntimeLabelKey> = {
  "claude-cli": "runtimeClaude",
  "codex-cli": "runtimeCodex",
  "copilot-cli": "runtimeCopilot",
  "gemini-cli": "runtimeGemini",
};

export function runtimeOptionsFor(
  availability: RuntimeAvailability | null,
  current: AgentRuntimeId,
): readonly RuntimeOption[] {
  return AGENT_RUNTIME_IDS.filter(
    (id) => availability === null || availability[id] || id === current,
  ).map((id) => ({
    value: id,
    labelKey: LABEL_KEYS[id],
    installed: availability === null || availability[id],
  }));
}

export function noneInstalled(availability: RuntimeAvailability | null): boolean {
  return availability !== null && AGENT_RUNTIME_IDS.every((id) => !availability[id]);
}
