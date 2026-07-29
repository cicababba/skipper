"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Play, Send, Trash2 } from "lucide-react";
import { repoKey, type ComposerDraftListItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { formatAge } from "@/lib/inbox/table";
import { composeHref } from "@/lib/inbox/nav";

// Saved composer drafts (#138). Resume and Publish land on the same route — the
// composer with the draft rehydrated; the difference is what the user came to do
// there, and the preview stays their last word before anything reaches a tracker.

export function DraftsView() {
  const { t } = useT();
  const d = t.drafts;
  const router = useRouter();

  const [items, setItems] = useState<ComposerDraftListItem[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!window.skipper) return;
    void window.skipper.drafts.list().then(setItems);
  }, []);

  useEffect(() => {
    load();
    return window.skipper?.drafts.onChanged(load);
  }, [load]);

  const remove = async (draftId: string) => {
    if (!window.skipper) return;
    setBusy(draftId);
    try {
      await window.skipper.drafts.remove(draftId);
      setConfirming(null);
      load();
    } finally {
      setBusy(null);
    }
  };

  const isElectron = typeof window !== "undefined" && !!window.skipper;

  return (
    <div className="min-h-full p-6 space-y-6">
      <div className="flex items-center gap-3">
        <FileText size={20} className="text-accent shrink-0" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{d.title}</h1>
          <p className="text-[12px] text-muted">{d.subtitle}</p>
        </div>
      </div>

      {!isElectron ? (
        <EmptyState message={d.desktopOnly} />
      ) : items === null ? (
        <div className="flex justify-center py-24">
          <Loader2 size={20} className="animate-spin text-muted/50" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState message={d.empty} hint={d.emptyHint} />
      ) : (
        <div className="rounded-lg border border-card-hover bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card border-b border-card-hover">
              <tr>
                <Header label={d.colDraft} />
                <Header label={d.colRepo} />
                <Header label={d.colUpdated} />
                <Header label={d.colActions} />
              </tr>
            </thead>
            <tbody className="divide-y divide-card-hover">
              {items.map((item) => {
                const href = composeHref(item.repo, undefined, item.draftId);
                return (
                  <tr key={item.draftId} className="hover:bg-card-hover/50 transition-colors">
                    <td className="px-3 py-2.5 max-w-[420px]">
                      <button
                        onClick={() => router.push(href)}
                        className="text-left hover:text-accent transition-colors truncate w-full"
                        title={item.title || d.untitled}
                      >
                        <span className={item.title ? "" : "text-muted"}>
                          {item.title || d.untitled}
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-muted whitespace-nowrap">
                      {repoKey(item.repo)}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-muted">
                      <Age iso={item.updatedAt} />
                    </td>
                    <td className="px-3 py-2.5">
                      {confirming === item.draftId ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] text-muted">{d.deleteConfirm}</span>
                          <button
                            onClick={() => void remove(item.draftId)}
                            disabled={busy === item.draftId}
                            className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-danger/25 text-danger hover:bg-danger/10 transition-colors disabled:opacity-40"
                          >
                            {busy === item.draftId ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Trash2 size={12} />
                            )}
                            {d.deleteYes}
                          </button>
                          <button
                            onClick={() => setConfirming(null)}
                            className="text-[12px] px-2 py-1 rounded-md border border-border text-muted hover:text-foreground transition-colors"
                          >
                            {d.deleteNo}
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => router.push(href)}
                            className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-border text-muted hover:text-foreground transition-colors"
                          >
                            <Play size={12} />
                            {d.resume}
                          </button>
                          <button
                            onClick={() => router.push(href)}
                            className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                          >
                            <Send size={12} />
                            {d.publish}
                          </button>
                          <button
                            onClick={() => setConfirming(item.draftId)}
                            className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-danger/25 text-danger hover:bg-danger/10 transition-colors"
                          >
                            <Trash2 size={12} />
                            {d.delete}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Header({ label }: { label: string }) {
  return (
    <th className="text-left font-medium text-[11px] uppercase tracking-wide text-muted/70 px-3 py-2">
      {label}
    </th>
  );
}

function Age({ iso }: { iso: string }) {
  const { t } = useT();
  const { value, unit } = formatAge(iso, new Date());
  return (
    <span className="whitespace-nowrap">
      {value}
      {t.inbox.age[unit]}
    </span>
  );
}

function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <FileText size={40} className="opacity-30" />
      <p className="text-sm text-muted max-w-md">{message}</p>
      {hint && <p className="text-[12px] text-muted/60 max-w-md">{hint}</p>}
    </div>
  );
}
