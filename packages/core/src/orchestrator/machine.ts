import type { Issue, LifecycleState, TrackedItem, TransitionActor } from "@skipper/shared";
import { canTransition } from "./states";

export class IllegalTransitionError extends Error {
  readonly itemId: string;
  readonly from: LifecycleState;
  readonly to: LifecycleState;

  constructor(itemId: string, from: LifecycleState, to: LifecycleState) {
    super(`illegal transition ${from} → ${to} for ${itemId}`);
    this.name = "IllegalTransitionError";
    this.itemId = itemId;
    this.from = from;
    this.to = to;
  }
}

export function admitItem(issue: Issue, now: Date = new Date()): TrackedItem {
  // Admission requires a repo — resolution fills repo-less tracker issues before
  // reconcile, and the reconcile belt never admits one that is still repo-less (#79).
  if (!issue.repo) {
    throw new Error(`cannot admit ${issue.id}: issue has no repo (unmapped project)`);
  }
  const at = now.toISOString();
  return {
    id: issue.id,
    source: issue.source,
    sourceRef: issue.sourceRef,
    codeHost: issue.codeHost,
    accountId: issue.accountId,
    repo: issue.repo,
    key: issue.key,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: "triage",
    createdAt: at,
    updatedAt: at,
    transitions: [{ at, from: null, to: "triage", actor: "reconcile", reason: "admitted" }],
  };
}

export interface TransitionOptions {
  now?: Date;
  /** Where resume should land; only meaningful when `to` is needs-input/blocked. */
  resumeTo?: LifecycleState;
}

export function applyTransition(
  item: TrackedItem,
  to: LifecycleState,
  actor: TransitionActor,
  reason?: string,
  opts: TransitionOptions = {},
): TrackedItem {
  if (!canTransition(item.state, to)) {
    throw new IllegalTransitionError(item.id, item.state, to);
  }
  const at = (opts.now ?? new Date()).toISOString();
  const parked = to === "needs-input" || to === "blocked";
  return {
    ...item,
    state: to,
    updatedAt: at,
    resumeTo: parked ? opts.resumeTo : undefined,
    // The base-advance notice (#329) describes the item as it stood; whatever the
    // transition is, it is now a statement about the past.
    baseAdvance: undefined,
    transitions: [...item.transitions, { at, from: item.state, to, actor, reason }],
  };
}
