import type { ChatTurn } from "./chat-turns";

// Streamed assistant text (#260, #277). While a chat turn runs the agent emits
// whole message blocks as `text` events and, when partial-message streaming is
// available, progressive `text-delta` increments. A run of consecutive deltas
// concatenates (no separator) into one growing segment; each block `text` is its
// own segment; segments join with "\n\n". With deltas absent this is identical
// to the old block-only join, giving the draft bubble the user reads before the
// authoritative reply lands.

export function draftFromTurn(turn: ChatTurn | null): string {
  if (!turn) return "";
  const segments: string[] = [];
  let deltaRun: string | null = null;
  const closeRun = () => {
    if (deltaRun !== null) {
      segments.push(deltaRun);
      deltaRun = null;
    }
  };
  for (const e of turn.envelopes) {
    if (e.event.kind === "text-delta") {
      deltaRun = (deltaRun ?? "") + e.event.text;
    } else if (e.event.kind === "text") {
      closeRun();
      segments.push(e.event.text);
    }
  }
  closeRun();
  return segments.filter((s) => s.trim().length > 0).join("\n\n");
}
