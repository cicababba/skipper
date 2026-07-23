"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CleanWorktreeResult } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

interface CleanWorktreeDialogProps {
  branch: string;
  dirtyFiles: string[];
  onConfirm: () => Promise<CleanWorktreeResult>;
  onDismiss: () => void;
}

// Guarded clean-worktree confirmation (#204): shows the branch, a destructive
// warning, and the exact file list before a reset --hard + clean -fd. Owns the
// busy state so the rail button is a plain trigger. Escape/backdrop dismiss is
// disabled while the call is in flight.
export function CleanWorktreeDialog({
  branch,
  dirtyFiles,
  onConfirm,
  onDismiss,
}: CleanWorktreeDialogProps) {
  const { t } = useT();
  const c = t.inbox.plan.cleanDialog;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onDismiss]);

  const runClean = async () => {
    setBusy(true);
    setError(null);
    const res = await onConfirm();
    if (res.ok) return; // parent unmounts the dialog
    setError(res.error);
    setBusy(false);
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
        <p className="text-[13px] text-muted">{c.body(branch)}</p>

        <div className="space-y-1.5">
          <p className="text-[12px] font-medium text-muted">{c.files(dirtyFiles.length)}</p>
          <ul className="max-h-40 overflow-y-auto rounded-lg border border-border bg-card px-3 py-2 font-mono text-[11px] text-foreground space-y-0.5">
            {dirtyFiles.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        </div>

        {error && <p className="text-[12px] text-red-300 break-words">{error}</p>}

        <button
          onClick={() => void runClean()}
          disabled={busy}
          className="w-full flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {c.confirm}
        </button>

        <button
          onClick={onDismiss}
          disabled={busy}
          className="w-full text-[13px] font-medium px-3 py-2 rounded-lg text-muted hover:text-foreground hover:bg-card transition-colors disabled:opacity-50"
        >
          {c.cancel}
        </button>
      </div>
    </div>
  );
}
