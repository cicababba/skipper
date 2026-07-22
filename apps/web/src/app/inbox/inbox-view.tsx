"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Inbox, Loader2, Pause, RefreshCw, X } from "lucide-react";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useAuth } from "@/lib/auth-context";
import { RepoManagerModal } from "@/components/repo-manager-modal";
import { useT } from "@/lib/app-i18n";
import { useStoredState } from "@/lib/use-stored-state";
import { inboxGate } from "@/lib/inbox/gate";
import { KANBAN_COLUMNS, columnCounts, type ColumnId } from "@/lib/inbox/model";
import { filterItems, sortItems, type SortDir, type SortKey } from "@/lib/inbox/table";
import { InboxTable } from "./inbox-table";
import { InboxKanban } from "./inbox-kanban";

const VIEW_KEY = "skipper-inbox-view";

type ViewMode = "table" | "kanban";
type ColumnFilter = ColumnId | "attention";

const CONFIDENCE_THRESHOLDS = [0.5, 0.75] as const;

export function InboxView({ repo: repoProp }: { repo?: string } = {}) {
  const { state, error, refreshing, refresh, clearError } = useOrchestrator();
  const { authState, providers, loaded: authLoaded } = useAuth();
  const { t } = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Embedded in a repo page (repoProp) the filter comes from the route, not the URL query.
  const repo = repoProp ?? searchParams.get("repo");

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

  // Dashboard tiles reflect the whole (repo-scoped) queue, independent of the
  // column/confidence filters — clicking a tile is what applies the filter.
  const counts = useMemo(
    () => columnCounts(state ? filterItems(state.items, { repo: repo ?? undefined }) : []),
    [state, repo],
  );

  // Click a tile → drill into that bucket in the table view.
  const drillTo = (id: ColumnFilter) => {
    if (view !== "table") switchView("table");
    toggleColumn(id);
  };

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
          onClick={(e) => void refresh(e.shiftKey)}
          disabled={refreshing}
          className="p-2 rounded-lg border border-border text-muted hover:text-foreground hover:bg-card transition-colors disabled:opacity-50"
          title={`${t.common.actions.refresh}\n${t.inbox.refresh.fullHint}`}
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Dashboard tiles — one per bucket, click to drill into the table. */}
      {state && state.items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {(["attention", ...KANBAN_COLUMNS.map((c) => c.id)] as ColumnFilter[]).map((id) => {
            const active = columns.has(id);
            const isAttention = id === "attention";
            return (
              <button
                key={id}
                onClick={() => drillTo(id)}
                className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                  active
                    ? isAttention
                      ? "border-amber-500/40 bg-amber-500/10"
                      : "border-accent/40 bg-accent/10"
                    : "border-border bg-card/40 hover:bg-card"
                }`}
              >
                <span
                  className={`text-xl font-semibold tabular-nums ${
                    isAttention && counts[id] > 0 ? "text-amber-300" : "text-foreground"
                  }`}
                >
                  {counts[id]}
                </span>
                <span className="text-[11px] text-muted/70 truncate w-full">
                  {t.inbox.columns[id]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Error strip */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2 text-sm">
          <span className="flex-1 break-all">{error}</span>
          <button onClick={clearError} className="shrink-0 hover:text-red-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Unmapped-projects warning (#79): tracker issues waiting on a repo mapping. */}
      {state && state.unmappedProjects.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-300 px-3 py-2 text-sm">
          <span className="font-medium">
            {t.inbox.unmapped.title(
              state.unmappedProjects.reduce((n, u) => n + u.count, 0),
              state.unmappedProjects.length,
            )}
          </span>
          <span className="text-amber-200/70">{t.inbox.unmapped.body}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {state.unmappedProjects.map((u) => (
              <span
                key={`${u.accountId}:${u.host}:${u.projectKey}`}
                className="text-[11px] px-1.5 py-0.5 rounded-full border border-amber-500/30 text-amber-200/80"
              >
                {u.host} · {u.projectKey} · {u.count}
              </span>
            ))}
          </div>
          <Link
            href="/settings"
            className="ml-auto text-[13px] underline-offset-2 hover:underline"
          >
            {t.inbox.unmapped.cta}
          </Link>
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
