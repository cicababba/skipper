import { describe, expect, it } from "vitest";
import {
  CLI_DEFAULT,
  claudeModelMirror,
  isListedModel,
  modelOptionsFor,
  resetModel,
} from "./model-options";

describe("modelOptionsFor", () => {
  it("offers the four Claude aliases for claude-cli", () => {
    expect(modelOptionsFor("claude-cli").map((o) => o.value)).toEqual([
      "opus",
      "sonnet",
      "haiku",
      "fable",
    ]);
  });

  // No curated per-vendor lists to maintain: the other CLIs run whatever their own
  // config says, so the only listed option is that default.
  it.each(["codex-cli", "copilot-cli", "gemini-cli"] as const)(
    "offers only the CLI default for %s",
    (runtime) => {
      expect(modelOptionsFor(runtime)).toEqual([
        { value: CLI_DEFAULT, labelKey: "modelCliDefault" },
      ]);
    },
  );

  it("never offers a Claude alias to a non-claude runtime", () => {
    expect(modelOptionsFor("gemini-cli").map((o) => o.value)).not.toContain("opus");
  });
});

describe("isListedModel", () => {
  it("recognizes a Claude alias only under claude-cli", () => {
    expect(isListedModel("claude-cli", "opus")).toBe(true);
    expect(isListedModel("gemini-cli", "opus")).toBe(false);
  });

  it("treats the empty model as listed for non-claude runtimes only", () => {
    expect(isListedModel("codex-cli", CLI_DEFAULT)).toBe(true);
    expect(isListedModel("claude-cli", CLI_DEFAULT)).toBe(false);
  });

  it("treats a full model id as unlisted (it belongs in Custom…)", () => {
    expect(isListedModel("claude-cli", "claude-opus-4-8")).toBe(false);
    expect(isListedModel("codex-cli", "gpt-5-codex")).toBe(false);
  });
});

describe("resetModel", () => {
  // A runtime switch drops the model whatever the new runtime is — the pair
  // always lands on that CLI's own default.
  it("drops the model on a runtime switch", () => {
    expect(resetModel()).toBeUndefined();
  });
});

describe("claudeModelMirror", () => {
  it("mirrors an explicit Claude model", () => {
    expect(claudeModelMirror({ runtime: "claude-cli", model: "opus" })).toBe("opus");
  });

  it("mirrors nothing when the claude pair has no model of its own", () => {
    expect(claudeModelMirror({ runtime: "claude-cli", model: undefined })).toBeUndefined();
    expect(claudeModelMirror({ runtime: "claude-cli", model: CLI_DEFAULT })).toBeUndefined();
  });

  // llm.claudeModel is the floor for claude pairs only — another vendor's model
  // must never land there.
  it("mirrors nothing for a non-claude runtime", () => {
    expect(claudeModelMirror({ runtime: "codex-cli", model: "gpt-5-codex" })).toBeUndefined();
  });
});
