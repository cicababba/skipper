import type { OrchestratorSettings, RepoIntakeSettings } from "@skipper/shared";

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

export const SETTINGS_VALIDATORS: {
  [K in keyof OrchestratorSettings]?: (v: unknown) => OrchestratorSettings[K] | undefined;
} = {
  autoPlanPaused: asBool,
  autoCoding: oneOf("on", "off", "auto"),
  review: oneOf("on", "off", "auto"),
  reviewMaxRounds: clampInt(1, 5),
  ciReentry: oneOf("off", "auto"),
  codingWipPerRepo: clampInt(1, 10),
  // #58: model strings stay opaque CLI aliases — no enum, so a manifest
  // hand-edited to a full model id survives a write from the UI.
  plannerModel: nonEmptyString,
  coderModel: nonEmptyString,
  reviewerModel: nonEmptyString,
  // #240: runtimes are a closed union — an unknown id would break every run.
  plannerRuntime: oneOf("claude-cli", "codex-cli"),
  coderRuntime: oneOf("claude-cli", "codex-cli"),
  reviewerRuntime: oneOf("claude-cli", "codex-cli"),
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
  plannerModel: nonEmptyString,
  coderModel: nonEmptyString,
  reviewerModel: nonEmptyString,
  plannerRuntime: oneOf("claude-cli", "codex-cli"),
  coderRuntime: oneOf("claude-cli", "codex-cli"),
  reviewerRuntime: oneOf("claude-cli", "codex-cli"),
  graphify: asBool,
};

/** The globals an explicit undefined may clear back to their inherited value —
 *  the per-role models (#125) and the per-role runtimes (#240). */
const CLEARABLE_SETTINGS_KEYS: readonly (keyof OrchestratorSettings)[] = [
  "plannerModel",
  "coderModel",
  "reviewerModel",
  "plannerRuntime",
  "coderRuntime",
  "reviewerRuntime",
];

/**
 * Applies a validated settings patch in place (#62). The validator table IS the
 * whitelist: a key absent from it is not writable. `key in patch` (not truthiness)
 * so an absent key is not a clear; explicit undefined clears a per-role model back
 * to inherit llm.claudeModel (#125) or a per-role runtime back to the floor (#240);
 * an invalid value is dropped, never coerced.
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
