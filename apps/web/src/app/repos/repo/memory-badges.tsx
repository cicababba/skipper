"use client";

import type { SolutionRecord } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { isStale, type PruneReason } from "@/lib/inbox/memory-review";

/** Renders nothing unless the record's files are mostly gone at the base ref (#256). */
export function StalenessBadge({ record }: { record: SolutionRecord }) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  if (!isStale(record)) return null;
  const pct = Math.round((record.staleness ?? 0) * 100);
  const when = record.stalenessCheckedAt
    ? new Date(record.stalenessCheckedAt).toLocaleDateString()
    : "—";
  return (
    <span
      className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border border-warning/25 bg-warning-bg text-warning whitespace-nowrap"
      title={m.staleTooltip(pct, when)}
    >
      {m.staleBadge}
    </span>
  );
}

export function ReasonBadges({ reasons }: { reasons: PruneReason[] }) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const label: Record<PruneReason, string> = {
    "negative-feedback": m.reasonNegative,
    unused: m.reasonUnused,
    stale: m.reasonStale,
  };
  return (
    <>
      {reasons.map((reason) => (
        <span
          key={reason}
          className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-warning/25 text-warning/90 whitespace-nowrap"
        >
          {label[reason]}
        </span>
      ))}
    </>
  );
}
