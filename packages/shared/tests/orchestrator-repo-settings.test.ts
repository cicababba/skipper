import { describe, it, expect } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  isSettledState,
  resolveDefaultAgentPair,
  resolveRepoIntakeSettings,
  resolveRepoOrchestratorSettings,
  SETTLED_STATES,
  TRANSITIONS,
  type LifecycleState,
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

// Following is an explicit, persisted set: an absent record is NOT followed, so
// a repo the poller merely happened to see never enters the inbox or the sidebar.
describe("resolveRepoIntakeSettings — followed", () => {
  it("does not follow a repo with no settings record", () => {
    expect(resolveRepoIntakeSettings(undefined).followed).toBe(false);
    expect(resolveRepoIntakeSettings({}).followed).toBe(false);
  });

  it("does not follow a repo whose record has other keys but no followed flag", () => {
    expect(resolveRepoIntakeSettings({ priority: "high" }).followed).toBe(false);
  });

  it("follows only on an explicit true", () => {
    expect(resolveRepoIntakeSettings({ followed: true }).followed).toBe(true);
    expect(resolveRepoIntakeSettings({ followed: false }).followed).toBe(false);
  });

  it("carries the same default through resolveRepoOrchestratorSettings", () => {
    expect(resolveRepoOrchestratorSettings(undefined, global()).followed).toBe(false);
    expect(resolveRepoOrchestratorSettings({ followed: true }, global()).followed).toBe(true);
  });
});

describe("isSettledState", () => {
  const ALL_STATES = Object.keys(TRANSITIONS) as LifecycleState[];

  it("covers all 15 lifecycle states, settling only merged and closed", () => {
    expect(ALL_STATES).toHaveLength(15);
    const settled = ALL_STATES.filter(isSettledState);
    expect(settled.sort()).toEqual(["closed", "merged"]);
  });

  it("agrees with SETTLED_STATES", () => {
    for (const state of ALL_STATES) {
      expect(isSettledState(state)).toBe(SETTLED_STATES.includes(state));
    }
  });

  // Every state that waits on a human holds live work — which is what makes a
  // repo with a pending gate un-unfollowable.
  it.each(["plan-gate", "human-review", "needs-input", "blocked", "failed"] as const)(
    "treats %s as unsettled",
    (state) => {
      expect(isSettledState(state)).toBe(false);
    },
  );
});

describe("resolveRepoOrchestratorSettings", () => {
  it("inherits every global-overridable field when the repo has no overrides", () => {
    const g = global({
      codingWipPerRepo: 4,
      autoCoding: "off",
      review: "on",
      reviewMaxRounds: 5,
      plannerAgent: { runtime: "claude-cli", model: "opus" },
      coderAgent: { runtime: "claude-cli", model: "sonnet" },
      reviewerAgent: { runtime: "claude-cli", model: "haiku" },
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
  it("overrides one role's pair while the others inherit", () => {
    const resolved = resolve(
      { coderAgent: { runtime: "claude-cli", model: "haiku" } },
      {
        plannerAgent: { runtime: "claude-cli", model: "opus" },
        coderAgent: { runtime: "claude-cli", model: "sonnet" },
        reviewerAgent: { runtime: "claude-cli", model: "sonnet" },
      },
    );
    expect(resolved.coderModel).toBe("haiku");
    expect(resolved.plannerModel).toBe("opus");
    expect(resolved.reviewerModel).toBe("sonnet");
  });

  // #58: model strings are opaque CLI aliases — a hand-edited full id resolves as-is.
  it("treats a model string as opaque", () => {
    expect(
      resolve({ plannerAgent: { runtime: "claude-cli", model: "claude-opus-4-8" } }).plannerModel,
    ).toBe("claude-opus-4-8");
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

  // The (runtime, model) pair is the unit of configuration: it resolves whole, on
  // one ladder — repo pair → global role pair → defaultAgent → the claude-cli floor
  // on llm.claudeModel. A pair never mixes with another level's half.
  describe("agent pair inheritance", () => {
    it("floors every role to claude-cli on defaultModel when nothing is set", () => {
      const resolved = resolveRepoOrchestratorSettings(undefined, global(), "fable");
      expect(resolved.plannerRuntime).toBe(DEFAULT_AGENT_RUNTIME);
      expect(resolved.coderRuntime).toBe("claude-cli");
      expect(resolved.reviewerRuntime).toBe("claude-cli");
      expect(resolved.plannerModel).toBe("fable");
      expect(resolved.coderModel).toBe("fable");
      expect(resolved.reviewerModel).toBe("fable");
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

    it("lets defaultAgent beat the floor for every role", () => {
      const resolved = resolveRepoOrchestratorSettings(
        undefined,
        global({ defaultAgent: { runtime: "gemini-cli" } }),
        "fable",
      );
      expect(resolved.plannerRuntime).toBe("gemini-cli");
      expect(resolved.coderRuntime).toBe("gemini-cli");
      expect(resolved.reviewerRuntime).toBe("gemini-cli");
      // Non-claude runtimes take no model flag: "" is the CLI-default sentinel, and
      // defaultModel is a Claude alias that must not leak onto them.
      expect(resolved.plannerModel).toBe("");
      expect(resolved.coderModel).toBe("");
      expect(resolved.reviewerModel).toBe("");
    });

    it("lets a global role pair beat defaultAgent", () => {
      const resolved = resolveRepoOrchestratorSettings(
        undefined,
        global({
          defaultAgent: { runtime: "gemini-cli" },
          plannerAgent: { runtime: "claude-cli", model: "opus" },
        }),
        "fable",
      );
      expect(resolved.plannerRuntime).toBe("claude-cli");
      expect(resolved.plannerModel).toBe("opus");
      expect(resolved.coderRuntime).toBe("gemini-cli");
      expect(resolved.coderModel).toBe("");
    });

    it("lets a repo pair beat both the global role pair and defaultAgent", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { plannerAgent: { runtime: "claude-cli", model: "haiku" } },
        global({
          defaultAgent: { runtime: "gemini-cli" },
          plannerAgent: { runtime: "claude-cli", model: "opus" },
        }),
        "fable",
      );
      expect(resolved.plannerRuntime).toBe("claude-cli");
      expect(resolved.plannerModel).toBe("haiku");
    });

    // The whole point of the pair: the level that wins supplies BOTH halves, so a
    // codex repo pair can never inherit the global's Claude alias.
    it("never mixes a repo pair's runtime with a global pair's model", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { coderAgent: { runtime: "codex-cli" } },
        global({ coderAgent: { runtime: "claude-cli", model: "opus" } }),
        "fable",
      );
      expect(resolved.coderRuntime).toBe("codex-cli");
      expect(resolved.coderModel).toBe("");
    });

    it("falls a claude pair with no model of its own back to defaultModel", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { coderAgent: { runtime: "claude-cli" } },
        global({ coderAgent: { runtime: "claude-cli", model: "opus" } }),
        "fable",
      );
      expect(resolved.coderModel).toBe("fable");
    });

    // The point of per-role selection: a codex coder must not drag the planner
    // and reviewer along with it.
    it("resolves each role independently", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { reviewerAgent: { runtime: "codex-cli" } },
        global({ plannerAgent: { runtime: "codex-cli" } }),
      );
      expect(resolved.plannerRuntime).toBe("codex-cli");
      expect(resolved.coderRuntime).toBe("claude-cli");
      expect(resolved.reviewerRuntime).toBe("codex-cli");
    });

    // The ladder never enumerates the union, so every runtime rides it unchanged.
    it.each(["claude-cli", "codex-cli", "copilot-cli", "gemini-cli"] as const)(
      "carries %s up the same ladder",
      (runtime) => {
        const resolved = resolveRepoOrchestratorSettings(
          { coderAgent: { runtime } },
          global({ coderAgent: { runtime: "copilot-cli" } }),
        );
        expect(resolved.coderRuntime).toBe(runtime);
      },
    );

    // A non-claude CLI can still be pinned to a model of its own — the string is
    // opaque, and it must survive resolution untouched.
    it("carries a non-claude pair's own model through", () => {
      const resolved = resolveRepoOrchestratorSettings(
        undefined,
        global({ coderAgent: { runtime: "codex-cli", model: "gpt-5-codex" } }),
        "fable",
      );
      expect(resolved.coderRuntime).toBe("codex-cli");
      expect(resolved.coderModel).toBe("gpt-5-codex");
    });

    // The pair keys are deliberately absent from the defaults bag: an absent key
    // is what "inherit" is spelled as.
    it("keeps the pair keys out of DEFAULT_ORCHESTRATOR_SETTINGS", () => {
      expect("defaultAgent" in DEFAULT_ORCHESTRATOR_SETTINGS).toBe(false);
      expect("plannerAgent" in DEFAULT_ORCHESTRATOR_SETTINGS).toBe(false);
      expect("coderAgent" in DEFAULT_ORCHESTRATOR_SETTINGS).toBe(false);
      expect("reviewerAgent" in DEFAULT_ORCHESTRATOR_SETTINGS).toBe(false);
      expect("composerAgent" in DEFAULT_ORCHESTRATOR_SETTINGS).toBe(false);
    });
  });

  // #136: the composer rides the same ladder as the three older roles.
  describe("composer pair (#136)", () => {
    it("floors to claude-cli on defaultModel when nothing is set", () => {
      const resolved = resolveRepoOrchestratorSettings(undefined, global(), "fable");
      expect(resolved.composerRuntime).toBe(DEFAULT_AGENT_RUNTIME);
      expect(resolved.composerModel).toBe("fable");
    });

    it("takes the global composerAgent over defaultAgent", () => {
      const resolved = resolveRepoOrchestratorSettings(
        undefined,
        global({
          defaultAgent: { runtime: "gemini-cli" },
          composerAgent: { runtime: "claude-cli", model: "opus" },
        }),
        "fable",
      );
      expect(resolved.composerRuntime).toBe("claude-cli");
      expect(resolved.composerModel).toBe("opus");
    });

    it("lets a repo composerAgent beat the global one", () => {
      const resolved = resolveRepoOrchestratorSettings(
        { composerAgent: { runtime: "codex-cli" } },
        global({ composerAgent: { runtime: "claude-cli", model: "opus" } }),
        "fable",
      );
      expect(resolved.composerRuntime).toBe("codex-cli");
      expect(resolved.composerModel).toBe("");
    });

    it("resolves independently of the other roles", () => {
      const resolved = resolveRepoOrchestratorSettings(
        undefined,
        global({ composerAgent: { runtime: "copilot-cli" } }),
        "fable",
      );
      expect(resolved.composerRuntime).toBe("copilot-cli");
      expect(resolved.plannerRuntime).toBe("claude-cli");
      expect(resolved.coderRuntime).toBe("claude-cli");
      expect(resolved.reviewerRuntime).toBe("claude-cli");
    });
  });
});

// #256's distiller has no role of its own: it rides the global default pair, so
// its ladder is a role's with the two role-specific rungs removed.
describe("resolveDefaultAgentPair", () => {
  it("floors to claude-cli on defaultModel when no defaultAgent is set", () => {
    expect(resolveDefaultAgentPair(global(), "fable")).toEqual({
      runtime: "claude-cli",
      model: "fable",
    });
  });

  it.each([[undefined], [""], ["   "]] as const)(
    "floors an omitted/empty/whitespace defaultModel (%p) to sonnet",
    (dm) => {
      expect(resolveDefaultAgentPair(global(), dm).model).toBe("sonnet");
    },
  );

  it("honours a claude defaultAgent's own model", () => {
    expect(
      resolveDefaultAgentPair(global({ defaultAgent: { runtime: "claude-cli", model: "opus" } }), "fable"),
    ).toEqual({ runtime: "claude-cli", model: "opus" });
  });

  it("falls a claude defaultAgent with no model back to defaultModel", () => {
    expect(
      resolveDefaultAgentPair(global({ defaultAgent: { runtime: "claude-cli" } }), "fable").model,
    ).toBe("fable");
  });

  // Non-claude CLIs take no model flag — "" is the "use the CLI's own default"
  // sentinel, and a Claude alias must never leak onto them.
  it("gives a non-claude defaultAgent the empty-model sentinel", () => {
    expect(resolveDefaultAgentPair(global({ defaultAgent: { runtime: "gemini-cli" } }), "fable")).toEqual(
      { runtime: "gemini-cli", model: "" },
    );
  });

  it("carries a non-claude pair's own model through", () => {
    expect(
      resolveDefaultAgentPair(global({ defaultAgent: { runtime: "codex-cli", model: "gpt-5-codex" } })),
    ).toEqual({ runtime: "codex-cli", model: "gpt-5-codex" });
  });

  // The role rungs are deliberately skipped: distillation is not the planner.
  it("ignores the per-role pairs entirely", () => {
    const pair = resolveDefaultAgentPair(
      global({
        defaultAgent: { runtime: "claude-cli", model: "haiku" },
        plannerAgent: { runtime: "codex-cli" },
        coderAgent: { runtime: "gemini-cli" },
        reviewerAgent: { runtime: "copilot-cli" },
      }),
      "fable",
    );
    expect(pair).toEqual({ runtime: "claude-cli", model: "haiku" });
  });

  it("agrees with a role's resolution when only defaultAgent is set", () => {
    const g = global({ defaultAgent: { runtime: "copilot-cli" } });
    const role = resolveRepoOrchestratorSettings(undefined, g, "fable");
    const pair = resolveDefaultAgentPair(g, "fable");
    expect(pair).toEqual({ runtime: role.plannerRuntime, model: role.plannerModel });
  });
});
