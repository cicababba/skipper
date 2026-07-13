"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Inbox, Loader2, Pause, RefreshCw, X } from "lucide-react";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { RepoManagerModal } from "@/components/repo-manager-modal";
import { useT } from "@/lib/app-i18n";
import { useStoredState } from "@/lib/use-stored-state";
import { KANBAN_COLUMNS, type ColumnId } from "@/lib/inbox/model";
import { filterItems, sortItems, type SortDir, type SortKey } from "@/lib/inbox/table";
import { InboxTable } from "./inbox-table";
import { InboxKanban } from "./inbox-kanban";

const VIEW_KEY = "nestbrain-inbox-view";

type ViewMode = "table" | "kanban";
type ColumnFilter = ColumnId | "attention";

const CONFIDENCE_THRESHOLDS = [0.5, 0.75] as const;

export function InboxView() {
  const { state, error, refreshing, refresh, clearError } = useOrchestrator();
  const { t } = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const repo = searchParams.get("repo");

  const [storedView, setStoredView] = useStoredState(VIEW_KEY, "table");
  const view: ViewMode = storedView === "kanban" ? "kanban" : "table";
  const [sortKey, setSortKey] = useState<SortKey>("age");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [columns, setColumns] = useState<Set<ColumnFilter>>(new Set());
  const [minConfidence, setMinConfidence] = useState<number | undefined>(undefined);
  const [reposOpen, setReposOpen] = useState(false);

  const switchView = (mode: ViewMode) => setStoredView(mode);

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "confidence" || key === "age" ? "desc" : "asc");
    }
  };

  const toggleColumn = (id: ColumnFilter) => {
    setColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visible = useMemo(() => {
    if (!state) return [];
    const filtered = filterItems(state.items, {
      repo: repo ?? undefined,
      columns: view === "table" ? columns : undefined,
      minConfidence,
    });
    return view === "table" ? sortItems(filtered, sortKey, sortDir) : filtered;
  }, [state, repo, view, columns, minConfidence, sortKey, sortDir]);

  const isElectron = typeof window !== "undefined" && !!window.nestbrain;

  return (
    <div className="min-h-full p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Inbox size={22} className="text-accent" />
          <h1 className="text-2xl font-semibold tracking-tight">{t.inbox.title}</h1>
        </div>
        {repo && (
          <button
            onClick={() => router.push("/inbox")}
            className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-full border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            {repo}
            <X size={12} />
          </button>
        )}
        <div className="flex-1" />
        {state?.intakePaused && (
          <span className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full border border-amber-500/20 bg-amber-500/10 text-amber-300">
            <Pause size={12} />
            {t.inbox.intake.paused}
            {state.parkedCount > 0 && ` · ${state.parkedCount} ${t.inbox.intake.queued}`}
          </span>
        )}
        <div className="flex items-center rounded-lg border border-border overflow-hidden">
          {(["table", "kanban"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => switchView(mode)}
              className={`px-3 py-1.5 text-[12px] font-medium transition-colors ${
                view === mode
                  ? "bg-accent/10 text-accent"
                  : "text-muted hover:text-foreground hover:bg-card"
              }`}
            >
              {t.inbox.views[mode]}
            </button>
          ))}
        </div>
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="p-2 rounded-lg border border-border text-muted hover:text-foreground hover:bg-card transition-colors disabled:opacity-50"
          title={t.common.actions.refresh}
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Error strip */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2 text-sm">
          <span className="flex-1 break-all">{error}</span>
          <button onClick={clearError} className="shrink-0 hover:text-red-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Filter row (table only) */}
      {view === "table" && state && state.items.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {(["attention", ...KANBAN_COLUMNS.map((c) => c.id)] as ColumnFilter[]).map((id) => (
            <button
              key={id}
              onClick={() => toggleColumn(id)}
              className={`px-2 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                columns.has(id)
                  ? id === "attention"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                    : "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted hover:text-foreground hover:bg-card"
              }`}
            >
              {t.inbox.columns[id]}
            </button>
          ))}
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            {t.inbox.filters.minConfidence}
            <select
              value={minConfidence ?? ""}
              onChange={(e) =>
                setMinConfidence(e.target.value === "" ? undefined : Number(e.target.value))
              }
              className="bg-card border border-border rounded-md px-1.5 py-1 text-[11px] text-foreground focus:outline-none focus:border-accent/60"
            >
              <option value="">{t.inbox.filters.any}</option>
              {CONFIDENCE_THRESHOLDS.map((v) => (
                <option key={v} value={v}>
                  ≥ {Math.round(v * 100)}%
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Body */}
      {!isElectron ? (
        <EmptyState message={t.inbox.empty.desktopOnly} />
      ) : !state ? (
        <div className="flex items-center justify-center gap-2 py-24 text-muted">
          <Loader2 size={16} className="animate-spin" />
          {t.inbox.empty.loading}
        </div>
      ) : Object.keys(state.accounts).length === 0 ? (
        <EmptyState message={t.inbox.empty.noAccounts}>
          <Link
            href="/settings"
            className="text-[13px] px-3 py-1.5 rounded-lg border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            {t.inbox.empty.goToSettings}
          </Link>
        </EmptyState>
      ) : state.items.length === 0 ? (
        <EmptyState message={t.inbox.empty.noItems}>
          <button
            onClick={() => setReposOpen(true)}
            className="text-[13px] px-3 py-1.5 rounded-lg border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            {t.inbox.repos.manage}
          </button>
        </EmptyState>
      ) : visible.length === 0 && repo ? (
        <EmptyState message={t.inbox.empty.noItemsForRepo}>
          <button
            onClick={() => router.push("/inbox")}
            className="text-[13px] text-accent hover:underline"
          >
            {t.inbox.filters.clear}
          </button>
        </EmptyState>
      ) : view === "table" ? (
        <InboxTable items={visible} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      ) : (
        <InboxKanban items={visible} />
      )}

      <RepoManagerModal isOpen={reposOpen} onClose={() => setReposOpen(false)} />
    </div>
  );
}

function EmptyState({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <Inbox size={40} className="opacity-30" />
      <p className="text-sm text-muted max-w-md">{message}</p>
      {children}
    </div>
  );
}
