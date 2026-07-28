"use client";

import { useEffect, useMemo, useState } from "react";
import type { CodingEventEnvelope } from "@skipper/shared";
import {
  EMPTY_CHAT_STREAM_STATE,
  allTurns,
  mergeReplayIntoState,
  reduceLive,
  type ChatStreamState,
  type ChatTurn,
} from "@/lib/inbox/chat-turns";

export interface ChatStreamSource {
  getEvents: (itemId: string) => Promise<CodingEventEnvelope[]>;
  onEvent: (itemId: string, callback: (envelope: CodingEventEnvelope) => void) => () => void;
}

// Subscribes to the item's agent-event stream and hands back the chat turns it
// contains (#260). Same subscribe-then-replay ordering as the event console, so
// nothing lands in the gap.

export function useChatStream(
  itemId: string,
  turnDetails: string[],
  stream?: ChatStreamSource,
): ChatTurn[] {
  const [state, setState] = useState<ChatStreamState>(EMPTY_CHAT_STREAM_STATE);

  const [prevItemId, setPrevItemId] = useState(itemId);
  if (prevItemId !== itemId) {
    setPrevItemId(itemId);
    setState(EMPTY_CHAT_STREAM_STATE);
  }

  useEffect(() => {
    if (!stream) return;
    let cancelled = false;
    const unsubscribe = stream.onEvent(itemId, (envelope) => {
      if (!cancelled) setState((s) => reduceLive(s, envelope, turnDetails));
    });
    void stream.getEvents(itemId).then((replay) => {
      if (!cancelled) setState((s) => mergeReplayIntoState(s, replay));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [itemId, turnDetails, stream]);

  return useMemo(() => allTurns(state, turnDetails), [state, turnDetails]);
}
