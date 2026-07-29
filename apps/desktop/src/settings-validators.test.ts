import { describe, it, expect } from "vitest";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/core";
import type { OrchestratorSettings, RepoIntakeSettings } from "@skipper/shared";
import {
  asBool,
  clampInt,
  oneOf,
  nonEmptyString,
  agentSelection,
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

  // The pair is atomic: anything less than a fully valid pair would resolve a role
  // onto a runtime the user never picked, so the whole write is rejected.
  it("agentSelection accepts a runtime-only pair", () => {
    expect(agentSelection({ runtime: "gemini-cli" })).toEqual({ runtime: "gemini-cli" });
    expect(agentSelection({ runtime: "claude-cli", model: undefined })).toEqual({
      runtime: "claude-cli",
    });
  });

  it("agentSelection accepts a runtime + model pair and trims the model", () => {
    expect(agentSelection({ runtime: "claude-cli", model: "  opus  " })).toEqual({
      runtime: "claude-cli",
      model: "opus",
    });
    // Opaque alias: a full model id stays selectable.
    expect(agentSelection({ runtime: "claude-cli", model: "claude-opus-4-8" })).toEqual({
      runtime: "claude-cli",
      model: "claude-opus-4-8",
    });
  });

  it("agentSelection rejects an unknown runtime, a blank model and extra keys", () => {
    expect(agentSelection({ runtime: "cursor-cli" })).toBeUndefined();
    expect(agentSelection({ model: "opus" })).toBeUndefined();
    expect(agentSelection({ runtime: "claude-cli", model: "" })).toBeUndefined();
    expect(agentSelection({ runtime: "claude-cli", model: "   " })).toBeUndefined();
    expect(agentSelection({ runtime: "claude-cli", model: 5 })).toBeUndefined();
    expect(agentSelection({ runtime: "claude-cli", extra: true })).toBeUndefined();
  });

  it("agentSelection rejects non-objects", () => {
    expect(agentSelection("claude-cli")).toBeUndefined();
    expect(agentSelection(null)).toBeUndefined();
    expect(agentSelection([{ runtime: "claude-cli" }])).toBeUndefined();
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
    s.plannerAgent = { runtime: "claude-cli", model: "opus" };
    applySettingsPatch(s, { codingWipPerRepo: 2 });
    expect(s.plannerAgent).toEqual({ runtime: "claude-cli", model: "opus" });
  });

  it("explicit undefined clears a per-role pair back to inherit", () => {
    const s = baseSettings();
    s.plannerAgent = { runtime: "claude-cli", model: "opus" };
    applySettingsPatch(s, { plannerAgent: undefined });
    expect("plannerAgent" in s).toBe(false);
  });

  // #136: the composer joins the three older roles on both writer tables.
  it("stores and clears the composer pair like any other role", () => {
    const s = baseSettings();
    applySettingsPatch(s, { composerAgent: { runtime: "codex-cli" } });
    expect(s.composerAgent).toEqual({ runtime: "codex-cli" });
    applySettingsPatch(s, { composerAgent: { runtime: "nope" } as never });
    expect(s.composerAgent).toEqual({ runtime: "codex-cli" });
    applySettingsPatch(s, { composerAgent: undefined });
    expect("composerAgent" in s).toBe(false);
  });

  it("explicit undefined clears defaultAgent back to the claude floor", () => {
    const s = baseSettings();
    s.defaultAgent = { runtime: "gemini-cli" };
    applySettingsPatch(s, { defaultAgent: undefined });
    expect("defaultAgent" in s).toBe(false);
  });

  it("explicit undefined on a non-pair key clears nothing", () => {
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

  // The runtime half of a pair is a closed union — an unknown id has no runtime
  // behind it, so the write must be rejected rather than stored and crashed on later.
  it("stores a valid per-role pair and drops an invalid one", () => {
    const s = baseSettings();
    applySettingsPatch(s, { coderAgent: { runtime: "codex-cli" } });
    expect(s.coderAgent).toEqual({ runtime: "codex-cli" });
    applySettingsPatch(s, {
      coderAgent: { runtime: "cursor-cli" } as unknown as { runtime: "codex-cli" },
    });
    expect(s.coderAgent).toEqual({ runtime: "codex-cli" });
  });

  it("accepts every runtime in the union on each pair key", () => {
    for (const runtime of ["claude-cli", "codex-cli", "copilot-cli", "gemini-cli"] as const) {
      const s = baseSettings();
      applySettingsPatch(s, {
        defaultAgent: { runtime },
        plannerAgent: { runtime },
        coderAgent: { runtime },
        reviewerAgent: { runtime },
      });
      expect(s.defaultAgent).toEqual({ runtime });
      expect(s.plannerAgent).toEqual({ runtime });
      expect(s.coderAgent).toEqual({ runtime });
      expect(s.reviewerAgent).toEqual({ runtime });
    }
  });

  it("writes each role's pair independently", () => {
    const s = baseSettings();
    applySettingsPatch(s, {
      plannerAgent: { runtime: "claude-cli", model: "opus" },
      reviewerAgent: { runtime: "codex-cli" },
    });
    expect(s.plannerAgent).toEqual({ runtime: "claude-cli", model: "opus" });
    expect(s.reviewerAgent).toEqual({ runtime: "codex-cli" });
    expect("coderAgent" in s).toBe(false);
  });

  // The pair is atomic on the way in too: a bad model must not land a bare runtime.
  it("rejects a pair whose model half is invalid, leaving the old pair standing", () => {
    const s = baseSettings();
    s.coderAgent = { runtime: "claude-cli", model: "opus" };
    applySettingsPatch(s, { coderAgent: { runtime: "gemini-cli", model: "" } });
    expect(s.coderAgent).toEqual({ runtime: "claude-cli", model: "opus" });
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

  // Per-repo half of the pair: same atomic validation, same clear-to-inherit
  // semantics as every other override — undefined means "fall back to the global".
  it("stores a valid per-role pair override and drops an invalid one", () => {
    expect(applyRepoSettingsPatch(undefined, { coderAgent: { runtime: "codex-cli" } })).toEqual({
      coderAgent: { runtime: "codex-cli" },
    });
    expect(
      applyRepoSettingsPatch(
        { coderAgent: { runtime: "codex-cli" } },
        { coderAgent: { runtime: "cursor-cli" } as unknown as { runtime: "codex-cli" } },
      ),
    ).toEqual({ coderAgent: { runtime: "codex-cli" } });
  });

  it("accepts every runtime in the union on each per-repo pair key", () => {
    for (const runtime of ["claude-cli", "codex-cli", "copilot-cli", "gemini-cli"] as const) {
      expect(
        applyRepoSettingsPatch(undefined, {
          plannerAgent: { runtime },
          coderAgent: { runtime },
          reviewerAgent: { runtime },
        }),
      ).toEqual({
        plannerAgent: { runtime },
        coderAgent: { runtime },
        reviewerAgent: { runtime },
      });
    }
  });

  it("undefined clears a per-role pair override back to the global", () => {
    expect(
      applyRepoSettingsPatch({ coderAgent: { runtime: "codex-cli" } }, { coderAgent: undefined }),
    ).toEqual({});
  });

  it("keeps the three role pairs independent", () => {
    const merged = applyRepoSettingsPatch(
      { plannerAgent: { runtime: "codex-cli" } },
      { reviewerAgent: { runtime: "claude-cli", model: "haiku" } },
    );
    expect(merged).toEqual({
      plannerAgent: { runtime: "codex-cli" },
      reviewerAgent: { runtime: "claude-cli", model: "haiku" },
    });
  });

  // #136: the per-repo composer override behaves like the other three.
  it("stores and clears a per-repo composer pair override", () => {
    expect(applyRepoSettingsPatch(undefined, { composerAgent: { runtime: "gemini-cli" } })).toEqual({
      composerAgent: { runtime: "gemini-cli" },
    });
    expect(
      applyRepoSettingsPatch({ composerAgent: { runtime: "gemini-cli" } }, { composerAgent: undefined }),
    ).toEqual({});
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
