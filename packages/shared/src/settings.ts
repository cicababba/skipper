import { DEFAULT_LLM_SETTINGS, type LlmSettings } from "./types";

/** Persisted app settings (settings.json) — read by main and the CLI, edited via IPC. */
export interface AppSettings {
  llm: LlmSettings;
  /** Auto-generate knowledge atoms from git commits (post-commit hook). */
  autoExtractAtoms?: boolean;
  onboardingCompleted?: boolean;
}

/** A deep-partial patch applied over the current settings by `skipper:settings:set`. */
export interface AppSettingsPatch {
  llm?: Partial<LlmSettings>;
  autoExtractAtoms?: boolean;
  onboardingCompleted?: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  llm: { ...DEFAULT_LLM_SETTINGS },
  autoExtractAtoms: true,
  onboardingCompleted: false,
};
