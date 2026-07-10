"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Loader2, CheckCircle2, AlertCircle, Download } from "lucide-react";
import { useT } from "@/lib/app-i18n";

// Settings → Updates. Shows the auto-update status and a manual check.
// Source builds (no channel key) see a short note instead of controls.
export function UpdatesSection() {
  const { t } = useT();
  const [state, setState] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const updates = typeof window !== "undefined" ? window.nestbrain?.updates : null;
    if (!updates) return;
    updates.getState().then(setState).catch(() => {});
    const off = updates.onStateChanged(setState);
    return () => off?.();
  }, []);

  if (!state) return null;

  async function checkNow() {
    setChecking(true);
    try { setState(await window.nestbrain!.updates.check()); } catch { /* state event covers it */ }
    setChecking(false);
  }

  let body: React.ReactNode;
  if (state.status === "disabled") {
    body = (
      <p className="text-[12px] text-muted/60 leading-relaxed">
        {t.settings.updates.sourceNoteBefore}{" "}
        <code className="text-accent/70 bg-accent/5 px-1 rounded">git pull</code>
        {t.settings.updates.sourceNoteAfter}
      </p>
    );
  } else if (state.status === "dev") {
    body = <p className="text-[12px] text-muted/60">{t.settings.updates.devNote}</p>;
  } else {
    body = (
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-muted/70 flex items-center gap-2 min-w-0">
          {state.status === "checking" && (<><Loader2 size={13} className="animate-spin text-accent" /> {t.settings.updates.checking}</>)}
          {state.status === "downloading" && (<><Download size={13} className="text-accent" /> {t.settings.updates.downloading(state.available ?? "", state.percent ?? 0)}</>)}
          {state.status === "ready" && (<><CheckCircle2 size={13} className="text-green-400" /> {t.settings.updates.ready(state.available ?? "")}</>)}
          {state.status === "error" && (<><AlertCircle size={13} className="text-amber-400" /> <span className="truncate">{t.settings.updates.checkFailed(state.error ?? "")}</span></>)}
          {state.status === "idle" && (
            <>
              <CheckCircle2 size={13} className="text-green-500/70" /> {t.settings.updates.upToDate(state.current ?? "")}
              {state.via === "account" && <span className="text-muted/40">{t.settings.updates.viaAccount}</span>}
            </>
          )}
        </div>
        {state.status === "ready" ? (
          <button
            onClick={() => void window.nestbrain!.updates.restart()}
            className="shrink-0 px-3 h-8 rounded-md bg-accent text-background text-xs font-medium hover:bg-accent-hover transition-colors"
          >
            {t.settings.updates.restartNow}
          </button>
        ) : (
          <button
            onClick={checkNow}
            disabled={checking || state.status === "downloading"}
            className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-background hover:bg-card-hover text-xs transition-colors disabled:opacity-40"
          >
            <RefreshCw size={11} className={checking ? "animate-spin" : ""} />
            {t.settings.updates.checkNow}
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4 flex items-center gap-2">
        <RefreshCw size={13} className="text-muted/60" />
        {t.settings.updates.title}
      </h2>
      <div className="p-5 rounded-xl bg-card border border-border">{body}</div>
    </section>
  );
}
