import type { AgentRuntimeId, AgentSelection } from "@skipper/shared";

// Which models a runtime offers. The pair is runtime-first: the model menu is
// derived from the selected runtime, so a Claude alias can never be attached to a
// Gemini role. Only claude-cli gets a curated list — the other CLIs run whatever
// their own config says, and a free-text Custom entry covers the rest.

/** Empty model = "the CLI's own configured default" — the sentinel every adapter
 *  reads as "omit the model flag". */
export const CLI_DEFAULT = "";

export type ModelLabelKey =
  | "modelCliDefault"
  | "modelOpus"
  | "modelSonnet"
  | "modelHaiku"
  | "modelFable";

export interface ModelOption {
  value: string;
  /** Key into the settings.orchestration dictionary — labels stay in i18n. */
  labelKey: ModelLabelKey;
}

// Aliases only: the claude CLI resolves each to the newest release of that tier,
// so this list never needs version bumps.
const CLAUDE_ALIASES: readonly ModelOption[] = [
  { value: "opus", labelKey: "modelOpus" },
  { value: "sonnet", labelKey: "modelSonnet" },
  { value: "haiku", labelKey: "modelHaiku" },
  { value: "fable", labelKey: "modelFable" },
];

const CLI_DEFAULT_ONLY: readonly ModelOption[] = [
  { value: CLI_DEFAULT, labelKey: "modelCliDefault" },
];

export function modelOptionsFor(runtime: AgentRuntimeId): readonly ModelOption[] {
  return runtime === "claude-cli" ? CLAUDE_ALIASES : CLI_DEFAULT_ONLY;
}

/** Whether the value is one of the runtime's listed options — anything else is a
 *  hand-written model id and belongs in the Custom… input. */
export function isListedModel(runtime: AgentRuntimeId, value: string): boolean {
  return modelOptionsFor(runtime).some((o) => o.value === value);
}

/** The model a pair falls to when its runtime changes: none, i.e. the new
 *  runtime's own default. Carrying the old model across would be exactly the
 *  cross-vendor mismatch the pair exists to prevent. */
export function resetModel(): string | undefined {
  return undefined;
}

/** The value a pair mirrors onto llm.claudeModel, or undefined when it mirrors
 *  nothing: only an explicit Claude model belongs there — it stays the floor for
 *  every claude pair without a model of its own, and the CLI's knowledge tools
 *  read it straight out of settings.json. */
export function claudeModelMirror(pair: AgentSelection): string | undefined {
  return pair.runtime === "claude-cli" && pair.model ? pair.model : undefined;
}
