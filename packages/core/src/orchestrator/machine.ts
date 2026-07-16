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
    transitions: [...item.transitions, { at, from: item.state, to, actor, reason }],
  };
}
