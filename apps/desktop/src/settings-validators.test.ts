import { describe, it, expect } from "vitest";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/core";
import type { OrchestratorSettings, RepoIntakeSettings } from "@skipper/shared";
import {
  asBool,
  clampInt,
  oneOf,
  nonEmptyString,
  applySettingsPatch,
  applyRepoSettingsPatch,
} from "./settings-validators";

describe("combinators", () => {
  it("asBool accepts only booleans", () => {
    expect(asBool(true)).toBe(true);
    expect(asBool(false)).toBe(false);
    expect(asBool("true")).toBeUndefined();
    expect(asBool(1)).toBeUndefined();
  });

  it("clampInt rounds, clamps, and rejects non-finite", () => {
    const c = clampInt(1, 10);
    expect(c(3.4)).toBe(3);
    expect(c(3.6)).toBe(4);
    expect(c(-5)).toBe(1);
    expect(c(50)).toBe(10);
    expect(c(NaN)).toBeUndefined();
    expect(c(Infinity)).toBeUndefined();
    expect(c("5")).toBeUndefined();
  });

  it("oneOf accepts only listed values", () => {
    const o = oneOf("on", "off", "auto");
    expect(o("on")).toBe("on");
    expect(o("nope")).toBeUndefined();
    expect(o(42)).toBeUndefined();
  });

  it("nonEmptyString trims and rejects empty/non-string", () => {
    expect(nonEmptyString("  x  ")).toBe("x");
    expect(nonEmptyString("   ")).toBeUndefined();
    expect(nonEmptyString("")).toBeUndefined();
    expect(nonEmptyString(5)).toBeUndefined();
  });
});

function baseSettings(): OrchestratorSettings {
  return { ...DEFAULT_ORCHESTRATOR_SETTINGS };
}

describe("applySettingsPatch", () => {
  it("writes only whitelisted keys and drops non-whitelisted", () => {
    const s = baseSettings();
    applySettingsPatch(s, { codingWipPerRepo: 3, notAKey: 99 } as Partial<OrchestratorSettings>);
    expect(s.codingWipPerRepo).toBe(3);
    expect((s as unknown as Record<string, unknown>).notAKey).toBeUndefined();
  });

  it("clamps a validated value", () => {
    const s = baseSettings();
    applySettingsPatch(s, { codingWipPerRepo: 999 });
    expect(s.codingWipPerRepo).toBe(10);
  });

  it("treats an absent key as no-op, not a clear", () => {
    const s = baseSettings();
    s.plannerModel = "opus";
    applySettingsPatch(s, { codingWipPerRepo: 2 });
    expect(s.plannerModel).toBe("opus");
  });

  it("explicit undefined clears a per-role model back to inherit", () => {
    const s = baseSettings();
    s.plannerModel = "opus";
    applySettingsPatch(s, { plannerModel: undefined });
    expect("plannerModel" in s).toBe(false);
  });

  it("explicit undefined on a non-model key clears nothing", () => {
    const s = baseSettings();
    const before = s.codingWipPerRepo;
    applySettingsPatch(s, { codingWipPerRepo: undefined });
    expect(s.codingWipPerRepo).toBe(before);
  });

  it("leaves an existing value standing when the new one is invalid", () => {
    const s = baseSettings();
    s.codingWipPerRepo = 4;
    applySettingsPatch(s, { codingWipPerRepo: "bad" as unknown as number });
    expect(s.codingWipPerRepo).toBe(4);
  });
});

describe("applyRepoSettingsPatch", () => {
  it("merges validated overrides onto the current record", () => {
    const current: RepoIntakeSettings = { followed: true };
    const merged = applyRepoSettingsPatch(current, { priority: "high", wipLimit: 2 });
    expect(merged).toEqual({ followed: true, priority: "high", wipLimit: 2 });
    // does not mutate the input
    expect(current).toEqual({ followed: true });
  });

  it("undefined deletes an override back to the global", () => {
    const merged = applyRepoSettingsPatch({ followed: true, priority: "high" }, { priority: undefined });
    expect(merged).toEqual({ followed: true });
  });

  it("drops an invalid value, leaving the existing override standing", () => {
    const merged = applyRepoSettingsPatch(
      { wipLimit: 5 },
      { wipLimit: "nope" as unknown as number },
    );
    expect(merged).toEqual({ wipLimit: 5 });
  });

  it("handles an undefined current record", () => {
    const merged = applyRepoSettingsPatch(undefined, { followed: true });
    expect(merged).toEqual({ followed: true });
  });
});
