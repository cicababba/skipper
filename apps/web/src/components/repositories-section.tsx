"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, FolderGit2, Loader2, Minus, Plus } from "lucide-react";
import type { RepoSettingsRow } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { FollowPickerModal } from "@/components/follow-picker-modal";

// Settings → Repositories (#15, reworked in #47): the *global* coding WIP
// default plus a directory of linked repos. Per-repo intake config now lives on
// the repo detail page (/repos/owner/name) — this section only delegates to it.
export function RepositoriesSection() {
  const { t } = useT();
  const { state, updateSettings } = useOrchestrator();
  const [rows, setRows] = useState<RepoSettingsRow[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isElectron = typeof window !== "undefined" && !!window.skipper;

  const load = useCallback(() => {
    if (!window.skipper) return;
    return window.skipper.orchestrator.listRepoSettings().then(setRows);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setWipLimit = (value: number) => updateSettings({ codingWipPerRepo: value });

  if (!isElectron) return null;

  const r = t.settings.repositories;
  const wipLimit = state?.settings.codingWipPerRepo ?? 1;

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4 flex items-center gap-2">
        <FolderGit2 size={13} className="text-muted/60" />
        {r.title}
      </h2>

      <div className="p-5 rounded-xl bg-card border border-border space-y-5">
        <p className="text-[11px] text-muted/60 leading-relaxed">{r.desc}</p>

        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium mb-1">{r.wipLimit}</p>
            <p className="text-[11px] text-muted/60 leading-relaxed">{r.wipLimitDesc}</p>
          </div>
          <div className="shrink-0 flex items-center gap-1">
            <button
              onClick={() => void setWipLimit(wipLimit - 1)}
              disabled={wipLimit <= 1}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Minus size={12} />
            </button>
            <span className="w-8 text-center text-sm font-medium tabular-nums">{wipLimit}</span>
            <button
              onClick={() => void setWipLimit(wipLimit + 1)}
              disabled={wipLimit >= 10}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          {rows === null && (
            <div className="flex items-center gap-2 text-xs text-muted py-2">
              <Loader2 size={13} className="animate-spin" />
              {r.loading}
            </div>
          )}

          {rows !== null && rows.length === 0 && (
            <p className="text-xs text-muted py-2">{r.empty}</p>
          )}

          {rows !== null && rows.length > 0 && (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li key={row.key}>
                  <Link
                    href={`/repos/${encodeURIComponent(row.repo.owner)}/${encodeURIComponent(row.repo.name)}`}
                    className="flex items-center gap-3 py-2.5 hover:text-accent transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate" title={row.localPath}>
                        {row.repo.owner}/{row.repo.name}
                      </p>
                      <p className="text-[10px] text-muted/60">
                        {row.linked ? r.linked : r.notLinked}
                      </p>
                    </div>
                    <ChevronRight size={14} className="shrink-0 text-muted/40" />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted/60">{r.followNote}</p>
            <button
              onClick={() => setPickerOpen(true)}
              className="shrink-0 h-7 px-3 rounded-md text-xs border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
            >
              {r.fetchFromGitHub}
            </button>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <FollowPickerModal
          onClose={() => {
            setPickerOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}
