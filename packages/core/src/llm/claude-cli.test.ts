import { describe, expect, it } from "vitest";
import { cliErrorMessage } from "./claude-cli";

describe("cliErrorMessage", () => {
  it("prefers a non-empty result string", () => {
    expect(cliErrorMessage({ result: "boom", subtype: "error_max_turns" })).toBe(
      "Claude CLI error: boom",
    );
  });

  it("reports max-turns with the turn count", () => {
    expect(cliErrorMessage({ subtype: "error_max_turns", num_turns: 25 })).toBe(
      "Claude CLI error: agent hit the max-turns limit after 25 turns",
    );
  });

  it("reports max-turns without a turn count", () => {
    expect(cliErrorMessage({ subtype: "error_max_turns" })).toBe(
      "Claude CLI error: agent hit the max-turns limit",
    );
  });

  it("falls back to an unknown subtype", () => {
    expect(cliErrorMessage({ subtype: "error_during_execution" })).toBe(
      "Claude CLI error: error_during_execution",
    );
  });

  it("falls back to unknown failure with neither result nor subtype", () => {
    expect(cliErrorMessage({})).toBe("Claude CLI error: unknown failure");
  });
});
