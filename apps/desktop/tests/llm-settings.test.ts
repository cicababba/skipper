import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from "@skipper/shared";
import { readLlmSettings, modelForRole, providerCacheKey } from "../src/llm-settings";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "llm-settings-"));
}

function settings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return { ...DEFAULT_LLM_SETTINGS, ...overrides };
}

describe("readLlmSettings (#59)", () => {
  it("falls back to defaults when settings.json is absent", async () => {
    // The live path today: main never writes settings.json, so a user who has
    // not saved Settings must still get a working claude-cli planner.
    expect(await readLlmSettings(await tempDir())).toEqual(DEFAULT_LLM_SETTINGS);
  });

  it("falls back to defaults on malformed JSON", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "settings.json"), "{ not json", "utf-8");
    expect(await readLlmSettings(dir)).toEqual(DEFAULT_LLM_SETTINGS);
  });

  it("merges a partial llm block over the defaults", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ llm: { provider: "ollama", ollamaModel: "llama3" }, onboardingCompleted: true }),
      "utf-8",
    );
    const s = await readLlmSettings(dir);
    expect(s.provider).toBe("ollama");
    expect(s.ollamaModel).toBe("llama3");
    expect(s.claudeModel).toBe(DEFAULT_LLM_SETTINGS.claudeModel);
  });

  it("reads the provider written by the web layer", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ llm: settings({ provider: "openai", openaiModel: "gpt-4o", openaiApiKey: "sk-x" }) }),
      "utf-8",
    );
    expect(await readLlmSettings(dir)).toMatchObject({ provider: "openai", openaiModel: "gpt-4o" });
  });
});

describe("modelForRole (#59)", () => {
  it("uses the per-role model for claude-cli", () => {
    expect(modelForRole(settings({ provider: "claude-cli" }), "opus")).toBe("opus");
  });

  it("ignores the per-role model for openai — role models are Claude aliases", () => {
    // Regression guard: passing "opus" to the OpenAI API would 400.
    expect(modelForRole(settings({ provider: "openai", openaiModel: "gpt-4o" }), "opus")).toBe("gpt-4o");
  });

  it("ignores the per-role model for ollama", () => {
    expect(modelForRole(settings({ provider: "ollama", ollamaModel: "llama3" }), "opus")).toBe("llama3");
  });
});

describe("providerCacheKey (#59)", () => {
  it("changes when the provider changes at the same model", () => {
    // The pre-#59 cache keyed on model only, so a provider switch kept serving
    // the previous provider until restart.
    const a = providerCacheKey(settings({ provider: "claude-cli" }), "opus");
    const b = providerCacheKey(settings({ provider: "ollama" }), "opus");
    expect(a).not.toBe(b);
  });

  it("changes when the model changes", () => {
    expect(providerCacheKey(settings(), "opus")).not.toBe(providerCacheKey(settings(), "sonnet"));
  });

  it("changes when an openai key is added", () => {
    const withoutKey = providerCacheKey(settings({ provider: "openai" }), "gpt-4o");
    const withKey = providerCacheKey(settings({ provider: "openai", openaiApiKey: "sk-x" }), "gpt-4o");
    expect(withoutKey).not.toBe(withKey);
  });

  it("is stable for identical settings", () => {
    expect(providerCacheKey(settings(), "opus")).toBe(providerCacheKey(settings(), "opus"));
  });
});
