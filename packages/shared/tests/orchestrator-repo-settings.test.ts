import { describe, it, expect } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  resolveRepoOrchestratorSettings,
  type OrchestratorSettings,
  type RepoIntakeSettings,
} from "../src/orchestrator";
import { DEFAULT_AGENT_RUNTIME } from "../src/types";

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

  // #125: the per-role globals are optional overrides of llm.claudeModel. Resolution
  // order per role: repo override → global override → defaultModel → "sonnet" floor.
  describe("role model inheritance (#125)", () => {
    it("falls each role back to defaultModel when repo and global are absent", () => {
      const resolved = resolveRepoOrchestratorSettings(undefined, global(), "fable");
      expect(resolved.plannerModel).toBe("fable");
      expect(resolved.coderModel).toBe("fable");
      expect(resolved.reviewerModel).toBe("fable");
    });

    it("lets a global override beat defaultModel", () => {
      const resolved = resolveRepoOrchestratorSettings(
        undefined,
        global({ plannerModel: "opus" }),
        "fable",
      );
      expect(resolved.plannerModel).toBe("opus");
      expect(resolved.coderModel).toBe("fable");
    });

    it("lets a repo override beat both the global and defaultModel", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { plannerModel: "haiku" },
        global({ plannerModel: "opus" }),
        "fable",
      );
      expect(resolved.plannerModel).toBe("haiku");
    });

    it.each([[undefined], [""], ["   "]] as const)(
      "floors an omitted/empty/whitespace defaultModel (%p) to sonnet",
      (dm) => {
        const resolved = resolveRepoOrchestratorSettings(undefined, global(), dm);
        expect(resolved.plannerModel).toBe("sonnet");
        expect(resolved.coderModel).toBe("sonnet");
        expect(resolved.reviewerModel).toBe("sonnet");
      },
    );
  });

  // #240: the per-role runtimes ride the same ladder as the models, except the
  // floor is the DEFAULT_AGENT_RUNTIME constant — there is no settings.json field
  // behind it, so resolveRepoOrchestratorSettings keeps its three-arg signature.
  describe("role runtime inheritance (#240)", () => {
    it("floors every role to claude-cli when repo and global are absent", () => {
      const resolved = resolveRepoOrchestratorSettings(undefined, global());
      expect(resolved.plannerRuntime).toBe(DEFAULT_AGENT_RUNTIME);
      expect(resolved.coderRuntime).toBe("claude-cli");
      expect(resolved.reviewerRuntime).toBe("claude-cli");
    });

    it("lets a global override beat the floor", () => {
      const resolved = resolveRepoOrchestratorSettings(
        undefined,
        global({ coderRuntime: "codex-cli" }),
      );
      expect(resolved.coderRuntime).toBe("codex-cli");
      expect(resolved.plannerRuntime).toBe("claude-cli");
      expect(resolved.reviewerRuntime).toBe("claude-cli");
    });

    it("lets a repo override beat both the global and the floor", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { coderRuntime: "claude-cli" },
        global({ coderRuntime: "codex-cli" }),
      );
      expect(resolved.coderRuntime).toBe("claude-cli");
    });

    // The point of per-role selection: a codex coder must not drag the planner
    // and reviewer along with it.
    it("resolves each role independently", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { reviewerRuntime: "codex-cli" },
        global({ plannerRuntime: "codex-cli" }),
      );
      expect(resolved.plannerRuntime).toBe("codex-cli");
      expect(resolved.coderRuntime).toBe("claude-cli");
      expect(resolved.reviewerRuntime).toBe("codex-cli");
    });

    // #242: the ladder is runtime-agnostic — a third id rides it unchanged, with
    // a repo-level copilot coder still beating a global codex one.
    it("carries copilot-cli up the same ladder", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { coderRuntime: "copilot-cli" },
        global({ coderRuntime: "codex-cli", reviewerRuntime: "copilot-cli" }),
      );
      expect(resolved.coderRuntime).toBe("copilot-cli");
      expect(resolved.reviewerRuntime).toBe("copilot-cli");
      expect(resolved.plannerRuntime).toBe("claude-cli");
    });

    // The runtime keys are deliberately absent from the defaults bag (the model
    // precedent): an absent key is what "inherit" is spelled as.
    it("keeps the runtime keys out of DEFAULT_ORCHESTRATOR_SETTINGS", () => {
      expect("plannerRuntime" in DEFAULT_ORCHESTRATOR_SETTINGS).toBe(false);
      expect("coderRuntime" in DEFAULT_ORCHESTRATOR_SETTINGS).toBe(false);
      expect("reviewerRuntime" in DEFAULT_ORCHESTRATOR_SETTINGS).toBe(false);
    });
  });
});
