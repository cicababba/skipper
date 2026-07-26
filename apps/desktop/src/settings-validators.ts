import type { AgentSelection, OrchestratorSettings, RepoIntakeSettings } from "@skipper/shared";

// Per-key validation for the two settings writers (#62). Each returns the value to
// store, or undefined to reject the write.
export const asBool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;
export const clampInt =
  (min: number, max: number) =>
  (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(max, Math.max(min, Math.round(v)))
      : undefined;
export const oneOf =
  <T extends string>(...allowed: readonly T[]) =>
  (v: unknown): T | undefined =>
    (allowed as readonly unknown[]).includes(v) ? (v as T) : undefined;
export const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const agentRuntimeId = oneOf("claude-cli", "codex-cli", "copilot-cli", "gemini-cli");

/**
 * An agent pair is written whole or not at all: a partially valid pair would
 * resolve a role onto a runtime the user never picked, so an unknown runtime, a
 * blank model or an unknown key rejects the entire write. The model stays an
 * opaque CLI alias (#58) — no enum, so a hand-edited full model id survives.
 */
export const agentSelection = (v: unknown): AgentSelection | undefined => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  if (Object.keys(raw).some((k) => k !== "runtime" && k !== "model")) return undefined;
  const runtime = agentRuntimeId(raw.runtime);
  if (!runtime) return undefined;
  // An explicit `model: undefined` is how the UI says "the runtime's own default"
  // when it resets the pair, and IPC's structured clone keeps the key around.
  if (raw.model === undefined) return { runtime };
  const model = nonEmptyString(raw.model);
  return model ? { runtime, model } : undefined;
};

export const SETTINGS_VALIDATORS: {
  [K in keyof OrchestratorSettings]?: (v: unknown) => OrchestratorSettings[K] | undefined;
} = {
  autoPlanPaused: asBool,
  autoCoding: oneOf("on", "off", "auto"),
  review: oneOf("on", "off", "auto"),
  reviewMaxRounds: clampInt(1, 5),
  ciReentry: oneOf("off", "auto"),
  codingWipPerRepo: clampInt(1, 10),
  defaultAgent: agentSelection,
  plannerAgent: agentSelection,
  coderAgent: agentSelection,
  reviewerAgent: agentSelection,
  coderTimeBudgetMin: clampInt(10, 240),
  plannerTimeBudgetMin: clampInt(5, 60),
};

export const REPO_SETTINGS_VALIDATORS: {
  [K in keyof RepoIntakeSettings]-?: (v: unknown) => RepoIntakeSettings[K] | undefined;
} = {
  followed: asBool,
  priority: oneOf("high", "normal", "low"),
  autoPlan: oneOf("on", "off", "label"),
  autoPlanLabel: nonEmptyString,
  wipLimit: clampInt(1, 10),
  autoCoding: oneOf("on", "off", "auto"),
  review: oneOf("on", "off", "auto"),
  reviewMaxRounds: clampInt(1, 5),
  ciReentry: oneOf("off", "auto"),
  plannerAgent: agentSelection,
  coderAgent: agentSelection,
  reviewerAgent: agentSelection,
  graphify: asBool,
};

/** The globals an explicit undefined may clear back to their inherited value —
 *  the per-role pairs (back to defaultAgent) and defaultAgent itself (back to the
 *  claude-cli floor on llm.claudeModel). */
const CLEARABLE_SETTINGS_KEYS: readonly (keyof OrchestratorSettings)[] = [
  "defaultAgent",
  "plannerAgent",
  "coderAgent",
  "reviewerAgent",
];

/**
 * Applies a validated settings patch in place (#62). The validator table IS the
 * whitelist: a key absent from it is not writable. `key in patch` (not truthiness)
 * so an absent key is not a clear; explicit undefined clears a per-role pair back to
 * inherit defaultAgent, or defaultAgent back to the claude-cli floor; an invalid
 * value is dropped, never coerced.
 */
export function applySettingsPatch(
  settings: OrchestratorSettings,
  patch: Partial<OrchestratorSettings> | undefined,
): void {
  for (const key of Object.keys(SETTINGS_VALIDATORS) as (keyof OrchestratorSettings)[]) {
    // `key in patch`, not a truthiness check: an absent key is not a clear.
    if (!patch || !(key in patch)) continue;
    if ((patch as Record<string, unknown>)[key] === undefined) {
      if (CLEARABLE_SETTINGS_KEYS.includes(key))
        delete (settings as unknown as Record<string, unknown>)[key];
      continue;
    }
    const next = SETTINGS_VALIDATORS[key]!((patch as Record<string, unknown>)[key]);
    if (next !== undefined) (settings as unknown as Record<string, unknown>)[key] = next;
  }
}

/**
 * Merges a validated repo-settings patch onto the current override (#62), returning
 * the merged record. undefined clears an override back to the global; an invalid
 * value is dropped, never coerced (coercing would silently clear a working
 * override). The caller decides whether an empty merge deletes the key.
 */
export function applyRepoSettingsPatch(
  current: RepoIntakeSettings | undefined,
  patch: Partial<RepoIntakeSettings> | undefined,
): RepoIntakeSettings {
  const merged: RepoIntakeSettings = { ...current };
  for (const k of Object.keys(REPO_SETTINGS_VALIDATORS) as (keyof RepoIntakeSettings)[]) {
    if (!patch || !(k in patch)) continue;
    // undefined is meaningful here — it clears the override back to the global.
    if (patch[k] === undefined) {
      delete merged[k];
      continue;
    }
    const next = REPO_SETTINGS_VALIDATORS[k]!(patch[k]);
    // Invalid values are dropped, never coerced to undefined: coercing would
    // silently clear a working override instead of rejecting the write.
    if (next !== undefined) (merged as Record<string, unknown>)[k] = next;
  }
  return merged;
}
