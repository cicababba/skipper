import { canTransition, type LifecycleState, type TrackedItem } from "@nestbrain/shared";

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
  | "unpin";

export type ItemAction =
  | { id: ItemActionId; kind: "transition"; to: LifecycleState }
  | { id: "openPr"; kind: "openPr" }
  | { id: "pin" | "unpin"; kind: "pin"; pinned: boolean };

function transition(id: ItemActionId, item: TrackedItem, to: LifecycleState): ItemAction[] {
  return canTransition(item.state, to) ? [{ id, kind: "transition", to }] : [];
}

export function actionsFor(item: TrackedItem): ItemAction[] {
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
    default:
      // PR states live on the platform (link-out only); merged/closed are settled.
      return [];
  }
}
