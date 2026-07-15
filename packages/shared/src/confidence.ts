// ============================================================
// Skipper — Confidence report types (issue #8; rendered by #13)
// ============================================================

export interface GroundednessSignal {
  /** 0..1 — weighted fraction of cited files + symbols found in the repo. */
  score: number;
  filesChecked: number;
  filesFound: number;
  symbolsChecked: number;
  symbolsFound: number;
  missingFiles: string[];
  missingSymbols: string[];
  /** Paths declared status:"new" by the plan — exempt from the check. */
  newFiles: string[];
}

export interface ConvergenceSignal {
  /** 0..1 — agreement across independently generated plans. */
  score: number;
  planCount: number;
  fileJaccard: number;
  sizeAgreement: number;
  stepCountAgreement: number;
  /** True when plans disagree enough that the issue is likely ambiguous. */
  divergent: boolean;
  /** Files cited by every plan. */
  sharedFiles: string[];
  /** Files cited by some plans but not all. */
  disputedFiles: string[];
}

export type CriticVerdict = "approve" | "concerns" | "reject";

export interface CriticObjection {
  kind: "missing-step" | "wrong-approach" | "risk" | "acceptance-gap" | "underspecified" | "other";
  detail: string;
  blocking: boolean;
}

export interface CriticSignal {
  /** 0..1 — derived deterministically from verdict + blocking objections. */
  score: number;
  verdict: CriticVerdict;
  objections: CriticObjection[];
}

export interface ClaritySignal {
  /** 0..1 — heuristic issue-clarity bonus. */
  score: number;
  bodyPresent: boolean;
  hasAcceptanceCriteria: boolean;
  hasReproSteps: boolean;
  openQuestionCount: number;
}

export interface ConfidenceWeights {
  groundedness: number;
  convergence: number;
  critic: number;
  clarity: number;
}

export interface ConfidenceThresholds {
  /** composite >= high → skip the plan gate (planning → queued). */
  high: number;
  /** composite < low → needs-input (issue too ambiguous to plan). */
  low: number;
}

export interface ConfidenceReport {
  version: 1;
  /** 0..1 — weighted over the signals that succeeded. */
  composite: number;
  /** Effective (renormalized) weights actually used. */
  weights: ConfidenceWeights;
  signals: {
    groundedness?: GroundednessSignal;
    convergence?: ConvergenceSignal;
    critic?: CriticSignal;
    clarity?: ClaritySignal;
  };
  /**
   * Set when the extra plan runs were skipped and convergence is absent from
   * signals — the weights renormalize over what remains (#50).
   */
  convergenceSkipped?: {
    reason: "decisive" | "disabled";
    /** e.g. "composite in [0.87, 0.91] → queued for any convergence value". */
    detail: string;
  };
  /** Per-signal failures, e.g. "convergence: only 1 plan generated". */
  errors: string[];
  computedAt: string; // ISO 8601
}
