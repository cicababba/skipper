"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Inbox, Loader2, Plus, RefreshCw } from "lucide-react";
import type { AgentReview, CriticObjection } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { buildReviewChangelog, hasReviewChangelog, type ReviewChangelogEntry } from "@/lib/inbox/review-changelog";
import { EventConsole } from "@/components/event-console";
import { CoderReportCard } from "./report-card";
import { BaseAdvanceBanner } from "./base-advance-banner";
import { useItemId } from "./use-item-id";

function ObjectionRow({ o }: { o: CriticObjection }) {
  const { t } = useT();
  return (
    <li className="flex items-start gap-1.5 text-muted">
      <AlertTriangle
        size={12}
        className={`mt-0.5 shrink-0 ${o.blocking ? "text-danger" : "text-warning"}`}
      />
      <span>
        <span className="uppercase text-[10px] text-muted/60 mr-1">{o.kind}</span>
        {o.unverified && (
          <span className="uppercase text-[10px] tracking-wide text-muted/60 mr-1">
            {t.inbox.popover.unverified}
          </span>
        )}
        {o.detail}
      </span>
    </li>
  );
}

function ObjectionGroup({
  icon,
  label,
  objections,
}: {
  icon: React.ReactNode;
  label: string;
  objections: CriticObjection[];
}) {
  if (objections.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        {icon}
        <span>{label}</span>
        <span className="text-muted/60 tabular-nums">{objections.length}</span>
      </div>
      <ul className="space-y-1 pl-1">
        {objections.map((o, i) => (
          <ObjectionRow key={i} o={o} />
        ))}
      </ul>
    </div>
  );
}

function EntryGroups({ entry }: { entry: ReviewChangelogEntry }) {
  const { t } = useT();
  const c = t.inbox.review.changelog;
  return (
    <div className="space-y-2 pt-1">
      <ObjectionGroup
        icon={<Check size={12} className="text-success" />}
        label={c.resolved}
        objections={entry.resolved}
      />
      <ObjectionGroup
        icon={<RefreshCw size={12} className="text-warning" />}
        label={c.persisting}
        objections={entry.persisting}
      />
      <ObjectionGroup
        icon={<Plus size={12} className="text-foreground" />}
        label={c.added}
        objections={entry.added}
      />
    </div>
  );
}

function PreviousRounds({ entries }: { entries: ReviewChangelogEntry[] }) {
  const [open, setOpen] = useState(false);
  const { t } = useT();
  const c = t.inbox.review.changelog;
  return (
    <div className="border-t border-border/50 pt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-left"
      >
        <span className="text-muted">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-[12px] text-foreground">{c.previousRounds}</span>
        <span className="text-[11px] text-muted tabular-nums">{entries.length}</span>
      </button>
      {open && (
        <div className="space-y-3 pl-6 pt-1">
          {entries.map((e) => (
            <div key={e.ordinal} className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted/70">
                {c.round(e.ordinal)}: {e.outcome}
              </div>
              <EntryGroups entry={e} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewChangelogBody({ review }: { review: AgentReview }) {
  const changelog = buildReviewChangelog(review);
  const latest = changelog[changelog.length - 1];
  const earlier = changelog.slice(0, -1);
  return (
    <>
      {latest && <EntryGroups entry={latest} />}
      {earlier.length > 0 && <PreviousRounds entries={earlier} />}
    </>
  );
}

function FlatObjections({ objections }: { objections: CriticObjection[] }) {
  return (
    <ul className="space-y-1 pt-1">
      {objections.map((o, i) => (
        <ObjectionRow key={i} o={o} />
      ))}
    </ul>
  );
}

export function ReviewDetailView() {
  const id = useItemId();
  const { state } = useOrchestrator();
  const { t } = useT();
  const r = t.inbox.review;

  const item = state?.items.find((i) => i.id === id);
  const live = item?.state === "human-review";

  const isElectron = typeof window !== "undefined" && !!window.skipper;

  if (!isElectron) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <Inbox size={40} className="opacity-30" />
        <p className="text-sm text-muted max-w-md">{t.inbox.empty.desktopOnly}</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted">
        <Loader2 size={16} className="animate-spin" />
        {t.inbox.empty.loading}
      </div>
    );
  }

  if (!item) return null;

  const review = item.review;

  return (
    <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
      <BaseAdvanceBanner item={item} />

      {!live && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/25 bg-warning-bg text-warning px-3 py-2 text-sm">
          <AlertTriangle size={14} className="shrink-0" />
          {r.leftReview}
        </div>
      )}

      {window.skipper && (
        <EventConsole
          itemId={id}
          getEvents={window.skipper.review.getEvents}
          onEvent={window.skipper.review.onEvent}
          collapsible
          title={r.agentReview}
        />
      )}

      <CoderReportCard item={item} />

      {review && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-1.5 text-[12px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground">{r.agentReview}</span>
            <span className="px-1.5 py-0.5 rounded border bg-card-hover/40 border-border uppercase text-[11px]">
              {review.outcome}
            </span>
            <span className="text-muted">
              {review.rounds} {r.rounds}
            </span>
          </div>
          {review.reason && <p className="text-muted">{review.reason}</p>}
          {hasReviewChangelog(review) ? (
            <ReviewChangelogBody review={review} />
          ) : (
            review.objections &&
            review.objections.length > 0 && <FlatObjections objections={review.objections} />
          )}
        </div>
      )}
    </div>
  );
}
