import type { ChatTurn } from "./chat-turns";

// Streamed assistant text (#260). The agent emits whole message blocks as
// `text` events while a chat turn runs; joining them gives the draft bubble the
// user reads before the authoritative reply lands.

export function draftFromTurn(turn: ChatTurn | null): string {
  if (!turn) return "";
  return turn.envelopes
    .map((e) => (e.event.kind === "text" ? e.event.text : null))
    .filter((text): text is string => text != null && text.trim().length > 0)
    .join("\n\n");
}
