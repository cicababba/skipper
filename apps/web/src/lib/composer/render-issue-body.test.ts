import { describe, it, expect } from "vitest";
import { renderDraftBody } from "./render-issue-body";

const issue = (over: Partial<Parameters<typeof renderDraftBody>[0]> = {}) => ({
  title: "t",
  body: "the body",
  acceptanceCriteria: [] as string[],
  labels: [] as string[],
  ...over,
});

describe("renderDraftBody", () => {
  it("returns the body alone when there are no criteria", () => {
    expect(renderDraftBody(issue())).toBe("the body");
  });

  it("folds the criteria in as a checklist", () => {
    expect(renderDraftBody(issue({ acceptanceCriteria: ["works", "is tested"] }))).toBe(
      "the body\n\n## Acceptance criteria\n\n- [ ] works\n- [ ] is tested",
    );
  });

  it("emits only the section when the body is empty", () => {
    expect(renderDraftBody(issue({ body: "  ", acceptanceCriteria: ["works"] }))).toBe(
      "## Acceptance criteria\n\n- [ ] works",
    );
  });

  it("drops blank criteria", () => {
    expect(renderDraftBody(issue({ acceptanceCriteria: ["  ", "works"] }))).toBe(
      "the body\n\n## Acceptance criteria\n\n- [ ] works",
    );
    expect(renderDraftBody(issue({ acceptanceCriteria: ["  "] }))).toBe("the body");
  });
});
