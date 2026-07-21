"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { useT } from "@/lib/app-i18n";
import { pct } from "@/components/confidence-popover";
import { EventConsole } from "@/components/event-console";
import { formatDuration, type TimelineEntry } from "@/lib/inbox/timeline";

// Overview timeline (#169): the item's history top-to-bottom. Each role's latest
// run embeds its live console; superseded runs collapse to a placeholder, review
// rounds to a light pointer.
export function OverviewTimeline({
  entries,
  itemId,
  onNavigateTab,
}: {
  entries: TimelineEntry[];
  itemId: string;
  onNavigateTab: (tab: "review") => void;
}) {
  const { t } = useT();
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted/70 mb-3">
        {t.inbox.overview.timeline}
      </p>
      <ol>
        {entries.map((entry, i) => (
          <TimelineRow
            key={entry.id}
            entry={entry}
            itemId={itemId}
            last={i === entries.length - 1}
            onNavigateTab={onNavigateTab}
          />
        ))}
      </ol>
    </div>
  );
}

function TimelineRow({
  entry,
  itemId,
  last,
  onNavigateTab,
}: {
  entry: TimelineEntry;
  itemId: string;
  last: boolean;
  onNavigateTab: (tab: "review") => void;
}) {
  const { t } = useT();
  const o = t.inbox.overview;
  const artifact = entry.artifact;

  const label = entry.tracked
    ? o.tracked
    : artifact?.kind === "plan-revision"
      ? artifact.source === "chat-apply"
        ? o.planRevisedChat
        : o.planEdited
      : entry.state
        ? t.inbox.states[entry.state]
        : "";

  const duration =
    entry.durationMs != null && entry.durationMs > 0 ? formatDuration(entry.durationMs) : null;

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center shrink-0">
        <span
          className={`mt-1.5 h-2 w-2 rounded-full ${
            entry.current ? "bg-accent" : "border border-muted/50"
          }`}
        />
        {!last && <span className="w-px flex-1 bg-border my-1" />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-4"}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-foreground">{label}</span>
          {duration && <span className="text-[11px] text-muted/60">{duration}</span>}
        </div>
        {entry.reason && <p className="text-[12px] text-muted mt-0.5 break-words">{entry.reason}</p>}

        {artifact?.kind === "planner-console" && (
          <RoleConsole
            itemId={itemId}
            live={entry.live}
            latestRun={artifact.latestRun}
            channel="planning"
            title={t.inbox.states.planning}
            meta={
              artifact.model
                ? `${o.model} ${artifact.model}${
                    artifact.confidencePct != null ? ` · ${pct(artifact.confidencePct)}` : ""
                  }`
                : undefined
            }
          />
        )}
        {artifact?.kind === "coder-console" && (
          <RoleConsole
            itemId={itemId}
            live={entry.live}
            latestRun={artifact.latestRun}
            channel="coding"
            title={t.inbox.states.coding}
          />
        )}
        {artifact?.kind === "reviewer-console" && (
          <RoleConsole
            itemId={itemId}
            live={entry.live}
            latestRun={artifact.latestRun}
            channel="review"
            title={t.inbox.states["agent-review"]}
          />
        )}
        {artifact?.kind === "review-round" && (
          <div className="flex items-center gap-2 flex-wrap text-[12px] mt-1">
            <span className="text-muted">{o.round(artifact.round)}</span>
            {artifact.failed && (
              <span className="inline-flex items-center gap-1 text-amber-300">
                <AlertTriangle size={12} className="shrink-0" />
                {o.roundFailed}
              </span>
            )}
            <button
              onClick={() => onNavigateTab("review")}
              className="inline-flex items-center gap-1 text-muted hover:text-accent transition-colors"
            >
              {o.seeReview}
              <ArrowRight size={12} />
            </button>
          </div>
        )}
        {artifact?.kind === "plan-revision" && (
          <div className="flex items-center gap-2 flex-wrap text-[12px] mt-0.5">
            {artifact.source === "chat-apply" && artifact.messageCount != null && (
              <span className="text-muted">{o.messages(artifact.messageCount)}</span>
            )}
            {artifact.beforePct != null && (
              <span className="text-muted/80">
                {pct(artifact.beforePct)} → {pct(artifact.afterPct ?? artifact.beforePct)}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function RoleConsole({
  itemId,
  live,
  latestRun,
  channel,
  title,
  meta,
}: {
  itemId: string;
  live: boolean;
  latestRun: boolean;
  channel: "planning" | "coding" | "review";
  title: string;
  meta?: string;
}) {
  const { t } = useT();
  const skipper = window.skipper;
  const pair = latestRun && skipper ? skipper[channel] : null;

  // Event buffers are in-memory and die on restart. Probe the buffer once so a
  // finished run whose events are gone degrades to the placeholder instead of a
  // live-looking "waiting for the agent…". A running role (live) legitimately
  // waits, so it always mounts the console.
  const [hasEvents, setHasEvents] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pair || live) return;
    let cancelled = false;
    pair
      .getEvents(itemId)
      .then((events) => {
        if (!cancelled) setHasEvents(events.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasEvents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pair, itemId, live]);

  const placeholder = (
    <p className="text-[12px] text-muted/60 mt-1">{t.inbox.overview.eventsUnavailable}</p>
  );

  if (!pair) return placeholder;
  if (!live) {
    if (hasEvents === null) return null;
    if (!hasEvents) return placeholder;
  }
  return (
    <div className="mt-2 space-y-1">
      {meta && <p className="text-[11px] text-muted/60">{meta}</p>}
      <EventConsole
        itemId={itemId}
        getEvents={pair.getEvents}
        onEvent={pair.onEvent}
        collapsible
        defaultOpen={live}
        title={title}
      />
    </div>
  );
}
