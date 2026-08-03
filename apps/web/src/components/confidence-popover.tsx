"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import type { ConfidenceReport, TrackedItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

export function bandClasses(score: number): string {
  if (score >= 0.75) return "bg-success-bg text-success border-success/25";
  if (score >= 0.5) return "bg-warning-bg text-warning border-warning/25";
  return "bg-card text-muted border-border";
}

export function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

const POPOVER_WIDTH = 320;

export function ConfidenceBadge({ item }: { item: TrackedItem }) {
  const { t } = useT();
  const composite = item.plan?.confidence;
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ConfidenceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const openPopover = useCallback(async () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      top: Math.min(rect.bottom + 6, window.innerHeight - 24),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8)),
    });
    setOpen(true);
    setLoading(true);
    setLoadError(false);
    setReport(null);
    try {
      // Always refetch: a replan rewrites the stored plan under the same ref.
      const stored = await window.skipper?.orchestrator.getPlan(item.id);
      setReport(stored?.confidence ?? null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [item.id]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const rescoring = item.plan?.rescoring;

  if (composite === undefined) {
    return rescoring ? (
      <Loader2 size={13} className="animate-spin text-muted/60" />
    ) : (
      <span className="text-muted/40 text-sm">—</span>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => (open ? setOpen(false) : void openPopover())}
        className={`text-[11px] font-medium px-1.5 py-0.5 rounded border transition-colors hover:brightness-125 ${bandClasses(composite)}${rescoring ? " animate-pulse" : ""}`}
      >
        {pct(composite)}
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
            className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-card shadow-2xl p-3 space-y-3 text-[12px]"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{t.inbox.popover.composite}</span>
              <span
                className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${bandClasses(composite)}`}
              >
                {pct(report?.composite ?? composite)}
              </span>
            </div>
            {loading && (
              <div className="flex items-center gap-2 text-muted">
                <Loader2 size={13} className="animate-spin" />
              </div>
            )}
            {!loading && loadError && (
              <p className="text-danger">{t.inbox.popover.loadFailed}</p>
            )}
            {!loading && !loadError && !report && (
              <p className="text-muted">{t.inbox.popover.reportUnavailable}</p>
            )}
            {!loading && report && <ReportBody report={report} />}
          </div>,
          document.body,
        )}
    </>
  );
}

function SignalSection({
  title,
  score,
  children,
}: {
  title: string;
  score: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground/90">{title}</span>
        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${bandClasses(score)}`}
        >
          {pct(score)}
        </span>
      </div>
      {children}
    </div>
  );
}

function TruncatedList({ label, entries }: { label: string; entries: string[] }) {
  const { t } = useT();
  if (entries.length === 0) return null;
  const shown = entries.slice(0, 5);
  return (
    <p className="text-muted break-all">
      {label}: {shown.join(", ")}
      {entries.length > shown.length && ` +${entries.length - shown.length} ${t.inbox.popover.more}`}
    </p>
  );
}

export function ReportBody({ report }: { report: ConfidenceReport }) {
  const { t } = useT();
  const p = t.inbox.popover;
  const { groundedness, convergence, critic, clarity } = report.signals;
  const flag = (v: boolean) => (v ? p.yes : p.no);
  return (
    <>
      {groundedness && (
        <SignalSection title={p.groundedness} score={groundedness.score}>
          <p className="text-muted">
            {p.files}: {groundedness.filesFound}/{groundedness.filesChecked} · {p.symbols}:{" "}
            {groundedness.symbolsFound}/{groundedness.symbolsChecked}
            {groundedness.newFiles.length > 0 && ` · ${groundedness.newFiles.length} ${p.newFiles}`}
          </p>
          <TruncatedList
            label={p.missing}
            entries={[...groundedness.missingFiles, ...groundedness.missingSymbols]}
          />
        </SignalSection>
      )}
      {convergence && (
        <SignalSection title={p.convergence} score={convergence.score}>
          <p className="text-muted">
            {convergence.planCount} {p.plans} · jaccard {convergence.fileJaccard.toFixed(2)}
          </p>
          {convergence.divergent && (
            <p className="text-warning font-medium">{p.divergent}</p>
          )}
          <TruncatedList label={p.disputed} entries={convergence.disputedFiles} />
        </SignalSection>
      )}
      {!convergence && report.convergenceSkipped && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground/90">{p.convergence}</span>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-border text-muted">
              {p.convergenceSkipped}
            </span>
          </div>
          <p className="text-muted">{report.convergenceSkipped.detail}</p>
        </div>
      )}
      {critic && (
        <SignalSection title={p.critic} score={critic.score}>
          <p
            className={
              critic.verdict === "approve"
                ? "text-success"
                : critic.verdict === "concerns"
                  ? "text-warning"
                  : "text-danger"
            }
          >
            {p.verdicts[critic.verdict]}
          </p>
          {critic.objections.slice(0, 5).map((o, i) => (
            <p key={i} className="text-muted">
              <span className="text-[10px] uppercase tracking-wide text-muted/60">{o.kind}</span>
              {o.blocking && (
                <span className="ml-1 text-[10px] uppercase tracking-wide text-danger">
                  {p.blocking}
                </span>
              )}
              {o.unverified && (
                <span className="ml-1 text-[10px] uppercase tracking-wide text-muted/60">
                  {p.unverified}
                </span>
              )}{" "}
              {o.detail}
            </p>
          ))}
        </SignalSection>
      )}
      {clarity && (
        <SignalSection title={p.clarity} score={clarity.score}>
          <p className="text-muted">
            {p.body}: {flag(clarity.bodyPresent)} · {p.acceptanceCriteria}:{" "}
            {flag(clarity.hasAcceptanceCriteria)} · {p.reproSteps}: {flag(clarity.hasReproSteps)} ·{" "}
            {p.openQuestions}: {clarity.openQuestionCount}
          </p>
        </SignalSection>
      )}
      <div className="pt-2 border-t border-border space-y-1">
        <p className="text-[10px] uppercase tracking-wide text-muted/60">{p.weights}</p>
        <p className="text-muted">
          {p.groundedness} {pct(report.weights.groundedness)} · {p.convergence}{" "}
          {pct(report.weights.convergence)} · {p.critic} {pct(report.weights.critic)} · {p.clarity}{" "}
          {pct(report.weights.clarity)}
        </p>
        {report.errors.length > 0 && (
          <>
            <p className="text-[10px] uppercase tracking-wide text-muted/60">{p.errors}</p>
            {report.errors.map((e, i) => (
              <p key={i} className="text-danger/80 break-all">
                {e}
              </p>
            ))}
          </>
        )}
        <p className="text-[10px] text-muted/50">
          {p.computedAt}: {new Date(report.computedAt).toLocaleString()}
        </p>
      </div>
    </>
  );
}
