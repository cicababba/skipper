"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Inbox, Loader2 } from "lucide-react";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";

// One-shot resume-rite prompt (#15): shown after intake resumes with parked
// issues admitted. Any choice — including "I'll pick" — clears the rite; the
// unplanned items stay in triage with auto-plan held.
export function ResumeRiteModal() {
  const { t } = useT();
  const { state, resolveResumeRite } = useOrchestrator();
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const riteIds = state?.resumeRite?.itemIds;
  const items = useMemo(() => {
    if (!riteIds || !state) return [];
    return state.items.filter((i) => riteIds.includes(i.id) && i.state === "triage");
  }, [riteIds, state]);

  // Reset per rite; default: all checked.
  useEffect(() => {
    setChoosing(false);
    setSelected(new Set(items.map((i) => i.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riteIds?.join(",")]);

  // Rite whose items all closed/moved meanwhile: nothing to decide.
  useEffect(() => {
    if (riteIds && riteIds.length > 0 && items.length === 0) {
      void resolveResumeRite("dismiss");
    }
  }, [riteIds, items.length, resolveResumeRite]);

  if (!mounted || !riteIds || items.length === 0) return null;

  const act = async (action: "plan-all" | "plan-selected" | "dismiss") => {
    setBusy(true);
    try {
      await resolveResumeRite(action, action === "plan-selected" ? [...selected] : undefined);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-card shadow-2xl animate-pop-in overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
          <Inbox size={16} className="text-accent shrink-0" />
          <h2 className="text-sm font-medium">
            {items.length} {t.inbox.rite.title}
          </h2>
        </div>
        <div className="px-4 py-3 text-xs text-muted">
          <p>{t.inbox.rite.body}</p>
          <p className="mt-1 text-muted/70">{t.inbox.rite.note}</p>
          {choosing && (
            <ul className="mt-3 max-h-56 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {items.map((item) => (
                <li key={item.id}>
                  <label className="flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-card-hover">
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="text-foreground truncate">{item.title}</span>
                    <span className="ml-auto shrink-0 text-muted/70">
                      {item.repo.owner}/{item.repo.name}#{item.number}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          {busy && <Loader2 size={13} className="animate-spin text-muted" />}
          <button
            onClick={() => void act("dismiss")}
            disabled={busy}
            className="h-7 px-3 rounded-md text-xs text-muted hover:text-foreground hover:bg-card-hover transition-colors"
          >
            {t.inbox.rite.illPick}
          </button>
          {choosing ? (
            <button
              onClick={() => void act("plan-selected")}
              disabled={busy || selected.size === 0}
              className="h-7 px-3 rounded-md text-xs font-medium bg-accent text-background hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {t.inbox.rite.planSelected} ({selected.size})
            </button>
          ) : (
            <>
              <button
                onClick={() => setChoosing(true)}
                disabled={busy}
                className="h-7 px-3 rounded-md text-xs border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
              >
                {t.inbox.rite.choose}
              </button>
              <button
                onClick={() => void act("plan-all")}
                disabled={busy}
                className="h-7 px-3 rounded-md text-xs font-medium bg-accent text-background hover:bg-accent-hover transition-colors"
              >
                {t.inbox.rite.planAll}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
