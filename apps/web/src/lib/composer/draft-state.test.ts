import { describe, it, expect } from "vitest";
import type { ComposerDraft } from "@skipper/shared";
import {
  EMPTY_DRAFT_STATE,
  draftReducer,
  hasManualEdits,
  needsRegenWarning,
  type DraftState,
} from "./draft-state";

const DRAFT: ComposerDraft = {
  issues: [
    { title: "one", body: "b1", acceptanceCriteria: ["a"], labels: ["web"] },
    { title: "two", body: "b2", acceptanceCriteria: [], labels: [] },
  ],
  relations: [{ from: 1, to: 0, kind: "blocks" }],
};

const generated = (): DraftState => draftReducer(EMPTY_DRAFT_STATE, { type: "draftGenerated", draft: DRAFT });

describe("draftReducer", () => {
  it("adopts a generated draft with no flags", () => {
    const state = generated();
    expect(state.draft).toEqual(DRAFT);
    expect(state.editedFlags).toEqual({});
    expect(hasManualEdits(state)).toBe(false);
  });

  it("applies a field edit and flags it", () => {
    const state = draftReducer(generated(), {
      type: "fieldEdited",
      index: 0,
      field: "title",
      value: "my title",
    });
    expect(state.draft?.issues[0].title).toBe("my title");
    expect(state.draft?.issues[1].title).toBe("two");
    expect(state.editedFlags).toEqual({ 0: ["title"] });
  });

  it("accumulates flags per field without duplicating", () => {
    let state = generated();
    state = draftReducer(state, { type: "fieldEdited", index: 0, field: "title", value: "x" });
    state = draftReducer(state, { type: "fieldEdited", index: 0, field: "title", value: "y" });
    state = draftReducer(state, { type: "fieldEdited", index: 0, field: "labels", value: ["core"] });
    state = draftReducer(state, { type: "fieldEdited", index: 1, field: "body", value: "z" });
    expect(state.editedFlags).toEqual({ 0: ["title", "labels"], 1: ["body"] });
    expect(state.draft?.issues[0].title).toBe("y");
    expect(state.draft?.issues[0].labels).toEqual(["core"]);
    expect(state.draft?.issues[1].body).toBe("z");
  });

  it("edits acceptance criteria as a list", () => {
    const state = draftReducer(generated(), {
      type: "fieldEdited",
      index: 0,
      field: "acceptanceCriteria",
      value: ["a", "b"],
    });
    expect(state.draft?.issues[0].acceptanceCriteria).toEqual(["a", "b"]);
  });

  it("ignores an edit before any draft exists", () => {
    const state = draftReducer(EMPTY_DRAFT_STATE, {
      type: "fieldEdited",
      index: 0,
      field: "title",
      value: "x",
    });
    expect(state).toBe(EMPTY_DRAFT_STATE);
  });

  // The flags exist to mark what the agent must preserve; once it has
  // regenerated, every field is its own again.
  it("clears the flags on a regeneration", () => {
    const edited = draftReducer(generated(), {
      type: "fieldEdited",
      index: 0,
      field: "title",
      value: "mine",
    });
    expect(needsRegenWarning(edited)).toBe(true);
    const regenerated = draftReducer(edited, { type: "draftGenerated", draft: DRAFT });
    expect(regenerated.editedFlags).toEqual({});
    expect(needsRegenWarning(regenerated)).toBe(false);
  });

  it("never warns without a draft", () => {
    expect(needsRegenWarning(EMPTY_DRAFT_STATE)).toBe(false);
  });

  // Resuming a saved draft (#138) restores the flags with it: they record what
  // the user hand-wrote, so a later regeneration still has to warn.
  describe("hydrated", () => {
    it("restores the draft together with its flags", () => {
      const state = draftReducer(EMPTY_DRAFT_STATE, {
        type: "hydrated",
        draft: DRAFT,
        editedFlags: { 0: ["title", "body"] },
      });
      expect(state.draft).toEqual(DRAFT);
      expect(state.editedFlags).toEqual({ 0: ["title", "body"] });
      expect(hasManualEdits(state)).toBe(true);
      expect(needsRegenWarning(state)).toBe(true);
    });

    it("hydrates a never-edited draft without inventing flags", () => {
      const state = draftReducer(EMPTY_DRAFT_STATE, {
        type: "hydrated",
        draft: DRAFT,
        editedFlags: {},
      });
      expect(hasManualEdits(state)).toBe(false);
      expect(needsRegenWarning(state)).toBe(false);
    });

    it("replaces whatever the reducer held before", () => {
      const edited = draftReducer(generated(), {
        type: "fieldEdited",
        index: 1,
        field: "labels",
        value: ["core"],
      });
      const state = draftReducer(edited, {
        type: "hydrated",
        draft: { issues: [], relations: [] },
        editedFlags: {},
      });
      expect(state.draft).toEqual({ issues: [], relations: [] });
      expect(state.editedFlags).toEqual({});
    });

    it("keeps a later edit flagging on top of the hydrated flags", () => {
      const hydrated = draftReducer(EMPTY_DRAFT_STATE, {
        type: "hydrated",
        draft: DRAFT,
        editedFlags: { 0: ["title"] },
      });
      const state = draftReducer(hydrated, {
        type: "fieldEdited",
        index: 1,
        field: "body",
        value: "mine",
      });
      expect(state.editedFlags).toEqual({ 0: ["title"], 1: ["body"] });
      expect(state.draft?.issues[1].body).toBe("mine");
    });
  });
});
