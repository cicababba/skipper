import { applyTransition, resolveGate, type OrchestratorManifest } from "@skipper/core";
import {
  latestCodingTransitionAt,
  latestPlanningTransitionAt,
  type AgentReview,
  type ConfidenceReport,
  type LifecycleState,
  type PrReviewComment,
  type RepoRef,
  type TrackedItem,
} from "@skipper/shared";

export interface ManifestWriterDeps {
  ensureManifest(): Promise<OrchestratorManifest>;
  saveManifest(m: OrchestratorManifest): Promise<void>;
  broadcast(): void;
  pokeCoder(): void;
  pokeReviewer(): void;
  pokeShepherd(): void;
  getRepoAutoCoding(repo: RepoRef): "on" | "off" | "auto";
  archivePlan(itemId: string, plan: TrackedItem["plan"]): Promise<TrackedItem["plan"]>;
}

export function makeManifestWriters(d: ManifestWriterDeps) {
  /** Sets plan.ref + confidence and the gated transition in a single manifest write (#8). */
  async function completePlan(
    itemId: string,
    ref: string,
    confidence?: ConfidenceReport,
    expectedPlanningAt?: string,
  ): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    // Refuse a stale run's result (#159): the item left planning, or a newer
    // planning transition superseded this run's token. Return silently — a throw
    // would bounce into the planner's catch and park the fresh lifecycle.
    if (item.state !== "planning" || latestPlanningTransitionAt(item) !== expectedPlanningAt) {
      console.warn(`stale plan completion refused for ${itemId}`);
      return;
    }
    // No score is a scoring *failure*, not a decision — #8's contract is the
    // conservative gate, so autoCoding:"on" deliberately does not apply here.
    const target = confidence
      ? resolveGate(confidence.composite, m.settings.confidence, d.getRepoAutoCoding(item.repo))
      : "plan-gate";
    let reason: string;
    if (confidence) {
      const divergent = confidence.signals.convergence?.divergent
        ? " — plans diverge, issue may be ambiguous"
        : "";
      reason = `confidence ${confidence.composite.toFixed(2)}${divergent}`;
    } else {
      reason = "plan generated (confidence unavailable)";
    }
    const { rescoring: _drop, ...planRest } = item.plan ?? {};
    const withRef = { ...item, plan: { ...planRest, ref, confidence: confidence?.composite } };
    // Below the low floor the plan itself is broken — resume means replan.
    m.items[itemId] = applyTransition(withRef, target, "planner", reason, {
      resumeTo: target === "needs-input" ? "planning" : undefined,
    });
    await d.saveManifest(m);
    d.broadcast();
    // High confidence gates straight to queued — wake the coder.
    d.pokeCoder();
  }

  /**
   * Sets coderReport.ref + the agent-review transition in a single manifest write
   * (#146). A degraded run (no parseable report) passes reportRef undefined —
   * the field is deleted so a stale report never shows against a new diff.
   */
  async function completeCoding(
    itemId: string,
    reportRef: string | undefined,
    reason: string,
    expectedCodingAt?: string,
  ): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    // Refuse a stale run's result (#159): the item left coding, or an untrack →
    // re-admit minted a newer coding transition superseding this run's token.
    // Return silently — a throw would bounce into the coder's catch.
    if (item.state !== "coding" || latestCodingTransitionAt(item) !== expectedCodingAt) {
      console.warn(`stale coding completion refused for ${itemId}`);
      return;
    }
    const { coderReport: _drop, ...rest } = item;
    const withReport = reportRef ? { ...rest, coderReport: { ref: reportRef } } : rest;
    m.items[itemId] = applyTransition(withReport, "agent-review", "coder", reason);
    await d.saveManifest(m);
    d.broadcast();
    d.pokeReviewer();
  }

  /**
   * Sets item.review + the transition in a single manifest write (#10) — atomic
   * rounds+transition so a crash can never burn a review round.
   */
  async function completeReview(
    itemId: string,
    review: AgentReview,
    to: LifecycleState,
    reason: string,
    resumeTo?: LifecycleState,
  ): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    m.items[itemId] = applyTransition({ ...item, review }, to, "reviewer", reason, { resumeTo });
    await d.saveManifest(m);
    d.broadcast();
    // Fix round lands the item back in queued-for-coding territory — wake the coder.
    d.pokeCoder();
    // A fix round converging to human-review is the auto-repush trigger (#11).
    d.pokeShepherd();
  }

  /**
   * Sets the authoritative PR link + lastPushedSha, clears pending review
   * comments, and transitions to pr-open in a single manifest write (#11).
   */
  async function completePrOpen(
    itemId: string,
    pr: { id: string; number: number; url: string },
    pushedSha: string,
    actor: "user" | "shepherd",
    reason: string,
  ): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    const withPr: TrackedItem = {
      ...item,
      pr,
      shepherd: { ...item.shepherd, pendingReviewComments: undefined, lastPushedSha: pushedSha },
    };
    m.items[itemId] = applyTransition(withPr, "pr-open", actor, reason);
    await d.saveManifest(m);
    d.broadcast();
  }

  /**
   * Sets shepherd.pendingReviewComments + the changes-requested → coding
   * transition in a single manifest write (#11). The item lands directly in
   * "coding": the coder's scan picks it up (counts toward the WIP limit) without
   * passing through the queue — finishing in-flight work beats starting new.
   */
  async function completeReentry(
    itemId: string,
    comments: PrReviewComment[],
    reason: string,
  ): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    const withComments: TrackedItem = {
      ...item,
      shepherd: { ...item.shepherd, pendingReviewComments: comments },
    };
    m.items[itemId] = applyTransition(withComments, "coding", "shepherd", reason);
    await d.saveManifest(m);
    d.broadcast();
    d.pokeCoder();
  }

  /** Stamps the memory ref and drops the worktree record — no transition, merged is terminal (#11). */
  async function completeMergedCleanup(itemId: string, memoryRef: string): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    const plan = await d.archivePlan(itemId, item.plan);
    m.items[itemId] = {
      ...item,
      worktree: undefined,
      plan,
      shepherd: { ...item.shepherd, memoryRef },
      updatedAt: new Date().toISOString(),
    };
    await d.saveManifest(m);
    d.broadcast();
  }

  /** Persists the coding worktree record (path/branch/sessionId) without a transition (#9). */
  async function setWorktree(
    itemId: string,
    worktree: { path: string; branch: string; sessionId?: string },
  ): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    m.items[itemId] = { ...item, worktree, updatedAt: new Date().toISOString() };
    await d.saveManifest(m);
    d.broadcast();
  }

  /** Records the plan run's Claude session id without a transition (#111). Overwritten
   *  each plan run; cwd-scoped to worktree.path. completePlan preserves it via spread. */
  async function setPlanSessionId(itemId: string, sessionId: string): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    m.items[itemId] = {
      ...item,
      plan: { ...item.plan, sessionId },
      updatedAt: new Date().toISOString(),
    };
    await d.saveManifest(m);
    d.broadcast();
  }

  /** Marks an item as rescoring confidence (#164) without a transition — drives the
   *  badge spinner while the detached rescore runs. */
  async function setPlanRescoring(itemId: string): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) return;
    m.items[itemId] = {
      ...item,
      plan: { ...item.plan, rescoring: true },
      updatedAt: new Date().toISOString(),
    };
    await d.saveManifest(m);
    d.broadcast();
  }

  /** Clears the rescoring flag (#164). When a fresh composite is provided AND the item
   *  is still at the gate, it also updates plan.confidence — never a transition, so a
   *  score jump can't auto-queue coding while a human reviews. */
  async function completeRescore(itemId: string, composite?: number): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) return;
    const { rescoring: _drop, ...plan } = item.plan ?? {};
    const setComposite = composite !== undefined && item.state === "plan-gate";
    m.items[itemId] = {
      ...item,
      plan: setComposite ? { ...plan, confidence: composite } : plan,
      updatedAt: new Date().toISOString(),
    };
    await d.saveManifest(m);
    d.broadcast();
  }

  /** Records the critic round's Claude session id without a transition (#111). On
   *  round 1 (no review yet) it seeds a stub review the reviewer/UI already handle;
   *  completeReview replaces it wholesale. The chained-round check reads only
   *  pendingObjections (absent here, preserved by spread) — unaffected. */
  async function setReviewSessionId(itemId: string, sessionId: string): Promise<void> {
    const m = await d.ensureManifest();
    const item = m.items[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    const review: AgentReview = item.review
      ? { ...item.review, sessionId }
      : {
          rounds: 0,
          outcome: "unavailable",
          reason: "review in progress",
          sessionId,
          at: new Date().toISOString(),
        };
    m.items[itemId] = { ...item, review, updatedAt: new Date().toISOString() };
    await d.saveManifest(m);
    d.broadcast();
  }

  return {
    completePlan,
    completeCoding,
    completeReview,
    completePrOpen,
    completeReentry,
    completeMergedCleanup,
    setWorktree,
    setPlanSessionId,
    setPlanRescoring,
    completeRescore,
    setReviewSessionId,
  };
}
