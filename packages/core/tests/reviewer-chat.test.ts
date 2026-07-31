import { describe, it, expect } from "vitest";
import { REVIEWER_CHAT_SYSTEM_PROMPT } from "../src/reviewer";

// Runtime-neutral wording (#280): the prompt is shared by every runtime, so it
// may name no CLI's tools, while keeping the read-only shell it already had.
describe("REVIEWER_CHAT_SYSTEM_PROMPT wording", () => {
  it("names no claude tool", () => {
    expect(REVIEWER_CHAT_SYSTEM_PROMPT).not.toMatch(/\bRead\b|\bGrep\b|\bGlob\b|\bBash\b/);
  });

  it("keeps the read-only shell affordance and the prohibitions", () => {
    expect(REVIEWER_CHAT_SYSTEM_PROMPT).toContain("run read-only shell commands");
    expect(REVIEWER_CHAT_SYSTEM_PROMPT).toContain(
      "must NOT modify any files, including via your shell",
    );
    expect(REVIEWER_CHAT_SYSTEM_PROMPT).toContain(
      "never touch anything outside your working directory",
    );
  });

  it("keeps the outcome immutable from the chat", () => {
    expect(REVIEWER_CHAT_SYSTEM_PROMPT).toContain("You cannot change the review outcome from here");
  });
});
