import { describe, expect, it } from "vitest";
import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT, clampAutosizeHeight } from "./chat-autosize";

describe("clampAutosizeHeight", () => {
  it("grows with the content between the bounds", () => {
    expect(clampAutosizeHeight(90)).toBe(90);
  });

  it("clamps a jsdom-style zero scrollHeight to the minimum", () => {
    expect(clampAutosizeHeight(0)).toBe(COMPOSER_MIN_HEIGHT);
  });

  it("caps long content at the maximum so the textarea scrolls instead", () => {
    expect(clampAutosizeHeight(900)).toBe(COMPOSER_MAX_HEIGHT);
  });

  it("falls back to the minimum for a non-finite measurement", () => {
    expect(clampAutosizeHeight(Number.NaN)).toBe(COMPOSER_MIN_HEIGHT);
  });
});
