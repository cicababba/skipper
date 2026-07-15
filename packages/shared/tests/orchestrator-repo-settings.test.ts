import { describe, it, expect } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  resolveRepoOrchestratorSettings,
  type OrchestratorSettings,
  type RepoIntakeSettings,
} from "../src/orchestrator";

const global = (overrides: Partial<OrchestratorSettings> = {}): OrchestratorSettings => ({
  ...DEFAULT_ORCHESTRATOR_SETTINGS,
  ...overrides,
});

const resolve = (repo?: RepoIntakeSettings, overrides?: Partial<OrchestratorSettings>) =>
  resolveRepoOrchestratorSettings(repo, global(overrides));

describe("resolveRepoOrchestratorSettings", () => {
  it("inherits every global-overridable field when the repo has no overrides", () => {
    const g = global({
      codingWipPerRepo: 4,
      autoCoding: "off",
      review: "on",
      reviewMaxRounds: 5,
      plannerModel: "opus",
      coderModel: "sonnet",
      reviewerModel: "haiku",
    });
    expect(resolveRepoOrchestratorSettings(undefined, g)).toMatchObject({
      wipLimit: 4,
      autoCoding: "off",
      review: "on",
      reviewMaxRounds: 5,
      plannerModel: "opus",
      coderModel: "sonnet",
      reviewerModel: "haiku",
    });
  });

  it("still carries the intake fields", () => {
    expect(resolve({ followed: false, priority: "high", autoPlan: "label" })).toMatchObject({
      followed: false,
      priority: "high",
      autoPlan: "label",
      autoPlanLabel: "ai-ready",
    });
  });

  it.each([
    ["wipLimit", { wipLimit: 7 }, { codingWipPerRepo: 2 }, 7],
    ["autoCoding", { autoCoding: "on" }, { autoCoding: "off" }, "on"],
    ["review", { review: "off" }, { review: "on" }, "off"],
    ["reviewMaxRounds", { reviewMaxRounds: 1 }, { reviewMaxRounds: 4 }, 1],
    // #58 — per-role model overrides.
    ["plannerModel", { plannerModel: "sonnet" }, { plannerModel: "opus" }, "sonnet"],
    ["coderModel", { coderModel: "haiku" }, { coderModel: "opus" }, "haiku"],
    ["reviewerModel", { reviewerModel: "opus" }, { reviewerModel: "haiku" }, "opus"],
  ] as const)("lets a per-repo %s beat the global", (key, repo, overrides, expected) => {
    const resolved = resolve(repo, overrides) as unknown as Record<string, unknown>;
    expect(resolved[key]).toBe(expected);
  });

  it("overrides each field independently", () => {
    const resolved = resolve({ review: "off" }, { autoCoding: "on", review: "on" });
    expect(resolved.review).toBe("off");
    expect(resolved.autoCoding).toBe("on");
  });

  // #58: each role resolves on its own — overriding one must not disturb the rest.
  it("overrides one role's model while the others inherit", () => {
    const resolved = resolve(
      { coderModel: "haiku" },
      { plannerModel: "opus", coderModel: "sonnet", reviewerModel: "sonnet" },
    );
    expect(resolved.coderModel).toBe("haiku");
    expect(resolved.plannerModel).toBe("opus");
    expect(resolved.reviewerModel).toBe("sonnet");
  });

  // #58: model strings are opaque CLI aliases — a hand-edited full id resolves as-is.
  it("treats a model string as opaque", () => {
    expect(resolve({ plannerModel: "claude-opus-4-8" }).plannerModel).toBe("claude-opus-4-8");
  });

  // #47: the gap resolveRepoIntakeSettings never covered — wipLimit falls back to
  // the differently-named global, which is why the inline ?? chain existed.
  it("falls wipLimit back to the global codingWipPerRepo", () => {
    expect(resolve({}, { codingWipPerRepo: 9 }).wipLimit).toBe(9);
  });

  // #62: autoPlanPaused is a master switch applied at the planner's triage branch,
  // never a per-repo default. Folding it in here would make the repo settings
  // <select> write autoPlan:"off" to the manifest on the next change.
  it("does not fold in the autoPlanPaused master switch", () => {
    const resolved = resolve({}, { autoPlanPaused: true });
    expect(resolved).not.toHaveProperty("autoPlanPaused");
    expect(resolved.autoPlan).toBe("on");
  });
});
