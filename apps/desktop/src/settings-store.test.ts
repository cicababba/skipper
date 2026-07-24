import { describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "@skipper/shared";
import { mergeSettingsPatch, maskSettings } from "./settings-store";

function base(): AppSettings {
  return {
    llm: {
      provider: "claude-cli",
      openaiApiKey: "sk-realkey1234",
      openaiModel: "gpt-4o",
      claudeModel: "sonnet",
    },
    autoExtractAtoms: true,
    onboardingCompleted: true,
  };
}

describe("mergeSettingsPatch", () => {
  it("applies a claudeModel change", () => {
    const merged = mergeSettingsPatch(base(), { llm: { claudeModel: "opus" } });
    expect(merged.llm.claudeModel).toBe("opus");
  });

  it("ignores a masked openaiApiKey, keeping the real key", () => {
    const merged = mergeSettingsPatch(base(), { llm: { openaiApiKey: "sk-...1234" } });
    expect(merged.llm.openaiApiKey).toBe("sk-realkey1234");
  });

  it("accepts a real openaiApiKey", () => {
    const merged = mergeSettingsPatch(base(), { llm: { openaiApiKey: "sk-brandnew9999" } });
    expect(merged.llm.openaiApiKey).toBe("sk-brandnew9999");
  });

  it("pins the provider to claude-cli even if a patch tries to change it", () => {
    const merged = mergeSettingsPatch(base(), { llm: { provider: "openai" } });
    expect(merged.llm.provider).toBe("claude-cli");
  });

  it("guards autoExtractAtoms against non-boolean and keeps current", () => {
    const merged = mergeSettingsPatch(base(), {});
    expect(merged.autoExtractAtoms).toBe(true);
  });

  it("updates autoExtractAtoms when a boolean is given", () => {
    const merged = mergeSettingsPatch(base(), { autoExtractAtoms: false });
    expect(merged.autoExtractAtoms).toBe(false);
  });

  it("updates onboardingCompleted when a boolean is given", () => {
    const start = { ...base(), onboardingCompleted: false };
    const merged = mergeSettingsPatch(start, { onboardingCompleted: true });
    expect(merged.onboardingCompleted).toBe(true);
  });

  it("falls back to defaults when current values are undefined", () => {
    const start: AppSettings = { llm: { ...DEFAULT_APP_SETTINGS.llm } };
    const merged = mergeSettingsPatch(start, {});
    expect(merged.autoExtractAtoms).toBe(DEFAULT_APP_SETTINGS.autoExtractAtoms);
    expect(merged.onboardingCompleted).toBe(DEFAULT_APP_SETTINGS.onboardingCompleted);
  });
});

describe("maskSettings", () => {
  it("masks a present openaiApiKey to sk-...<last4>", () => {
    expect(maskSettings(base()).llm.openaiApiKey).toBe("sk-...1234");
  });

  it("leaves an empty key empty", () => {
    const start = { ...base(), llm: { ...base().llm, openaiApiKey: "" } };
    expect(maskSettings(start).llm.openaiApiKey).toBe("");
  });

  it("does not mutate the input", () => {
    const start = base();
    maskSettings(start);
    expect(start.llm.openaiApiKey).toBe("sk-realkey1234");
  });
});
