import { describe, it, expect } from "vitest";
import type { GateMode } from "@skipper/shared";
import { resolveGate, DEFAULT_CONFIDENCE_THRESHOLDS } from "../src/confidence";

const MODES: GateMode[] = ["on", "off", "auto"];

describe("resolveGate", () => {
  const t = DEFAULT_CONFIDENCE_THRESHOLDS;

  describe("the calibrated defaults", () => {
    it("keeps high and low where run-20260805-091352 separated the labels", () => {
      expect(t.high).toBe(0.74);
      expect(t.low).toBe(0.49);
    });

    it("puts every corpus label on the side its human label asks for", () => {
      const approveUnread = [0.821, 0.795];
      const wantsToRead = [0.686, 0.646, 0.608, 0.603, 0.545, 0.542, 0.538, 0.518];
      const notPlannable = [0.457, 0.377];
      for (const c of approveUnread) expect(resolveGate(c, t, "auto")).toBe("queued");
      for (const c of wantsToRead) expect(resolveGate(c, t, "auto")).toBe("plan-gate");
      for (const c of notPlannable) expect(resolveGate(c, t, "auto")).toBe("needs-input");
    });
  });

  describe("auto — the score decides", () => {
    it("skips the plan gate at or above high", () => {
      expect(resolveGate(t.high, t, "auto")).toBe("queued");
      expect(resolveGate(1, t, "auto")).toBe("queued");
    });

    it("stops at the plan gate between low and high", () => {
      expect(resolveGate(t.high - 0.001, t, "auto")).toBe("plan-gate");
      expect(resolveGate(t.low, t, "auto")).toBe("plan-gate");
    });

    it("asks for input below low", () => {
      expect(resolveGate(t.low - 0.001, t, "auto")).toBe("needs-input");
      expect(resolveGate(0, t, "auto")).toBe("needs-input");
    });

    it("respects custom thresholds", () => {
      expect(resolveGate(0.5, { high: 0.5, low: 0.1 }, "auto")).toBe("queued");
      expect(resolveGate(0.05, { high: 0.5, low: 0.1 }, "auto")).toBe("needs-input");
    });
  });

  // The #62 invariant. needs-input means the plan is broken or ambiguous, not
  // "needs approval" — no autoCoding mode may send a 0.1-scoring plan to the coder.
  describe("the low floor is unconditional", () => {
    it.each(MODES)("routes below-low to needs-input in %s mode", (mode) => {
      expect(resolveGate(t.low - 0.001, t, mode)).toBe("needs-input");
      expect(resolveGate(0, t, mode)).toBe("needs-input");
    });
  });

  describe("on / off only choose between queued and plan-gate", () => {
    it("on queues regardless of the score, above the floor", () => {
      expect(resolveGate(t.low, t, "on")).toBe("queued");
      expect(resolveGate(0.5, t, "on")).toBe("queued");
      expect(resolveGate(1, t, "on")).toBe("queued");
    });

    it("off plan-gates regardless of the score, above the floor", () => {
      expect(resolveGate(t.low, t, "off")).toBe("plan-gate");
      expect(resolveGate(0.99, t, "off")).toBe("plan-gate");
      expect(resolveGate(1, t, "off")).toBe("plan-gate");
    });

    it("treats exactly low as above the floor", () => {
      expect(resolveGate(t.low, t, "on")).toBe("queued");
      expect(resolveGate(t.low, t, "off")).toBe("plan-gate");
    });
  });
});
