import type { AppDict } from "@/lib/app-i18n";
import type { ItemAction } from "./actions";

// Single source of truth for the label of a row/rail action, so the kebab menu and
// the "next action" pill can never disagree (#225). The action id stays stable
// (now.ts looks openPr up by id) — only the presentation varies: an item that
// already has a PR repushes onto it rather than opening a new one.
export function actionLabel(action: ItemAction, t: Pick<AppDict, "inbox">): string {
  if (action.kind === "openPr" && action.prNumber !== undefined) {
    return t.inbox.actions.pushToPr(action.prNumber);
  }
  return t.inbox.actions[action.id];
}
