import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from "@skipper/shared";
import {
  createProvider,
  createRuntime,
  type AgentRuntime,
  type LLMProviderInterface,
} from "@skipper/core";

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
 * Settings no longer offers a provider picker — the claude-cli runtime is the only
 * backend that drives the planner and coder. A settings.json written before that
 * pin can still say "openai", and honouring it would park every item in
 * needs-input with no UI left to change it back.
 */
function coerceProvider(settings: LlmSettings): LlmSettings {
  if (settings.provider === "claude-cli") return settings;
  return { ...settings, provider: "claude-cli" };
}

/** Model for a role: the per-role setting is claude-cli-only (#59) — openai keys
 *  its model off settings.json, since role models are Claude aliases. */
export function modelForRole(settings: LlmSettings, roleModel: string): string {
  switch (settings.provider) {
    case "claude-cli":
      return roleModel;
    case "openai":
      return settings.openaiModel;
  }
}

/** Cache key: a provider switch must not hand back the previous provider. */
export function providerCacheKey(settings: LlmSettings, model: string): string {
  return `${settings.provider}:${model}:${settings.openaiApiKey ? "k" : ""}`;
}

/** The completions provider, its agent runtime (undefined = completions-only,
 *  e.g. openai), and the resolved model — built together so a role module resolves
 *  the whole agentic bundle in one place (#238). */
export interface LlmBundle {
  llm: LLMProviderInterface;
  runtime?: AgentRuntime;
  model: string;
}

export function buildLlm(settings: LlmSettings, roleModel: string, maxTurns: number): LlmBundle {
  const model = modelForRole(settings, roleModel);
  const llm = createProvider({
    provider: settings.provider,
    model,
    maxTurns,
    apiKey: settings.provider === "openai" ? settings.openaiApiKey : undefined,
  });
  const runtime = createRuntime({ provider: settings.provider, model, maxTurns });
  return { llm, runtime, model };
}

/**
 * Wrap a test-injected provider as a bundle (#238). The fake carries `.agent` /
 * `.askStructured` and a provider name; the runtime delegates to them and its
 * resume capability tracks the claude-cli name (the gate the driver checks).
 * Production always goes through buildLlm — this only feeds the driver test seams.
 */
export function injectedBundle(provider: LLMProviderInterface, roleModel: string): LlmBundle {
  const p = provider as LLMProviderInterface & {
    agent?: (prompt: string, opts?: unknown) => Promise<unknown>;
  };
  const runtime =
    typeof p.agent === "function"
      ? ({
          id: "claude-cli",
          capabilities: {
            streaming: true,
            resume: provider.name === "claude-cli",
            confinement: "rules",
            mcp: true,
          },
          agent: (prompt: string, opts?: unknown) => p.agent!(prompt, opts),
          structured: (prompt: string, schema: Record<string, unknown>, opts?: unknown) =>
            provider.askStructured(prompt, schema, opts as never),
          runCoding: () => {
            throw new Error("injected runtime has no runCoding");
          },
        } as unknown as AgentRuntime)
      : undefined;
  return { llm: provider, runtime, model: roleModel };
}
