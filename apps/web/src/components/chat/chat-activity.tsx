"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useT } from "@/lib/app-i18n";
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

  // Streamed reply increments (#277) belong to the draft bubble, not the step
  // log — exclude them so they neither flood the list nor inflate the count.
  const steps = turn.envelopes.filter((e) => e.event.kind !== "text-delta");

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setOverride(!open)}
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted/70 hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {turn.open && <Loader2 size={11} className="animate-spin" />}
        {c.activitySteps(steps.length)}
      </button>
      {open && steps.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-card-hover bg-card p-2.5 font-mono text-xs leading-relaxed space-y-1.5">
          {steps.map((e) => (
            <div key={e.seq}>
              <EventLine event={e.event} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
