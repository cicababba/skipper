"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Bot, CheckCircle2, CircleDashed, Wrench, XCircle } from "lucide-react";
import type { CodingEvent, CodingEventEnvelope } from "@nestbrain/shared";
import { useT } from "@/lib/app-i18n";
import { appendLive, mergeReplay } from "@/lib/inbox/console";

// Generic agent-event console (#32): renders any CodingEvent stream. Used by
// the planner today; the coding runner (#12/#13) plugs in its own
// getEvents/onEvent pair.

interface EventConsoleProps {
  itemId: string;
  getEvents: (itemId: string) => Promise<CodingEventEnvelope[]>;
  onEvent: (itemId: string, callback: (envelope: CodingEventEnvelope) => void) => () => void;
  className?: string;
}

const STICKY_THRESHOLD = 24;

export function EventConsole({ itemId, getEvents, onEvent, className }: EventConsoleProps) {
  const { t } = useT();
  const c = t.inbox.console;
  const [envelopes, setEnvelopes] = useState<CodingEventEnvelope[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);

  // Reset during render when the item changes (the sanctioned alternative to
  // clearing state inside the subscription effect below).
  const [prevItemId, setPrevItemId] = useState(itemId);
  if (prevItemId !== itemId) {
    setPrevItemId(itemId);
    setEnvelopes([]);
  }

  useEffect(() => {
    let cancelled = false;
    // Subscribe before replaying so nothing lands in the gap; both dedup by seq.
    const unsubscribe = onEvent(itemId, (envelope) => {
      if (!cancelled) setEnvelopes((live) => appendLive(live, envelope));
    });
    void getEvents(itemId).then((replay) => {
      if (!cancelled) setEnvelopes((live) => mergeReplay(live, replay));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [itemId, getEvents, onEvent]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [envelopes]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stuckRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - STICKY_THRESHOLD;
  };

  const line = (event: CodingEvent) => {
    switch (event.kind) {
      case "status":
        return (
          <div className="flex items-center gap-2 text-muted">
            <CircleDashed size={13} className="shrink-0" />
            {c.status[event.phase]}
            {event.detail && <span className="opacity-60">{event.detail}</span>}
          </div>
        );
      case "agent-init":
        return (
          <div className="flex items-center gap-2 text-muted">
            <Bot size={13} className="shrink-0" />
            {c.session}
            {event.model && <span className="opacity-60">{event.model}</span>}
          </div>
        );
      case "text":
        return <div className="whitespace-pre-wrap break-words">{event.text}</div>;
      case "tool-use":
        return (
          <div className="flex items-center gap-2">
            <Wrench size={13} className="shrink-0 text-muted" />
            <span>{event.tool}</span>
            {event.detail && <span className="truncate opacity-60">{event.detail}</span>}
          </div>
        );
      case "result":
        return (
          <div className={`flex items-center gap-2 ${event.ok ? "text-green-300" : "text-red-300"}`}>
            {event.ok ? (
              <CheckCircle2 size={13} className="shrink-0" />
            ) : (
              <XCircle size={13} className="shrink-0" />
            )}
            {event.ok ? c.finishedOk : c.finishedFail}
            {typeof event.turns === "number" && (
              <span className="opacity-60">
                {event.turns} {c.turns}
              </span>
            )}
          </div>
        );
      case "error":
        return (
          <div className="flex items-center gap-2 text-red-300">
            <AlertCircle size={13} className="shrink-0" />
            <span className="whitespace-pre-wrap break-words">{event.message}</span>
          </div>
        );
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={`max-h-96 overflow-y-auto rounded-lg border border-card-hover bg-card p-3 font-mono text-xs leading-relaxed ${className ?? ""}`}
    >
      {envelopes.length === 0 ? (
        <div className="text-muted">{c.waiting}</div>
      ) : (
        <div className="space-y-1.5">
          {envelopes.map((e) => (
            <div key={e.seq}>{line(e.event)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
