import { describe, it, expect } from "vitest";
import { resolveGate, DEFAULT_CONFIDENCE_THRESHOLDS } from "../src/confidence";

describe("resolveGate", () => {
  const t = DEFAULT_CONFIDENCE_THRESHOLDS;

  it("skips the plan gate at or above high", () => {
    expect(resolveGate(0.85, t)).toBe("queued");
    expect(resolveGate(1, t)).toBe("queued");
  });

  it("stops at the plan gate between low and high", () => {
    expect(resolveGate(0.849, t)).toBe("plan-gate");
    expect(resolveGate(0.4, t)).toBe("plan-gate");
  });

  it("asks for input below low", () => {
    expect(resolveGate(0.399, t)).toBe("needs-input");
    expect(resolveGate(0, t)).toBe("needs-input");
  });

  it("respects custom thresholds", () => {
    expect(resolveGate(0.5, { high: 0.5, low: 0.1 })).toBe("queued");
    expect(resolveGate(0.05, { high: 0.5, low: 0.1 })).toBe("needs-input");
  });
});
