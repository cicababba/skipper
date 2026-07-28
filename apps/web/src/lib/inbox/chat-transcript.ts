import type { PlanChatMessage } from "@skipper/shared";
import type { ChatTurn } from "./chat-turns";

// One ordered list out of the two sources the chat panel renders (#260): the
// persisted transcript and the session-only activity turns. Both carry ISO
// timestamps, so the merge is a plain sort with messages winning ties.

export type TranscriptItem =
  | { kind: "message"; message: PlanChatMessage; index: number; failed?: boolean }
  | { kind: "turn"; turn: ChatTurn }
  | { kind: "draft"; text: string };

export interface TranscriptLive {
  /** Index into `messages` of an optimistic user bubble whose send failed. */
  failedIndex?: number;
  /** Streamed assistant text for the in-flight send turn. */
  draft?: string;
}

export function buildTranscript(
  messages: PlanChatMessage[],
  turns: ChatTurn[],
  live: TranscriptLive = {},
): TranscriptItem[] {
  const sortable: { at: string; rank: number; item: TranscriptItem }[] = [
    ...messages.map((message, index) => ({
      at: message.at,
      rank: 0,
      item: {
        kind: "message" as const,
        message,
        index,
        failed: index === live.failedIndex,
      },
    })),
    ...turns.map((turn) => ({
      at: turn.openedAt,
      rank: 1,
      item: { kind: "turn" as const, turn },
    })),
  ];

  sortable.sort((a, b) => (a.at === b.at ? a.rank - b.rank : a.at < b.at ? -1 : 1));
  const items = sortable.map((entry) => entry.item);

  if (live.draft) items.push({ kind: "draft", text: live.draft });
  return items;
}
