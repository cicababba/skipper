import { createProvider } from "@skipper/core";
import type { LLMProviderInterface } from "@skipper/core";
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
    model:
      settings.llm.provider === "claude-cli"
        ? settings.llm.claudeModel
        : settings.llm.provider === "ollama"
          ? settings.llm.ollamaModel
          : settings.llm.openaiModel,
    maxTurns: 5,
    apiKey: settings.llm.provider === "openai" ? settings.llm.openaiApiKey : undefined,
  });

  cachedConfig = configKey;
  return cachedProvider;
}
