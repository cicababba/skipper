import type { ConfidenceThresholds } from "@nestbrain/shared";

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = { high: 0.85, low: 0.4 };

export type GateTarget = "queued" | "plan-gate" | "needs-input";

export function resolveGate(composite: number, t: ConfidenceThresholds): GateTarget {
  if (composite >= t.high) return "queued";
  if (composite < t.low) return "needs-input";
  return "plan-gate";
}
