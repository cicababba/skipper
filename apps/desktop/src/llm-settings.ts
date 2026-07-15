import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from "@skipper/shared";

// settings.json is written by the embedded Next server, never by main — so this
// re-reads per call instead of caching: a provider switch in Settings has to
// reach the planner/reviewer without an app restart.

export async function readLlmSettings(userDataDir: string): Promise<LlmSettings> {
  try {
    const raw = await readFile(join(userDataDir, "settings.json"), "utf-8");
    const saved = JSON.parse(raw);
    return { ...DEFAULT_LLM_SETTINGS, ...saved.llm };
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
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
