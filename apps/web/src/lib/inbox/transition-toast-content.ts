import type { AppDict } from "@/lib/app-i18n";
import type { TransitionToast } from "./transition-toasts";

// Copy for the orchestrator event toasts (#286). Kept apart from the detection so
// the mapping table (variant, stickiness, action label) reads in one place.
//
// Stickiness is expressed through durationMs: the toast provider treats an error
// variant or the presence of an action as sticky, so the two "good news" toasts
// have to ask for auto-dismissal explicitly.

export interface TransitionToastContent {
  variant: "info" | "success" | "error";
  title: string;
  message: string;
  actionLabel: string;
  durationMs?: number;
}

const AUTO_DISMISS_MS = 5000;

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

export function toastContentFor(
  event: TransitionToast,
  t: Pick<AppDict, "inbox">,
): TransitionToastContent {
  const copy = t.inbox.toasts;
  switch (event.kind) {
    case "plan-gate":
      return {
        variant: "info",
        title: copy.planGate,
        message:
          event.confidence === undefined
            ? event.label
            : copy.withConfidence(event.label, pct(event.confidence)),
        actionLabel: copy.openItem,
      };
    case "human-review":
      return {
        variant: "info",
        title: copy.humanReview,
        message: event.label,
        actionLabel: copy.openItem,
      };
    case "pr-open":
      return {
        variant: "success",
        title: event.repush ? copy.prUpdated : copy.prOpened,
        message: event.label,
        actionLabel: copy.viewPr,
        durationMs: AUTO_DISMISS_MS,
      };
    case "needs-input":
      return {
        variant: "error",
        title: copy.needsInput,
        message: event.reason ? copy.withReason(event.label, event.reason) : event.label,
        actionLabel: copy.openItem,
      };
    case "changes-requested":
      return {
        variant: "error",
        title: copy.changesRequested,
        message: event.label,
        actionLabel: copy.viewPr,
      };
    case "ci-failed":
      return {
        variant: "error",
        title: copy.ciFailed,
        message: event.label,
        actionLabel: copy.viewPr,
      };
    case "merged":
      return {
        variant: "success",
        title: copy.merged,
        message: event.label,
        actionLabel: copy.viewPr,
        durationMs: AUTO_DISMISS_MS,
      };
  }
}
