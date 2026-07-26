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

  it("clamps the coder time budget to 10–240 (#194)", () => {
    const lo = baseSettings();
    applySettingsPatch(lo, { coderTimeBudgetMin: 1 });
    expect(lo.coderTimeBudgetMin).toBe(10);
    const hi = baseSettings();
    applySettingsPatch(hi, { coderTimeBudgetMin: 999 });
    expect(hi.coderTimeBudgetMin).toBe(240);
    const ok = baseSettings();
    applySettingsPatch(ok, { coderTimeBudgetMin: 90 });
    expect(ok.coderTimeBudgetMin).toBe(90);
  });

  it("clamps the planner time budget to 5–60 (#194)", () => {
    const lo = baseSettings();
    applySettingsPatch(lo, { plannerTimeBudgetMin: 1 });
    expect(lo.plannerTimeBudgetMin).toBe(5);
    const hi = baseSettings();
    applySettingsPatch(hi, { plannerTimeBudgetMin: 999 });
    expect(hi.plannerTimeBudgetMin).toBe(60);
  });

  // #240: the runtime keys are a closed union — an unknown id has no runtime
  // behind it, so it must be rejected rather than stored and crashed on later.
  it("stores a valid per-role runtime and drops an invalid one", () => {
    const s = baseSettings();
    applySettingsPatch(s, { coderRuntime: "codex-cli" });
    expect(s.coderRuntime).toBe("codex-cli");
    applySettingsPatch(s, { coderRuntime: "cursor-cli" as unknown as "codex-cli" });
    expect(s.coderRuntime).toBe("codex-cli");
  });

  // #242: copilot-cli joined the union — every one of the three global keys has
  // to accept it, or a Copilot selection silently falls back to the floor.
  it("accepts copilot-cli on each of the three role keys", () => {
    const s = baseSettings();
    applySettingsPatch(s, {
      plannerRuntime: "copilot-cli",
      coderRuntime: "copilot-cli",
      reviewerRuntime: "copilot-cli",
    });
    expect(s.plannerRuntime).toBe("copilot-cli");
    expect(s.coderRuntime).toBe("copilot-cli");
    expect(s.reviewerRuntime).toBe("copilot-cli");
  });

  // #243: gemini-cli joined the union — it was the rejected-value fixture above
  // until this issue, so every global key has to accept it now.
  it("accepts gemini-cli on each of the three role keys", () => {
    const s = baseSettings();
    applySettingsPatch(s, {
      plannerRuntime: "gemini-cli",
      coderRuntime: "gemini-cli",
      reviewerRuntime: "gemini-cli",
    });
    expect(s.plannerRuntime).toBe("gemini-cli");
    expect(s.coderRuntime).toBe("gemini-cli");
    expect(s.reviewerRuntime).toBe("gemini-cli");
  });

  it("explicit undefined clears a per-role runtime back to the floor", () => {
    const s = baseSettings();
    s.plannerRuntime = "codex-cli";
    applySettingsPatch(s, { plannerRuntime: undefined });
    expect("plannerRuntime" in s).toBe(false);
  });

  it("writes each role's runtime independently", () => {
    const s = baseSettings();
    applySettingsPatch(s, { plannerRuntime: "claude-cli", reviewerRuntime: "codex-cli" });
    expect(s.plannerRuntime).toBe("claude-cli");
    expect(s.reviewerRuntime).toBe("codex-cli");
    expect("coderRuntime" in s).toBe(false);
  });

  it("no longer writes the retired turn knobs (#194)", () => {
    const s = baseSettings();
    applySettingsPatch(s, {
      coderMaxTurns: 120,
      plannerMaxTurns: 80,
    } as unknown as Partial<OrchestratorSettings>);
    expect((s as unknown as Record<string, unknown>).coderMaxTurns).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).plannerMaxTurns).toBeUndefined();
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

  // #240, per-repo half: same closed union, same clear-to-inherit semantics as
  // every other override — undefined means "fall back to the global".
  it("stores a valid per-role runtime override and drops an invalid one", () => {
    expect(applyRepoSettingsPatch(undefined, { coderRuntime: "codex-cli" })).toEqual({
      coderRuntime: "codex-cli",
    });
    expect(
      applyRepoSettingsPatch(
        { coderRuntime: "codex-cli" },
        { coderRuntime: "cursor-cli" as unknown as "codex-cli" },
      ),
    ).toEqual({ coderRuntime: "codex-cli" });
  });

  it("accepts copilot-cli on each of the three per-repo role keys (#242)", () => {
    expect(
      applyRepoSettingsPatch(undefined, {
        plannerRuntime: "copilot-cli",
        coderRuntime: "copilot-cli",
        reviewerRuntime: "copilot-cli",
      }),
    ).toEqual({
      plannerRuntime: "copilot-cli",
      coderRuntime: "copilot-cli",
      reviewerRuntime: "copilot-cli",
    });
  });

  it("accepts gemini-cli on each of the three per-repo role keys (#243)", () => {
    expect(
      applyRepoSettingsPatch(undefined, {
        plannerRuntime: "gemini-cli",
        coderRuntime: "gemini-cli",
        reviewerRuntime: "gemini-cli",
      }),
    ).toEqual({
      plannerRuntime: "gemini-cli",
      coderRuntime: "gemini-cli",
      reviewerRuntime: "gemini-cli",
    });
  });

  it("undefined clears a per-role runtime override back to the global", () => {
    expect(
      applyRepoSettingsPatch({ coderRuntime: "codex-cli" }, { coderRuntime: undefined }),
    ).toEqual({});
  });

  it("keeps the three role runtimes independent", () => {
    const merged = applyRepoSettingsPatch(
      { plannerRuntime: "codex-cli" },
      { reviewerRuntime: "claude-cli" },
    );
    expect(merged).toEqual({ plannerRuntime: "codex-cli", reviewerRuntime: "claude-cli" });
  });

  it("keeps a boolean graphify toggle and drops a non-bool (#233)", () => {
    expect(applyRepoSettingsPatch(undefined, { graphify: true })).toEqual({ graphify: true });
    // A non-bool is rejected, never coerced.
    expect(
      applyRepoSettingsPatch(undefined, { graphify: "yes" as unknown as boolean }),
    ).toEqual({});
    // undefined clears the toggle back to off (its absence).
    expect(applyRepoSettingsPatch({ graphify: true }, { graphify: undefined })).toEqual({});
  });
});
