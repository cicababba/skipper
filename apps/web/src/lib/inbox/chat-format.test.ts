import { describe, expect, it } from "vitest";
import { hhmm, isStuck } from "./chat-format";

describe("hhmm", () => {
  it("renders a two-digit hour and minute", () => {
    expect(hhmm("2026-07-21T09:05:00.000Z")).toMatch(/\d{2}:\d{2}/);
  });
});

describe("isStuck", () => {
  it("is stuck at the exact bottom", () => {
    expect(isStuck(400, 100, 500)).toBe(true);
  });

  it("stays stuck within the threshold", () => {
    expect(isStuck(380, 100, 500)).toBe(true);
  });

  it("comes unstuck past the threshold", () => {
    expect(isStuck(300, 100, 500)).toBe(false);
  });

  it("honours an explicit threshold", () => {
    expect(isStuck(300, 100, 500, 200)).toBe(true);
  });
});
