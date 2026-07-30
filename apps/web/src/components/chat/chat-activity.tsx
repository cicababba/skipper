"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useT } from "@/lib/app-i18n";
import { isStuck } from "@/lib/inbox/chat-format";
import type { ChatTurn } from "@/lib/inbox/chat-turns";
import { EventLine } from "@/components/event-line";

// Per-turn agent activity (#260): what the agent did between the question and
// the answer, inline in the transcript. Open while the turn runs so the
// reasoning is visible, collapsed once it completes.

export function ChatActivity({ turn }: { turn: ChatTurn }) {
  const { t } = useT();
  const c = t.inbox.chat;
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? turn.open;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);

  // Follow activity while the block is open and the user hasn't scrolled away.
  // The inner list clips at max-h-64, so without this new EventLine rows land
  // below the fold and the transcript appears frozen (#275).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !open || !stuckRef.current) return;
    el.scrollTop = el.scrollHeight;
    // Re-pin on async EventLine / markdown reflow that grows the list height
    // after this effect ran.
    const observer = new ResizeObserver(() => {
      if (stuckRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, turn.envelopes.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stuckRef.current = isStuck(el.scrollTop, el.clientHeight, el.scrollHeight);
  };

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setOverride(!open)}
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted/70 hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {turn.open && <Loader2 size={11} className="animate-spin" />}
        {c.activitySteps(turn.envelopes.length)}
      </button>
      {open && turn.envelopes.length > 0 && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="max-h-64 overflow-y-auto rounded-lg border border-card-hover bg-card p-2.5 font-mono text-xs leading-relaxed space-y-1.5"
        >
          {turn.envelopes.map((e) => (
            <div key={e.seq}>
              <EventLine event={e.event} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
