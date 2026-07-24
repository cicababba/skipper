import type { ConfidenceThresholds, GateMode } from "@skipper/shared";

export { DEFAULT_CONFIDENCE_THRESHOLDS } from "@skipper/shared";

export type GateTarget = "queued" | "plan-gate" | "needs-input";

/**
 * The plan gate (#8), made explicit by autoCoding (#62).
 *
 * The low floor is unconditional: composite < low means the plan is broken or
 * ambiguous, and no autoCoding mode may override that — "needs-input" does not
 * mean "needs approval". on/off only choose between queued and plan-gate.
 */
export function resolveGate(
  composite: number,
  t: ConfidenceThresholds,
  mode: GateMode,
): GateTarget {
  if (composite < t.low) return "needs-input";
  if (mode === "on") return "queued";
  if (mode === "off") return "plan-gate";
  return composite >= t.high ? "queued" : "plan-gate";
}
