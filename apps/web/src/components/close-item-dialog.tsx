"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import type { CloseItemOnTrackerResult, IssueSourceId, TrackedItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

// Tracker brand names — not translated (proper nouns).
const SOURCE_LABELS: Record<IssueSourceId, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  openproject: "OpenProject",
};

interface CloseItemDialogProps {
  item: TrackedItem;
  canCloseOnTracker: boolean;
  onCloseOnTracker: () => Promise<CloseItemOnTrackerResult>;
  onUntrack: () => Promise<boolean>;
  onOpenInTracker: () => void;
  onDismiss: () => void;
}

// Capability-aware close dialog (#132): "Close on {tracker}" when the source
// supports it, otherwise a link-out; "Remove from Skipper"; Cancel. Presentational
// — all effects come in through the callback props. Escape/backdrop dismiss is
// disabled while a call is in flight.
export function CloseItemDialog({
  item,
  canCloseOnTracker,
  onCloseOnTracker,
  onUntrack,
  onOpenInTracker,
  onDismiss,
}: CloseItemDialogProps) {
  const { t } = useT();
  const c = t.inbox.closeDialog;
  const tracker = SOURCE_LABELS[item.source];
  const [busy, setBusy] = useState<"close" | "untrack" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onDismiss]);

  const runClose = async () => {
    setBusy("close");
    setError(null);
    const res = await onCloseOnTracker();
    if (res.ok) return; // parent unmounts the dialog
    setError(res.error);
    setBusy(null);
  };

  const runUntrack = async () => {
    setBusy("untrack");
    setError(null);
    const ok = await onUntrack();
    if (!ok) setBusy(null); // on success the parent unmounts the dialog
  };

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onDismiss();
      }}
    >
      <div className="relative w-[min(420px,calc(100vw-32px))] animate-pop-in rounded-3xl bg-background border border-border/50 p-6 space-y-4">
        <h2 className="text-lg font-semibold">{c.title}</h2>

        {canCloseOnTracker ? (
          <div className="space-y-1.5">
            <button
              onClick={() => void runClose()}
              disabled={busy !== null}
              className="w-full flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-2 rounded-lg border border-danger/25 bg-danger-bg text-danger hover:bg-danger/20 transition-colors disabled:opacity-50"
            >
              {busy === "close" && <Loader2 size={13} className="animate-spin" />}
              {c.closeOnTracker(tracker)}
            </button>
            <p className="text-[12px] text-muted">{c.closeOnTrackerHint}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[12px] text-muted">{c.noRemoteClose(tracker)}</p>
            <button
              onClick={onOpenInTracker}
              className="w-full flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-2 rounded-lg border border-border bg-card hover:bg-card-hover transition-colors"
            >
              <ExternalLink size={13} />
              {c.openInTracker(tracker)}
            </button>
          </div>
        )}

        <div className="space-y-1.5">
          <button
            onClick={() => void runUntrack()}
            disabled={busy !== null}
            className="w-full flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-2 rounded-lg border border-border bg-card hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            {busy === "untrack" && <Loader2 size={13} className="animate-spin" />}
            {c.untrack}
          </button>
          <p className="text-[12px] text-muted">{c.untrackHint(!!item.worktree, !!item.pr)}</p>
        </div>

        {error && <p className="text-[12px] text-danger break-words">{error}</p>}

        <button
          onClick={onDismiss}
          disabled={busy !== null}
          className="w-full text-[13px] font-medium px-3 py-2 rounded-lg text-muted hover:text-foreground hover:bg-card transition-colors disabled:opacity-50"
        >
          {c.cancel}
        </button>
      </div>
    </div>
  );
}
