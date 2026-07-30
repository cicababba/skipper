"use client";

import { useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Wrench,
  XCircle,
} from "lucide-react";
import type { CodingEvent } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { ConsoleMarkdown } from "./console-markdown";

// One rendered agent event (#260, lifted out of event-console.tsx): shared by
// the console and the per-turn activity blocks in the chat panel.

export function EventLine({ event }: { event: CodingEvent }) {
  const { t } = useT();
  const c = t.inbox.console;

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
      return <ConsoleMarkdown content={event.text} />;
    // Partial-message increments (#277) drive only the live draft bubble, not
    // the activity console — filtered out upstream, rendered as nothing here.
    case "text-delta":
      return null;
    case "tool-use":
      return <ToolUseLine event={event} />;
    case "result":
      return (
        <div className={`flex items-center gap-2 ${event.ok ? "text-success" : "text-danger"}`}>
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
        <div className="flex items-center gap-2 text-danger">
          <AlertCircle size={13} className="shrink-0" />
          <span className="whitespace-pre-wrap break-words">{event.message}</span>
        </div>
      );
  }
}

// A tool-use line. When the event carries the full input (post-#113 events),
// the header toggles a JSON expand view; older buffered events without input
// degrade to the static single line.
function ToolUseLine({ event }: { event: Extract<CodingEvent, { kind: "tool-use" }> }) {
  const [expanded, setExpanded] = useState(false);
  const header = (
    <>
      <Wrench size={13} className="shrink-0 text-muted" />
      <span>{event.tool}</span>
      {event.detail && <span className="truncate opacity-60">{event.detail}</span>}
    </>
  );

  if (!event.input) return <div className="flex items-center gap-2">{header}</div>;

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left hover:text-foreground transition-colors"
      >
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted" />
        )}
        {header}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-card-hover p-2 text-[11px] whitespace-pre-wrap break-words">
          {event.input}
        </pre>
      )}
    </div>
  );
}
