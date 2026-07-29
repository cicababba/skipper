"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderGit2, Loader2, X } from "lucide-react";
import type { ListReposResult } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

// Repo picker behind the topbar "+" (#136). Linked repos only: the composer's
// agent runs in the local checkout, so an unlinked repo has nothing to read.

export function RepoPickerModal({
  onPick,
  onClose,
}: {
  onPick: (repo: { owner: string; name: string }) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const p = t.composer.picker;
  const [repos, setRepos] = useState<ListReposResult["linked"] | null>(null);

  useEffect(() => {
    if (!window.skipper) return;
    let cancelled = false;
    void window.skipper.orchestrator.listRepos().then((res) => {
      if (!cancelled) setRepos(res.linked);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-card shadow-2xl animate-pop-in overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
          <FolderGit2 size={15} className="text-accent shrink-0" />
          <h2 className="text-sm font-medium flex-1">{p.title}</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="px-4 py-3 text-xs text-muted max-h-[60vh] overflow-y-auto">
          <p className="mb-3">{p.desc}</p>
          {repos === null && (
            <div className="flex items-center gap-2 py-3">
              <Loader2 size={13} className="animate-spin" />
            </div>
          )}
          {repos?.length === 0 && <p className="py-2 text-muted/70">{p.empty}</p>}
          <ul className="space-y-1">
            {(repos ?? []).map((repo) => {
              const [owner, name] = repo.key.split("/");
              return (
                <li key={repo.key}>
                  <button
                    onClick={() => onPick({ owner, name })}
                    className="w-full text-left px-2.5 py-1.5 rounded-md text-[12px] text-foreground/90 hover:bg-card-hover transition-colors truncate"
                  >
                    {repo.key}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
          >
            {p.cancel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
