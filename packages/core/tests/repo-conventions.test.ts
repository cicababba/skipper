import { describe, it, expect } from "vitest";
import {
  REPO_CONVENTIONS_CHAR_BUDGET,
  renderRepoConventions,
  withRepoConventions,
  CODER_SYSTEM_PROMPT,
} from "../src";
import { PLANNER_SYSTEM_PROMPT } from "../src/planner";

const CONTENT = "Use pnpm. Run `pnpm test`. TypeScript everywhere, no default exports.";

describe("renderRepoConventions", () => {
  it("renders a labeled section for present content", () => {
    const section = renderRepoConventions(CONTENT);
    expect(section).toBe(`## Repository conventions\n${CONTENT}`);
  });

  it("returns undefined for undefined / empty / whitespace-only content", () => {
    expect(renderRepoConventions(undefined)).toBeUndefined();
    expect(renderRepoConventions("")).toBeUndefined();
    expect(renderRepoConventions("   \n\t  ")).toBeUndefined();
  });

  it("truncates oversized content with a marker", () => {
    const oversized = "x".repeat(REPO_CONVENTIONS_CHAR_BUDGET + 5000);
    const section = renderRepoConventions(oversized)!;
    expect(section).toContain(
      `[repository conventions truncated — showing first ${REPO_CONVENTIONS_CHAR_BUDGET} of ${oversized.length} characters]`,
    );
    // The tail past the budget must not survive.
    expect(section.length).toBeLessThan(oversized.length);
  });
});

describe("withRepoConventions", () => {
  for (const [label, base] of [
    ["planner", PLANNER_SYSTEM_PROMPT],
    ["coder", CODER_SYSTEM_PROMPT],
  ] as const) {
    describe(`against the ${label} system prompt`, () => {
      it("appends the conventions section when content is present", () => {
        const composed = withRepoConventions(base, CONTENT);
        expect(composed.startsWith(base)).toBe(true);
        expect(composed).toContain("## Repository conventions");
        expect(composed).toContain(CONTENT);
      });

      it("returns the base unchanged for undefined / empty / whitespace content", () => {
        expect(withRepoConventions(base, undefined)).toBe(base);
        expect(withRepoConventions(base, "")).toBe(base);
        expect(withRepoConventions(base, "  \n ")).toBe(base);
      });

      it("truncates oversized content with a marker", () => {
        const oversized = "y".repeat(REPO_CONVENTIONS_CHAR_BUDGET + 5000);
        const composed = withRepoConventions(base, oversized);
        expect(composed).toContain("[repository conventions truncated");
        expect(composed).not.toContain("y".repeat(REPO_CONVENTIONS_CHAR_BUDGET + 1));
      });
    });
  }
});
