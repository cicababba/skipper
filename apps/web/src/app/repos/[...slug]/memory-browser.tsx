"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, GitPullRequest, Loader2, Search, ThumbsDown, ThumbsUp } from "lucide-react";
import type { RepoRef, SolutionRecord } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { MemoryRecordView } from "./memory-record";

/**
 * Solutions-memory browser for one repo (#47): lists this repo's captured
 * SolutionRecords (from skipper:memory:list, #46), searchable, each openable
 * for the full plan + diff and deletable for deliberate curation.
 */
export function MemoryBrowser({ repo }: { repo: RepoRef }) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const [records, setRecords] = useState<SolutionRecord[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!window.skipper) return;
    return window.skipper.memory.list(repo).then(setRecords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.owner, repo.name]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = records ?? [];
    if (!q) return list;
    return list.filter(
      (r) => r.title.toLowerCase().includes(q) || String(r.issueNumber).includes(q),
    );
  }, [records, query]);

  const selectedRecord = records?.find((r) => r.itemId === selected) ?? null;

  const remove = async (rec: SolutionRecord) => {
    if (!window.skipper || !window.confirm(m.deleteConfirm)) return;
    setBusy(true);
    try {
      const res = await window.skipper.memory.delete(rec.itemId);
      if (res.ok) {
        setSelected(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  if (selectedRecord) {
    return (
      <MemoryRecordView
        record={selectedRecord}
        busy={busy}
        onBack={() => setSelected(null)}
        onDelete={() => void remove(selectedRecord)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted/50" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={m.search}
          className="w-full bg-background border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </div>

      {records === null ? (
        <div className="flex items-center gap-2 text-xs text-muted py-4">
          <Loader2 size={13} className="animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-[13px] text-muted/60 py-4">{m.empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {filtered.map((rec) => {
            const feedback = rec.feedback ?? { up: 0, down: 0 };
            return (
              <li key={rec.itemId}>
                <button
                  onClick={() => setSelected(rec.itemId)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-card transition-colors"
                >
                  <span className="font-mono text-[12px] text-muted shrink-0">
                    #{rec.issueNumber}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[13px]">{rec.title}</span>
                  <span className="flex items-center gap-1 shrink-0 font-mono text-[11px] text-muted/70">
                    <GitPullRequest size={11} />
                    {rec.pr.number}
                  </span>
                  {(feedback.up > 0 || feedback.down > 0) && (
                    <span className="flex items-center gap-1 shrink-0 text-[11px] text-muted/70">
                      <ThumbsUp size={11} className="text-accent/70" />
                      {feedback.up}
                      <ThumbsDown size={11} className="ml-1" />
                      {feedback.down}
                    </span>
                  )}
                  <ChevronRight size={14} className="shrink-0 text-muted/40" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
