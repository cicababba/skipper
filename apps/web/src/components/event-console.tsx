"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { CodingEventEnvelope } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { appendLive, mergeReplay } from "@/lib/inbox/console";
import { isStuck } from "@/lib/inbox/chat-format";
import { EventLine } from "./event-line";

// Generic agent-event console (#32): renders any CodingEvent stream. Used by
// the planner today; the coding runner (#12/#13) plugs in its own
// getEvents/onEvent pair.

interface EventConsoleProps {
  itemId: string;
  getEvents: (itemId: string) => Promise<CodingEventEnvelope[]>;
  onEvent: (itemId: string, callback: (envelope: CodingEventEnvelope) => void) => () => void;
  className?: string;
  /** Wrap the console in a chevron-toggle header (default expanded). The
   *  subscription stays mounted while collapsed so events keep accumulating. */
  collapsible?: boolean;
  /** Initial expanded state when collapsible (default true). */
  defaultOpen?: boolean;
  title?: string;
}

export function EventConsole({
  itemId,
  getEvents,
  onEvent,
  className,
  collapsible,
  defaultOpen = true,
  title,
}: EventConsoleProps) {
  const { t } = useT();
  const c = t.inbox.console;
  const [envelopes, setEnvelopes] = useState<CodingEventEnvelope[]>([]);
  const [open, setOpen] = useState(defaultOpen);
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
    if (el) stuckRef.current = isStuck(el.scrollTop, el.clientHeight, el.scrollHeight);
  };

  const body = (
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
            <div key={e.seq}>
              <EventLine event={e.event} />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (!collapsible) return body;

  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && body}
    </div>
  );
}
