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
    platform: issue.platform,
    accountId: issue.accountId,
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: "triage",
    createdAt: at,
    updatedAt: at,
    transitions: [{ at, from: null, to: "triage", actor: "reconcile", reason: "admitted" }],
  };
}

export function applyTransition(
  item: TrackedItem,
  to: LifecycleState,
  actor: TransitionActor,
  reason?: string,
  now: Date = new Date(),
): TrackedItem {
  if (!canTransition(item.state, to)) {
    throw new IllegalTransitionError(item.id, item.state, to);
  }
  const at = now.toISOString();
  return {
    ...item,
    state: to,
    updatedAt: at,
    transitions: [...item.transitions, { at, from: item.state, to, actor, reason }],
  };
}
