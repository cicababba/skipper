import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from "@skipper/shared";

export interface AppSettings {
  llm: LlmSettings;
  /** Auto-generate knowledge atoms from git commits (post-commit hook). */
  autoExtractAtoms?: boolean;
  onboardingCompleted?: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  llm: { ...DEFAULT_LLM_SETTINGS },
  autoExtractAtoms: true,
  onboardingCompleted: false,
};

function getSettingsPath(): string {
  const base = process.env.SKIPPER_DATA_DIR
    ? resolve(process.env.SKIPPER_DATA_DIR)
    : resolve(process.cwd(), "../../data");
  return join(base, "settings.json");
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(getSettingsPath(), "utf-8");
    const saved = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      llm: { ...DEFAULT_SETTINGS.llm, ...saved.llm },
      autoExtractAtoms: saved.autoExtractAtoms ?? DEFAULT_SETTINGS.autoExtractAtoms,
      onboardingCompleted: saved.onboardingCompleted ?? DEFAULT_SETTINGS.onboardingCompleted,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const path = getSettingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2), "utf-8");
}
