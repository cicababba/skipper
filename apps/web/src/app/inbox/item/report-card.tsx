"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import type { StoredCoderReport, TrackedItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

/** The coder's structured report (#146), rendered above the agent-review card.
 *  Best-effort: renders nothing while loading, on error, or when the run
 *  degraded to a prose reason (no coderReport ref). */
export function CoderReportCard({ item }: { item: TrackedItem }) {
  const { t } = useT();
  const r = t.inbox.review;
  const [stored, setStored] = useState<StoredCoderReport | null>(null);

  const ref = item.coderReport?.ref;
  useEffect(() => {
    if (!window.skipper || !ref) return;
    let cancelled = false;
    window.skipper.orchestrator
      .getCoderReport(item.id)
      .then((s) => {
        if (!cancelled) setStored(s);
      })
      .catch(() => {
        if (!cancelled) setStored(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, ref]);

  if (!ref || !stored) return null;
  const report = stored.report;

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-2 text-[12px]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-foreground">{r.coderReport}</span>
        <span className="px-1.5 py-0.5 rounded border bg-card-hover/40 border-border text-[11px]">
          {r.doneFiles(report.done.length)}
        </span>
      </div>

      {report.done.length > 0 && (
        <ul className="space-y-1">
          {report.done.map((d, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="font-mono text-foreground/90 break-all">{d.path}</span>
              {d.summary && <span className="text-muted">— {d.summary}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1 pt-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted/70">
          {r.deviations}
        </div>
        {report.deviations.length > 0 ? (
          <ul className="space-y-1">
            {report.deviations.map((d, i) => (
              <li key={i} className="flex items-start gap-1.5 text-warning">
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning" />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">{r.noDeviations}</p>
        )}
      </div>

      {report.verification.length > 0 && (
        <div className="space-y-1 pt-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted/70">
            {r.verification}
          </div>
          <ul className="space-y-1">
            {report.verification.map((v, i) => (
              <li key={i} className="flex items-start gap-2">
                <span
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] uppercase shrink-0 ${
                    v.passed
                      ? "text-success bg-success-bg border-success/25"
                      : "text-danger bg-danger-bg border-danger/25"
                  }`}
                >
                  {v.passed ? <Check size={11} /> : <X size={11} />}
                  {v.passed ? r.passed : r.failed}
                </span>
                <span className="font-mono text-foreground/90 break-all">{v.command}</span>
                {v.detail && <span className="text-muted">— {v.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.open.length > 0 && (
        <div className="space-y-1 pt-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted/70">
            {r.openPoints}
          </div>
          <ul className="space-y-1">
            {report.open.map((o, i) => (
              <li key={i} className="flex items-start gap-1.5 text-muted">
                <span className="mt-0.5 shrink-0">•</span>
                <span>{o}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
