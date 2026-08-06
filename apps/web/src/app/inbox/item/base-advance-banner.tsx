"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { canTransition, displayKey, type TrackedItem } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";

// Base-advance notice (#329): the merge that moved the base, the plan citations
// it touched, and the citations that stopped resolving. Replan is offered only
// where the lifecycle allows it — in-flight coding work is never discarded here.
export function BaseAdvanceBanner({ item }: { item: TrackedItem }) {
  const { t } = useT();
  const { requestTransition } = useOrchestrator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notice = item.baseAdvance;
  if (!notice) return null;
  const b = t.inbox.baseAdvance;
  const misses = notice.newMisses;
  const hasMisses = (misses?.files.length ?? 0) > 0 || (misses?.symbols.length ?? 0) > 0;

  const replan = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await requestTransition(item.id, "planning", b.replanReason);
      if (!result.ok) setError(result.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-warning/25 bg-warning-bg text-warning px-3 py-2 text-sm space-y-2">
      <div className="flex items-center gap-2">
        <AlertTriangle size={14} className="shrink-0" />
        <span className="font-medium">{b.title}</span>
      </div>
      <p className="text-[12px]">{b.merged(notice.mergedKeys.map(displayKey).join(", "))}</p>
      <p className="text-[12px]">{b.reasons[notice.reason]}</p>
      {notice.overlapFiles.length > 0 && (
        <div className="text-[12px] space-y-0.5">
          <p>{b.overlap}</p>
          <ul className="font-mono text-[11px] space-y-0.5">
            {notice.overlapFiles.map((path) => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}
      {hasMisses && misses && (
        <div className="text-[12px] space-y-0.5">
          <p>{b.misses}</p>
          <ul className="font-mono text-[11px] space-y-0.5">
            {[...misses.files, ...misses.symbols].map((entry) => (
              <li key={entry} className="break-all">
                {entry}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canTransition(item.state, "planning") && (
        <button
          onClick={() => void replan()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded border border-warning/25 px-2 py-1 text-[12px] font-medium hover:bg-warning/20 transition-colors disabled:opacity-50"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {b.replan}
        </button>
      )}
      {error && <p className="text-[12px] break-all">{error}</p>}
    </div>
  );
}
