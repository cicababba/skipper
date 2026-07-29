// Relation display strings (#136). Read-only by design: relations describe the
// draft's own shape, and cross-posting them into the created bodies is #131.

import type { ComposerRelation } from "@skipper/shared";

export interface RelationLabels {
  blocks: (from: number, to: number) => string;
  partOf: (from: number, to: number) => string;
  relatesTo: (from: number, to: number) => string;
}

/** One relation as display text, with 1-based issue numbers. */
export function relationText(relation: ComposerRelation, labels: RelationLabels): string {
  const from = relation.from + 1;
  const to = relation.to + 1;
  switch (relation.kind) {
    case "blocks":
      return labels.blocks(from, to);
    case "part-of":
      return labels.partOf(from, to);
    case "relates-to":
      return labels.relatesTo(from, to);
  }
}

/** The relations touching one issue, as display text (either direction). */
export function relationsForIssue(
  relations: ComposerRelation[],
  index: number,
  labels: RelationLabels,
): string[] {
  return relations
    .filter((r) => r.from === index || r.to === index)
    .map((r) => relationText(r, labels));
}
