import { salvageableDeathSubtype } from "@skipper/core";
import type { ChatErrorKind } from "@skipper/shared";

// A chat turn that died on its budget (#301) reaches the renderer as a raw CLI
// error string, which says nothing a user can act on. The IPC boundary maps the
// death's subtype to a kind the UI can localize; the raw message rides along as
// the detail.

export function chatErrorKind(err: unknown): ChatErrorKind | undefined {
  switch (salvageableDeathSubtype(err)) {
    case "error_max_turns":
      return "turn-limit";
    case "error_hard_timeout":
    case "error_inactivity":
      return "timeout";
    default:
      return undefined;
  }
}
