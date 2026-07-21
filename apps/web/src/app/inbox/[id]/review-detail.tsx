"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { EventConsole } from "@/components/event-console";
import { ResumeSessionButton } from "./resume-session";
import { CoderReportCard } from "./report-card";

export function ReviewDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const router = useRouter();
  const { state, requestTransition, openPr } = useOrchestrator();
  const { t } = useT();
  const r = t.inbox.review;

  const item = state?.items.find((i) => i.id === id);
  const live = item?.state === "human-review";

  const [busyAction, setBusyAction] = useState<"openPr" | "close" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const runOpenPr = async () => {
    setBusyAction("openPr");
    setActionError(null);
    try {
      const result = await openPr(id);
      if (result.ok) router.push("/inbox");
      else setActionError(result.error);
    } finally {
      setBusyAction(null);
    }
  };

  const runClose = async () => {
    setBusyAction("close");
    setActionError(null);
    try {
      const result = await requestTransition(id, "closed");
      if (result.ok) router.push("/inbox");
      else setActionError(result.error);
    } finally {
      setBusyAction(null);
    }
  };

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
      <ResumeSessionButton
        itemId={id}
        item={item}
        sessionId={item.review?.sessionId}
        running={item.state === "agent-review"}
      />

      {!live && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 px-3 py-2 text-sm">
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
          {review.objections && review.objections.length > 0 && (
            <ul className="space-y-1 pt-1">
              {review.objections.map((o, i) => (
                <li key={i} className="flex items-start gap-1.5 text-muted">
                  <AlertTriangle
                    size={12}
                    className={`mt-0.5 shrink-0 ${o.blocking ? "text-red-400" : "text-amber-400"}`}
                  />
                  <span>
                    <span className="uppercase text-[10px] text-muted/60 mr-1">{o.kind}</span>
                    {o.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => void runOpenPr()}
            disabled={busyAction !== null || !live}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {busyAction === "openPr" && <Loader2 size={11} className="animate-spin" />}
            {t.inbox.actions.openPr}
          </button>
          <button
            onClick={() => void runClose()}
            disabled={busyAction !== null || !live}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            {busyAction === "close" && <Loader2 size={11} className="animate-spin" />}
            {t.inbox.actions.close}
          </button>
        </div>
        {actionError && <p className="text-[12px] text-red-300 break-all">{actionError}</p>}
      </div>
    </div>
  );
}
