"use client";

import { Loader2 } from "lucide-react";

/** One label + hint + control line, shared by the repo settings sections. */
export function Row({
  label,
  hint,
  busy,
  children,
}: {
  label: string;
  hint?: string;
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium flex items-center gap-2">
          {label}
          {busy && <Loader2 size={12} className="animate-spin text-muted" />}
        </p>
        {hint && <p className="text-[11px] text-muted/60 leading-relaxed mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** The select styling every repo settings control shares. */
export const selectClass =
  "bg-background border border-border rounded-md px-2 py-1.5 text-sm focus:border-accent focus:outline-none disabled:opacity-50";
