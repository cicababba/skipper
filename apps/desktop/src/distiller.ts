import {
  distillLesson as realDistillLesson,
  type DistillInput,
  type OrchestratorSettings,
} from "@skipper/core";
import { resolveDefaultAgentPair, type LlmSettings } from "@skipper/shared";
import { buildLlm, providerCacheKey, type LlmBundle } from "./llm-settings";

// Lesson distillation driver (#256): the desktop side of the memory distiller —
// resolves the (runtime, model) pair and runs one structured call. Distillation
// has no role of its own by decision: it always rides the global defaultAgent,
// so there is nothing to configure and nothing to keep in sync per repo.

export interface DistillerDeps {
  getSettings: () => OrchestratorSettings;
  getLlmSettings: () => Promise<LlmSettings>;
  /** Test seam — an injected bundle skips provider construction. */
  bundle?: LlmBundle;
}

let deps: DistillerDeps | null = null;
let bundle: LlmBundle | null = null;
let bundleKey: string | null = null;

export function initDistiller(distillerDeps: DistillerDeps): void {
  deps = distillerDeps;
  bundle = null;
  bundleKey = null;
}

async function resolveBundle(): Promise<LlmBundle> {
  if (deps!.bundle) return deps!.bundle;
  const settings = await deps!.getLlmSettings();
  const pair = resolveDefaultAgentPair(deps!.getSettings(), settings.claudeModel);
  const key = providerCacheKey(settings, pair.model, pair.runtime);
  if (!bundle || bundleKey !== key) {
    bundle = buildLlm(settings, pair.model, 1, pair.runtime);
    bundleKey = key;
  }
  return bundle;
}

/**
 * Distill one record's lesson. null when distillation is unavailable (no driver,
 * completions-only provider) or the model produced nothing usable; errors from
 * the run propagate so the caller decides how loud the failure is.
 */
export async function distillForRecord(input: DistillInput): Promise<string | null> {
  if (!deps) return null;
  const { runtime } = await resolveBundle();
  if (!runtime) return null;
  return realDistillLesson(runtime, input);
}
