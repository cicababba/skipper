import { describe, it, expect } from "vitest";
import type { ComposerRelation } from "@skipper/shared";
import { relationText, relationsForIssue, type RelationLabels } from "./relations-text";

const labels: RelationLabels = {
  blocks: (f, t) => `${f} blocks ${t}`,
  partOf: (f, t) => `${f} is part of ${t}`,
  relatesTo: (f, t) => `${f} relates to ${t}`,
};

const relations: ComposerRelation[] = [
  { from: 1, to: 0, kind: "blocks" },
  { from: 2, to: 0, kind: "part-of" },
  { from: 2, to: 1, kind: "relates-to" },
];

describe("relationText", () => {
  it("renders each kind with 1-based issue numbers", () => {
    expect(relationText(relations[0], labels)).toBe("2 blocks 1");
    expect(relationText(relations[1], labels)).toBe("3 is part of 1");
    expect(relationText(relations[2], labels)).toBe("3 relates to 2");
  });
});

describe("relationsForIssue", () => {
  it("collects the relations touching an issue in either direction", () => {
    expect(relationsForIssue(relations, 0, labels)).toEqual(["2 blocks 1", "3 is part of 1"]);
    expect(relationsForIssue(relations, 2, labels)).toEqual(["3 is part of 1", "3 relates to 2"]);
  });

  it("returns nothing for an unrelated issue", () => {
    expect(relationsForIssue(relations, 5, labels)).toEqual([]);
  });
});
