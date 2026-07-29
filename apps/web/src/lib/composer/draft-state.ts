// Composer draft state (#136). The draft is desktop-owned, but the renderer
// holds the live copy while the user types and pushes it back with the flags.
// Preservation across a regeneration is prompt-level (the driver renders the
// flags as "preserve verbatim" markers), so all this layer owes it is an honest
// record of which fields the user touched.

import type { ComposerDraft, ComposerEditedFlags } from "@skipper/shared";

export interface DraftState {
  draft: ComposerDraft | null;
  editedFlags: ComposerEditedFlags;
}

export const EMPTY_DRAFT_STATE: DraftState = { draft: null, editedFlags: {} };

export type DraftEdit =
  | { field: "title"; value: string }
  | { field: "body"; value: string }
  | { field: "acceptanceCriteria"; value: string[] }
  | { field: "labels"; value: string[] };

export type DraftAction =
  | { type: "draftGenerated"; draft: ComposerDraft }
  | ({ type: "fieldEdited"; index: number } & DraftEdit);

function withFlag(flags: ComposerEditedFlags, index: number, field: string): ComposerEditedFlags {
  const current = flags[index] ?? [];
  if (current.includes(field)) return flags;
  return { ...flags, [index]: [...current, field] };
}

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case "draftGenerated":
      // A regeneration replaces the draft wholesale and the fields are the
      // agent's again — the flags that guarded them have done their job.
      return { draft: action.draft, editedFlags: {} };
    case "fieldEdited": {
      if (!state.draft) return state;
      const issues = state.draft.issues.map((issue, i) =>
        i === action.index ? { ...issue, [action.field]: action.value } : issue,
      );
      return {
        draft: { ...state.draft, issues },
        editedFlags: withFlag(state.editedFlags, action.index, action.field),
      };
    }
  }
}

export function hasManualEdits(state: DraftState): boolean {
  return Object.values(state.editedFlags).some((fields) => fields.length > 0);
}

/** Regenerating over hand-written fields is lossy enough to confirm first. */
export function needsRegenWarning(state: DraftState): boolean {
  return state.draft !== null && hasManualEdits(state);
}
