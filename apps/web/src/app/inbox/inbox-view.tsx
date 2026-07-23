"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, Inbox, Loader2, RefreshCw, X } from "lucide-react";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useAuth } from "@/lib/auth-context";
import { RepoManagerModal } from "@/components/repo-manager-modal";
import { useT } from "@/lib/app-i18n";
import { useStoredState } from "@/lib/use-stored-state";
import { inboxGate } from "@/lib/inbox/gate";
import { KANBAN_COLUMNS, type ColumnId } from "@/lib/inbox/model";
import { filterItems, sortItems, type SortDir, type SortKey } from "@/lib/inbox/table";
import { InboxTable } from "./inbox-table";
import { InboxRail } from "./inbox-rail";

const VIEW_KEY = "skipper-inbox-view";

type ViewMode = "table" | "kanban";
type ColumnFilter = ColumnId | "attention";

const CONFIDENCE_THRESHOLDS = [0.5, 0.75] as const;

export function InboxView({ repo: repoProp }: { repo?: string } = {}) {
  const { state, refreshing, refresh } = useOrchestrator();
  const { authState, providers, loaded: authLoaded } = useAuth();
  const { t } = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Embedded in a repo page (repoProp) the filter comes from the route, not the URL query.
  const repo = repoProp ?? searchParams.get("repo");

  // Kanban is WIP (#193): the view renders table only, but the stored preference is
  // left untouched so it returns once kanban ships.
  const [, setStoredView] = useStoredState(VIEW_KEY, "table");
  const switchView = (mode: ViewMode) => setStoredView(mode);
  const [sortKey, setSortKey] = useState<SortKey>("age");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [columns, setColumns] = useState<Set<ColumnFilter>>(new Set());
  const [minConfidence, setMinConfidence] = useState<number | undefined>(undefined);
  const [reposOpen, setReposOpen] = useState(false);

  const changeSortKey = (key: SortKey) => {
    setSortKey(key);
    setSortDir(key === "confidence" || key === "age" ? "desc" : "asc");
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
      columns,
      minConfidence,
    });
    return sortItems(filtered, sortKey, sortDir);
  }, [state, repo, columns, minConfidence, sortKey, sortDir]);

  const isElectron = typeof window !== "undefined" && !!window.skipper;

  const issueAccounts = useMemo(() => {
    const issueProviders = new Set(providers.filter((p) => p.isIssueSource).map((p) => p.id));
    return authState.accounts.filter((a) => issueProviders.has(a.provider)).length;
  }, [authState, providers]);

  const gate = inboxGate({
    isElectron,
    authLoaded,
    issueAccounts,
    orchestrator: state
      ? { accounts: Object.keys(state.accounts).length, items: state.items.length }
      : null,
  });

  return (
    <div className="min-h-full p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        {!repoProp && (
          <div className="flex items-center gap-2">
            <Inbox size={22} className="text-accent" />
            <h1 className="text-2xl font-semibold tracking-tight">{t.inbox.title}</h1>
          </div>
        )}
        {repo && !repoProp && (
          <button
            onClick={() => router.push("/inbox")}
            className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-full border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            {repo}
            <X size={12} />
          </button>
        )}
        <div className="flex-1" />
        <div className="flex items-center rounded-lg border border-border overflow-hidden">
          {(["table", "kanban"] as const).map((mode) => {
            const isKanban = mode === "kanban";
            return (
              <button
                key={mode}
                onClick={() => switchView(mode)}
                disabled={isKanban}
                title={isKanban ? t.inbox.views.kanbanWip : undefined}
                className={`px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  mode === "table"
                    ? "bg-accent/10 text-accent"
                    : "text-muted hover:text-foreground hover:bg-card"
                }`}
              >
                {t.inbox.views[mode]}
                {isKanban && " (WIP)"}
              </button>
            );
          })}
        </div>
        <button
          onClick={(e) => void refresh(e.shiftKey)}
          disabled={refreshing}
          className="p-2 rounded-lg border border-border text-muted hover:text-foreground hover:bg-card transition-colors disabled:opacity-50"
          title={`${t.common.actions.refresh}\n${t.inbox.refresh.fullHint}`}
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Body */}
      {gate === "desktop-only" ? (
        <EmptyState message={t.inbox.empty.desktopOnly} />
      ) : gate === "loading" ? (
        <div className="flex items-center justify-center gap-2 py-24 text-muted">
          <Loader2 size={16} className="animate-spin" />
          {t.inbox.empty.loading}
        </div>
      ) : gate === "connect" ? (
        <EmptyState message={t.inbox.empty.noAccounts}>
          <Link
            href="/settings"
            className="text-[13px] px-3 py-1.5 rounded-lg border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            {t.inbox.empty.goToSettings}
          </Link>
        </EmptyState>
      ) : gate === "no-items" ? (
        <EmptyState message={t.inbox.empty.noItems}>
          <button
            onClick={() => setReposOpen(true)}
            className="text-[13px] px-3 py-1.5 rounded-lg border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            {t.inbox.repos.manage}
          </button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4 wide:grid wide:grid-cols-[minmax(0,1fr)_300px] wide:gap-8 wide:items-start">
          <InboxRail
            repo={repo ?? undefined}
            repoScoped={!!repoProp}
            activeColumns={columns}
            onToggleColumn={toggleColumn}
          />
          <div className="min-w-0 space-y-4 wide:col-start-1 wide:row-start-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              {(["attention", ...KANBAN_COLUMNS.map((c) => c.id)] as ColumnFilter[]).map((id) => (
                <button
                  key={id}
                  onClick={() => toggleColumn(id)}
                  className={`text-[12px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
                    columns.has(id)
                      ? id === "attention"
                        ? "border-signal/30 bg-signal-bg text-signal"
                        : "border-accent/30 bg-accent/10 text-accent"
                      : "border-border text-muted hover:text-foreground hover:bg-card-hover"
                  }`}
                >
                  {t.inbox.columns[id]}
                </button>
              ))}
              <div className="flex-1" />
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                {t.inbox.filters.sortBy}
                <select
                  value={sortKey}
                  onChange={(e) => changeSortKey(e.target.value as SortKey)}
                  className="bg-card border border-card-hover rounded-md px-1.5 py-1 text-[11px] text-foreground focus:outline-none focus:border-accent/60"
                >
                  <option value="age">{t.inbox.table.age}</option>
                  <option value="confidence">{t.inbox.table.confidence}</option>
                  <option value="repo">{t.inbox.table.repo}</option>
                  <option value="state">{t.inbox.table.state}</option>
                </select>
              </label>
              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                className="p-1 rounded-md border border-card-hover text-muted hover:text-foreground hover:bg-card-hover transition-colors"
              >
                {sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              </button>
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                {t.inbox.filters.minConfidence}
                <select
                  value={minConfidence ?? ""}
                  onChange={(e) =>
                    setMinConfidence(e.target.value === "" ? undefined : Number(e.target.value))
                  }
                  className="bg-card border border-card-hover rounded-md px-1.5 py-1 text-[11px] text-foreground focus:outline-none focus:border-accent/60"
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
            {visible.length === 0 && repo ? (
              <EmptyState message={t.inbox.empty.noItemsForRepo}>
                <button
                  onClick={() => router.push("/inbox")}
                  className="text-[13px] text-accent hover:underline"
                >
                  {t.inbox.filters.clear}
                </button>
              </EmptyState>
            ) : (
              <InboxTable items={visible} repoScoped={!!repoProp} />
            )}
          </div>
        </div>
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
