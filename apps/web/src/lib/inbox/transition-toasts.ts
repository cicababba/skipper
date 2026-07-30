import { displayKey } from "@skipper/shared";
import type { OrchestratorState, PullRequest, TrackedItem } from "@skipper/shared";

// Client-side detection of the orchestrator transitions that want a human (#286):
// two consecutive state snapshots in, toast-worthy events out. The renderer already
// receives every snapshot, so nothing new is plumbed through the main process.
//
// Pushes repeat with unchanged items (a poll tick refreshes accounts), so an event
// is only ever derived from a per-item field change — never from snapshot identity.

export type TransitionToast =
  | { kind: "plan-gate"; itemId: string; label: string; confidence?: number }
  | { kind: "human-review"; itemId: string; label: string }
  | { kind: "pr-open"; itemId: string; label: string; prUrl: string; repush: boolean }
  | { kind: "needs-input"; itemId: string; label: string; reason?: string }
  | { kind: "changes-requested"; itemId: string; label: string; prUrl: string }
  | { kind: "ci-failed"; itemId: string; label: string; prUrl: string }
  | { kind: "merged"; itemId: string; label: string; prUrl: string };

export const LABEL_MAX = 60;

export function truncateLabel(text: string): string {
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`;
}

export function itemLabel(item: TrackedItem): string {
  return truncateLabel(`${displayKey(item.key)} ${item.title}`);
}

/** The PR record behind an item's link — CI status lives there, not on the item. */
export function trackedPull(
  state: OrchestratorState,
  item: TrackedItem,
): PullRequest | undefined {
  const pr = item.pr;
  if (!pr) return undefined;
  return state.accounts[item.accountId]?.pullRequests.find(
    (candidate) =>
      candidate.number === pr.number &&
      candidate.repo.owner === item.repo.owner &&
      candidate.repo.name === item.repo.name,
  );
}

export function diffTransitionToasts(
  prev: OrchestratorState | null,
  next: OrchestratorState,
): TransitionToast[] {
  // The first snapshot carries no history: everything in it would look like a
  // transition, so app start (and restart with items already at the gate) is silent.
  if (!prev) return [];

  const before = new Map(prev.items.map((item) => [item.id, item]));
  const events: TransitionToast[] = [];

  for (const item of next.items) {
    const prevItem = before.get(item.id);
    // A newly admitted item can't be told apart from one that was already there
    // before this renderer saw it, and normal intake admits at triage anyway.
    if (!prevItem) continue;

    if (prevItem.state !== item.state) {
      const event = lifecycleEvent(prevItem, item);
      if (event) events.push(event);
    }

    const ciEvent = ciFailureEvent(prev, next, prevItem, item);
    if (ciEvent) events.push(ciEvent);
  }

  return events;
}

function lifecycleEvent(prevItem: TrackedItem, item: TrackedItem): TransitionToast | null {
  const itemId = item.id;
  const label = itemLabel(item);
  const confidence = item.plan?.confidence;
  const reason = item.transitions[item.transitions.length - 1]?.reason;

  switch (item.state) {
    case "plan-gate":
      return { kind: "plan-gate", itemId, label, ...(confidence !== undefined ? { confidence } : {}) };
    case "human-review":
      return { kind: "human-review", itemId, label };
    case "pr-open":
      return item.pr
        ? {
            kind: "pr-open",
            itemId,
            label,
            prUrl: item.pr.url,
            repush: prevItem.pr !== undefined,
          }
        : null;
    case "needs-input":
      return { kind: "needs-input", itemId, label, ...(reason ? { reason } : {}) };
    case "changes-requested":
      return item.pr ? { kind: "changes-requested", itemId, label, prUrl: item.pr.url } : null;
    case "merged":
      return item.pr ? { kind: "merged", itemId, label, prUrl: item.pr.url } : null;
    default:
      return null;
  }
}

// A PR that was already red when it first showed up in the snapshot is history,
// not news: the edge is only reported when the previous snapshot knew the PR and
// it wasn't failing then. A re-failure after a repush still fires — ciStatus
// cycles through pending on the new push.
function ciFailureEvent(
  prev: OrchestratorState,
  next: OrchestratorState,
  prevItem: TrackedItem,
  item: TrackedItem,
): TransitionToast | null {
  if (!item.pr) return null;
  const nextPull = trackedPull(next, item);
  if (nextPull?.ciStatus !== "failing") return null;
  const prevPull = trackedPull(prev, prevItem);
  if (!prevPull || prevPull.ciStatus === "failing") return null;
  return { kind: "ci-failed", itemId: item.id, label: itemLabel(item), prUrl: item.pr.url };
}
