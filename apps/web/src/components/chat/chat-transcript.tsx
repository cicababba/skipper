"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { isPlanChatText, type PlanChatMessage } from "@skipper/shared";
import type { ReactNode } from "react";
import { useT } from "@/lib/app-i18n";
import { isStuck } from "@/lib/inbox/chat-format";
import type { TranscriptItem } from "@/lib/inbox/chat-transcript";
import { ConsoleMarkdown } from "@/components/console-markdown";
import { ChatActivity } from "./chat-activity";
import { ChatMessage } from "./chat-message";

// The scrolling half of the chat panel (#260): messages, per-turn activity and
// the streamed draft in one list, with sticky-to-bottom scrolling and a
// jump-to-latest pill once the user scrolls away.

interface ChatTranscriptProps {
  items: TranscriptItem[];
  thinking: boolean;
  emptyState?: ReactNode;
  renderSystemMessage: (message: PlanChatMessage) => ReactNode;
  onRetry: () => void;
  onDismiss: () => void;
}

export function ChatTranscript({
  items,
  thinking,
  emptyState,
  renderSystemMessage,
  onRetry,
  onDismiss,
}: ChatTranscriptProps) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;
  const c = t.inbox.chat;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuck) el.scrollTop = el.scrollHeight;
  }, [items, thinking, stuck]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setStuck(isStuck(el.scrollTop, el.clientHeight, el.scrollHeight));
  };

  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStuck(true);
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto p-4 space-y-3 text-sm"
      >
        {items.length === 0 && !thinking
          ? emptyState
          : items.map((item) => {
              if (item.kind === "turn") return <ChatActivity key={item.turn.id} turn={item.turn} />;
              if (item.kind === "draft") {
                return (
                  <div key="draft" className="max-w-[90%] text-foreground/90">
                    <ConsoleMarkdown content={item.text} />
                  </div>
                );
              }
              if (!isPlanChatText(item.message)) {
                return (
                  <div key={`m${item.index}`}>{renderSystemMessage(item.message)}</div>
                );
              }
              return (
                <ChatMessage
                  key={`m${item.index}`}
                  message={item.message}
                  failed={item.failed}
                  onRetry={onRetry}
                  onDismiss={onDismiss}
                />
              );
            })}
        {thinking && (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Loader2 size={13} className="animate-spin" />
            {chat.thinking}
          </div>
        )}
      </div>

      {!stuck && (
        <button
          onClick={toBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] font-medium text-muted shadow-lg hover:text-foreground transition-colors"
        >
          <ArrowDown size={11} />
          {c.jumpToLatest}
        </button>
      )}
    </div>
  );
}
