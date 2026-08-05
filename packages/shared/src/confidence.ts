// ============================================================
// Skipper — Confidence report types (issue #8; rendered by #13)
// ============================================================

export interface GroundednessSignal {
  /** 0..1 — the raw coverage rescaled onto the discriminating band (#309). */
  score: number;
  /** 0..1 — weighted fraction of cited files + symbols found in the repo. */
  coverage?: number;
  filesChecked: number;
  filesFound: number;
  symbolsChecked: number;
  symbolsFound: number;
  missingFiles: string[];
  missingSymbols: string[];
  /** Paths declared status:"new" by the plan — exempt from the check. */
  newFiles: string[];
  /** Symbols the plan declares it creates — exempt from the check (#158). */
  createdSymbols?: string[];
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
  /** Continuity classification against the prior review round (#205); absent = "new". */
  status?: "new" | "persisting";
  /** The objection depends on a repo fact the critic could not check (#308);
   *  absent = demonstrated. */
  unverified?: boolean;
}

export interface CriticSignal {
  /** 0..1 — derived deterministically by weighting the objections (#319); the
   *  verdict only caps a "reject". */
  score: number;
  verdict: CriticVerdict;
  objections: CriticObjection[];
  /** Prior-round objections the current artifact genuinely addressed (#205). */
  resolved?: CriticObjection[];
}

/** A decision the issue leaves open, as judged against the plan (#309). */
export interface ClarityAmbiguity {
  detail: string;
  /** An existing repo convention settles it — no human input needed. */
  resolvableFromRepo: boolean;
  /** The plan raises it in openQuestions instead of silently deciding it. */
  flaggedByPlan: boolean;
}

/** One of the plan's openQuestions, classified by what it reveals (#309). */
export interface ClarityOpenQuestion {
  question: string;
  kind: "issue-ambiguity" | "repo-knowledge";
}

export interface ClaritySignal {
  /** 0..1 — derived in code from the judgment below. */
  score: number;
  /** Can an outsider objectively tell whether the change is done? (#309) */
  criteria?: "verifiable" | "partial" | "vague";
  ambiguities?: ClarityAmbiguity[];
  openQuestions?: ClarityOpenQuestion[];
  /** One-line justification, surfaced in the UI. */
  rationale?: string;
  /** @deprecated structural heuristic, kept to render reports scored before #309. */
  bodyPresent?: boolean;
  /** @deprecated structural heuristic, kept to render reports scored before #309. */
  hasAcceptanceCriteria?: boolean;
  /** @deprecated structural heuristic, kept to render reports scored before #309. */
  hasReproSteps?: boolean;
  /** @deprecated structural heuristic, kept to render reports scored before #309. */
  openQuestionCount?: number;
}

/**
 * The weighted quality signals. Groundedness is measured but not weighted (#321):
 * it was constant at 1.000 across the whole calibration corpus, so it carried
 * weight on a constant. It stays an admissibility check through the veto below.
 */
export interface ConfidenceWeights {
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

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = { high: 0.85, low: 0.4 };

/** Extra plan runs sampled for the convergence signal (#8). Needs 2+ to compare. */
export const DEFAULT_EXTRA_PLAN_RUNS = 2;

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
    reason: "decisive" | "disabled" | "rescore";
    /** e.g. "composite in [0.87, 0.91] → queued for any convergence value". */
    detail: string;
  };
  /**
   * A signal that forces needs-input on its own, whatever the composite says
   * (#309): a plan citing files and symbols that do not exist is not gradeable.
   */
  veto?: {
    signal: "groundedness";
    detail: string;
  };
  /** Per-signal failures, e.g. "convergence: only 1 plan generated". */
  errors: string[];
  computedAt: string; // ISO 8601
}
