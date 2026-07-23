import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_LLM_SETTINGS,
  type AppSettings,
  type AppSettingsPatch,
  type LlmSettings,
} from "@skipper/shared";

// Settings no longer offers a provider picker — claude-cli is the only backend
// whose agent() drives the planner and the coder end-to-end. A settings.json
// written before that pin can still say "openai" or "ollama", and honouring it
// would park every item in needs-input with no UI left to change it back.
function pinProvider(llm: LlmSettings): LlmSettings {
  return llm.provider === "claude-cli" ? llm : { ...llm, provider: "claude-cli" };
}

/** Merge a deep-partial patch over the current settings, applying the same
 *  guards the old PUT /api/settings route enforced: a masked `sk-...` key is
 *  ignored (keeps the real key), booleans fall through to the current value,
 *  and the provider stays pinned to claude-cli. */
export function mergeSettingsPatch(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  return {
    ...current,
    llm: pinProvider({
      ...current.llm,
      ...patch.llm,
      openaiApiKey:
        patch.llm?.openaiApiKey && !patch.llm.openaiApiKey.startsWith("sk-...")
          ? patch.llm.openaiApiKey
          : current.llm.openaiApiKey,
    }),
    autoExtractAtoms:
      typeof patch.autoExtractAtoms === "boolean"
        ? patch.autoExtractAtoms
        : (current.autoExtractAtoms ?? DEFAULT_APP_SETTINGS.autoExtractAtoms),
    onboardingCompleted:
      typeof patch.onboardingCompleted === "boolean"
        ? patch.onboardingCompleted
        : (current.onboardingCompleted ?? DEFAULT_APP_SETTINGS.onboardingCompleted),
  };
}

/** Mask the OpenAI key before handing settings to the renderer. */
export function maskSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    llm: {
      ...settings.llm,
      openaiApiKey: settings.llm.openaiApiKey
        ? `sk-...${settings.llm.openaiApiKey.slice(-4)}`
        : "",
    },
  };
}

export async function loadAppSettings(dir: string): Promise<AppSettings> {
  try {
    const raw = await readFile(join(dir, "settings.json"), "utf-8");
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_APP_SETTINGS,
      ...saved,
      llm: pinProvider({ ...DEFAULT_LLM_SETTINGS, ...saved.llm }),
      autoExtractAtoms: saved.autoExtractAtoms ?? DEFAULT_APP_SETTINGS.autoExtractAtoms,
      onboardingCompleted: saved.onboardingCompleted ?? DEFAULT_APP_SETTINGS.onboardingCompleted,
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS, llm: { ...DEFAULT_LLM_SETTINGS } };
  }
}

export async function saveAppSettings(dir: string, settings: AppSettings): Promise<void> {
  const path = join(dir, "settings.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2), "utf-8");
}
