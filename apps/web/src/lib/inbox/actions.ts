import { canTransition, type LifecycleState, type TrackedItem } from "@skipper/shared";

export type ItemActionId =
  | "plan"
  | "approve"
  | "replan"
  | "park"
  | "openPr"
  | "resume"
  | "retry"
  | "close"
  | "pin"
  | "unpin"
  | "archive"
  | "untrack";

export type ItemAction =
  | { id: ItemActionId; kind: "transition"; to: LifecycleState }
  | { id: "openPr"; kind: "openPr" }
  | { id: "pin" | "unpin"; kind: "pin"; pinned: boolean }
  | { id: "archive"; kind: "archive" }
  | { id: "untrack"; kind: "untrack" };

function transition(id: ItemActionId, item: TrackedItem, to: LifecycleState): ItemAction[] {
  return canTransition(item.state, to) ? [{ id, kind: "transition", to }] : [];
}

function baseActionsFor(item: TrackedItem): ItemAction[] {
  const close = transition("close", item, "closed");
  switch (item.state) {
    case "triage":
      return [...transition("plan", item, "planning"), ...close];
    case "plan-gate":
      return [
        ...transition("approve", item, "queued"),
        ...transition("replan", item, "planning"),
        ...transition("park", item, "needs-input"),
      ];
    case "human-review":
      return [{ id: "openPr", kind: "openPr" }, ...close];
    case "needs-input":
    case "blocked": {
      const to =
        item.resumeTo && canTransition(item.state, item.resumeTo) ? item.resumeTo : "triage";
      return [...transition("resume", item, to), ...close];
    }
    case "failed":
      return [...transition("retry", item, "triage"), ...close];
    case "queued":
      // Manual queue-priority pin (#15): jumps the item to the front.
      return [
        item.pinned
          ? { id: "unpin", kind: "pin", pinned: false }
          : { id: "pin", kind: "pin", pinned: true },
        ...close,
      ];
    case "planning":
    case "coding":
    case "agent-review":
      return close;
    case "closed": {
      // Offer Archive once, until the worktree is gone and the plan archived (#115).
      const alreadyArchived =
        !item.worktree && (!item.plan?.ref || item.plan.ref.startsWith("archive/"));
      return alreadyArchived ? [] : [{ id: "archive", kind: "archive" }];
    }
    default:
      // PR states live on the platform (link-out only); merged/closed are settled.
      return [];
  }
}

export function actionsFor(item: TrackedItem): ItemAction[] {
  // Untrack (#120) is offered in every state — including the otherwise-empty ones
  // (merged, PR states, archived closed) — since removal is always available.
  return [...baseActionsFor(item), { id: "untrack", kind: "untrack" }];
}

// Only these render inline as the accent button (#133). An allow-list (rather than a
// "first non-destructive action" rule) keeps Unpin and Archive out of the inline slot,
// and makes any future action id default to the kebab menu.
export const PRIMARY_ACTION_IDS = [
  "plan",
  "approve",
  "resume",
  "retry",
] as const satisfies readonly ItemActionId[];

export const DESTRUCTIVE_ACTION_IDS = [
  "close",
  "untrack",
] as const satisfies readonly ItemActionId[];

export function isDestructiveAction(id: ItemActionId): boolean {
  return (DESTRUCTIVE_ACTION_IDS as readonly ItemActionId[]).includes(id);
}

export type SplitActions = {
  primary: ItemAction | null;
  menu: ItemAction[];
  destructive: ItemAction[];
};

// Placement only (#133): ordering stays owned by actionsFor. The primary must be the
// first entry, so each bucket is a subsequence of the input and nothing is reordered.
export function splitActions(actions: ItemAction[]): SplitActions {
  const first = actions[0];
  const hasPrimary =
    first !== undefined && (PRIMARY_ACTION_IDS as readonly ItemActionId[]).includes(first.id);
  const rest = hasPrimary ? actions.slice(1) : actions;
  return {
    primary: hasPrimary ? first : null,
    menu: rest.filter((a) => !isDestructiveAction(a.id)),
    destructive: rest.filter((a) => isDestructiveAction(a.id)),
  };
}
