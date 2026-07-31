import type { LLMProviderInterface } from "../llm/provider";
import type { AgentRuntime } from "./types";

/**
 * Runtime-first structured call: a role that has a runtime runs its
 * structured/repair round on its own CLI (no tools, single turn), so a
 * non-Claude default agent never needs the claude binary. The completions
 * provider stays the fallback for the no-runtime path (openai).
 */
export function structuredCall<T>(
  runtime: AgentRuntime | undefined,
  llm: LLMProviderInterface,
  prompt: string,
  schema: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  if (runtime) {
    return runtime.structured<T>(prompt, schema, {
      tools: "",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
  return llm.askStructured<T>(prompt, schema, opts?.signal ? { signal: opts.signal } : undefined);
}
