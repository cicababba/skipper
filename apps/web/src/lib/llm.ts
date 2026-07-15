import { createProvider } from "@skipper/core";
import type { LLMProviderInterface } from "@skipper/core";
import type { LlmSettings } from "@skipper/shared";
import { loadSettings } from "./settings";
import { ensureNativeLoadersRegistered } from "./native-loader";

// Register native loaders as a side effect of importing llm.ts.
// Every API route imports getLLM(), so this runs once at server startup.
ensureNativeLoadersRegistered();

let cachedProvider: LLMProviderInterface | null = null;
let cachedConfig: string = "";

export async function getLLM(): Promise<LLMProviderInterface> {
  const settings = await loadSettings();
  const configKey = JSON.stringify(settings.llm);

  // Recreate provider if settings changed
  if (cachedProvider && cachedConfig === configKey) {
    return cachedProvider;
  }

  cachedProvider = createProvider({
    provider: settings.llm.provider,
    model: modelFor(settings.llm),
    maxTurns: 5,
    apiKey: apiKeyFor(settings.llm),
  });

  cachedConfig = configKey;
  return cachedProvider;
}

/** Role models are Claude aliases — every other provider carries its own. */
function modelFor(llm: LlmSettings): string {
  switch (llm.provider) {
    case "claude-cli":
      return llm.claudeModel;
    case "codex-cli":
      return llm.codexModel;
    case "ollama":
      return llm.ollamaModel;
    case "openai":
      return llm.openaiModel;
  }
}

function apiKeyFor(llm: LlmSettings): string | undefined {
  if (llm.provider === "openai") return llm.openaiApiKey || undefined;
  if (llm.provider === "codex-cli") return llm.codexApiKey || undefined;
  return undefined;
}
