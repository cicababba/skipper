import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from "@skipper/shared";

// settings.json is written by main's settings IPC (#208) — this re-reads per
// call instead of caching so a model switch in Settings reaches the
// planner/reviewer without an app restart.

function mergeLlmSettings(raw: string): LlmSettings {
  const saved = JSON.parse(raw);
  return coerceProvider({ ...DEFAULT_LLM_SETTINGS, ...saved.llm });
}

export async function readLlmSettings(userDataDir: string): Promise<LlmSettings> {
  try {
    return mergeLlmSettings(await readFile(join(userDataDir, "settings.json"), "utf-8"));
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

// Sync sibling for the synchronous repoOrch() path (#125): settings.json is tiny and
// re-read per call by the same design as readLlmSettings, so a blocking read is fine.
export function readLlmSettingsSync(userDataDir: string): LlmSettings {
  try {
    return mergeLlmSettings(readFileSync(join(userDataDir, "settings.json"), "utf-8"));
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

/**
 * Settings no longer offers a provider picker — claude-cli is the only backend
 * whose agent() drives the planner. A settings.json written before that pin can
 * still say "openai" or "ollama", and honouring it would park every item in
 * needs-input with no UI left to change it back.
 */
function coerceProvider(settings: LlmSettings): LlmSettings {
  if (settings.provider === "claude-cli") return settings;
  return { ...settings, provider: "claude-cli" };
}

/** Model for a role: the per-role setting is claude-cli-only (#59) — the other
 *  providers key their model off settings.json, since role models are Claude aliases. */
export function modelForRole(settings: LlmSettings, roleModel: string): string {
  switch (settings.provider) {
    case "claude-cli":
      return roleModel;
    case "ollama":
      return settings.ollamaModel;
    case "openai":
      return settings.openaiModel;
  }
}

/** Cache key: a provider switch must not hand back the previous provider. */
export function providerCacheKey(settings: LlmSettings, model: string): string {
  return `${settings.provider}:${model}:${settings.openaiApiKey ? "k" : ""}`;
}
