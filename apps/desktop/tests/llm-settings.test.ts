import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from "@skipper/shared";
import type { LLMProviderInterface } from "@skipper/core";
import {
  readLlmSettings,
  readLlmSettingsSync,
  modelForRole,
  providerCacheKey,
  buildLlm,
  injectedBundle,
} from "../src/llm-settings";

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
      JSON.stringify({ llm: { claudeModel: "haiku" }, onboardingCompleted: true }),
      "utf-8",
    );
    const s = await readLlmSettings(dir);
    expect(s.claudeModel).toBe("haiku");
    expect(s.openaiModel).toBe(DEFAULT_LLM_SETTINGS.openaiModel);
  });

  it("reads the model written by the web layer", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ llm: settings({ provider: "claude-cli", claudeModel: "haiku" }) }),
      "utf-8",
    );
    expect(await readLlmSettings(dir)).toMatchObject({ provider: "claude-cli", claudeModel: "haiku" });
  });

  // Settings dropped the provider picker: a settings.json written before the
  // pin would otherwise park every item in needs-input, with no UI left to
  // change the provider back.
  it.each(["openai"])("coerces a stale %s provider to claude-cli", async (stale) => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ llm: settings({ provider: stale as "openai", claudeModel: "haiku" }) }),
      "utf-8",
    );
    const read = await readLlmSettings(dir);
    expect(read.provider).toBe("claude-cli");
    // The rest of the bag survives — only the provider is overridden.
    expect(read.claudeModel).toBe("haiku");
  });
});

// #125: the synchronous sibling backing repoOrch()'s per-role model fallback.
describe("readLlmSettingsSync (#125)", () => {
  it("reads claudeModel written by the web layer", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ llm: { claudeModel: "fable" } }),
      "utf-8",
    );
    expect(readLlmSettingsSync(dir).claudeModel).toBe("fable");
  });

  it("falls back to defaults when settings.json is absent", async () => {
    expect(readLlmSettingsSync(await tempDir())).toEqual(DEFAULT_LLM_SETTINGS);
  });

  it("coerces a stale provider to claude-cli", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ llm: settings({ provider: "openai", claudeModel: "haiku" }) }),
      "utf-8",
    );
    const read = readLlmSettingsSync(dir);
    expect(read.provider).toBe("claude-cli");
    expect(read.claudeModel).toBe("haiku");
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
});

describe("providerCacheKey (#59)", () => {
  it("changes when the provider changes at the same model", () => {
    // The pre-#59 cache keyed on model only, so a provider switch kept serving
    // the previous provider until restart.
    const a = providerCacheKey(settings({ provider: "claude-cli" }), "opus");
    const b = providerCacheKey(settings({ provider: "openai" }), "opus");
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

describe("buildLlm (#238)", () => {
  it("builds a claude-cli provider with a resume-capable runtime", () => {
    const b = buildLlm(settings({ provider: "claude-cli" }), "opus", 5);
    expect(b.llm.name).toBe("claude-cli");
    expect(b.model).toBe("opus");
    expect(b.runtime).toBeDefined();
    expect(b.runtime!.id).toBe("claude-cli");
    expect(b.runtime!.capabilities.resume).toBe(true);
  });

  it("builds an openai provider with no runtime (completions-only)", () => {
    const b = buildLlm(
      settings({ provider: "openai", openaiModel: "gpt-4o", openaiApiKey: "sk-test" }),
      "opus",
      5,
    );
    expect(b.llm.name).toBe("openai");
    // openai ignores the per-role model — it keys off settings.openaiModel.
    expect(b.model).toBe("gpt-4o");
    expect(b.runtime).toBeUndefined();
  });
});

describe("injectedBundle (#238)", () => {
  function fakeProvider(name: string, withAgent: boolean) {
    const agent = vi.fn(async () => ({ text: "agented" }));
    const provider = {
      name,
      ask: vi.fn(),
      askStructured: vi.fn(),
      ...(withAgent ? { agent } : {}),
    } as unknown as LLMProviderInterface;
    return { provider, agent };
  }

  it("wraps a claude-cli provider into a resume-capable runtime", () => {
    const { provider } = fakeProvider("claude-cli", true);
    const b = injectedBundle(provider, "opus");
    expect(b.llm).toBe(provider);
    expect(b.model).toBe("opus");
    expect(b.runtime).toBeDefined();
    expect(b.runtime!.capabilities.resume).toBe(true);
  });

  it("marks a non-claude-cli provider's runtime as non-resumable", () => {
    const { provider } = fakeProvider("openai", true);
    const b = injectedBundle(provider, "opus");
    expect(b.runtime).toBeDefined();
    expect(b.runtime!.capabilities.resume).toBe(false);
  });

  it("returns no runtime for a provider without agent()", () => {
    const { provider } = fakeProvider("openai", false);
    expect(injectedBundle(provider, "opus").runtime).toBeUndefined();
  });

  it("delegates runtime.agent to the injected provider's agent", async () => {
    const { provider, agent } = fakeProvider("claude-cli", true);
    const b = injectedBundle(provider, "opus");
    const out = await b.runtime!.agent("hi", { cwd: "/x" });
    expect(agent).toHaveBeenCalledWith("hi", { cwd: "/x" });
    expect(out).toEqual({ text: "agented" });
  });
});
