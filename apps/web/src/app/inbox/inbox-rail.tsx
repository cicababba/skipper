"use client";

import { useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { GitBranch, Pause, X } from "lucide-react";
import { displayKey } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { KANBAN_COLUMNS, columnCounts, type ColumnId } from "@/lib/inbox/model";
import { filterItems } from "@/lib/inbox/table";
import { itemHref } from "@/lib/inbox/nav";
import { accountsSummary, attentionItems, attentionTone } from "@/lib/inbox/rail";

const LABEL = "text-[11px] font-medium uppercase tracking-wide text-muted/70";

const TONE_DOT: Record<"danger" | "signal" | "accent", string> = {
  danger: "bg-danger",
  signal: "bg-signal",
  accent: "bg-accent",
};

export function InboxRail({
  repo,
  repoScoped,
  activeColumns,
  onToggleColumn,
}: {
  repo?: string;
  repoScoped: boolean;
  activeColumns: Set<ColumnId | "attention">;
  onToggleColumn: (id: ColumnId | "attention") => void;
}) {
  const { state, error, clearError } = useOrchestrator();
  const { t } = useT();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const from = search.size > 0 ? `${pathname}?${search.toString()}` : pathname;
  const r = t.inbox.rail;

  const scoped = useMemo(
    () => filterItems(state?.items ?? [], { repo }),
    [state, repo],
  );
  const counts = useMemo(() => columnCounts(scoped), [scoped]);
  const { shown, overflow } = useMemo(() => attentionItems(scoped), [scoped]);
  const worktrees = useMemo(
    () => (repoScoped ? scoped.filter((it) => it.worktree) : []),
    [scoped, repoScoped],
  );
  const summary = useMemo(() => accountsSummary(state?.accounts ?? {}), [state]);

  const attentionTotal = shown.length + overflow;
  const unmapped = state?.unmappedProjects ?? [];
  const unmappedIssues = unmapped.reduce((n, u) => n + u.count, 0);

  const navigate = (id: string) =>
    router.push(itemHref(id, from));

  return (
    <div className="self-start wide:col-start-2 wide:row-start-1 wide:sticky wide:top-4 wide:max-h-[calc(100vh-230px)] wide:overflow-y-auto rounded-lg border border-card-hover bg-card p-4 space-y-4">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger-bg text-danger px-2.5 py-1.5 text-[12px]">
          <span className="flex-1 break-all">{error}</span>
          <button onClick={clearError} className="shrink-0 hover:opacity-70">
            <X size={12} />
          </button>
        </div>
      )}

      {unmapped.length > 0 && (
        <Link
          href="/settings"
          className="flex items-center gap-2 rounded-md border border-warning/25 bg-warning-bg text-warning px-2.5 py-1.5 text-[12px] hover:bg-warning/10 transition-colors"
        >
          <span className="flex-1">{t.inbox.unmapped.title(unmappedIssues, unmapped.length)}</span>
          <span className="shrink-0 underline underline-offset-2">{t.inbox.unmapped.cta}</span>
        </Link>
      )}

      {shown.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className={LABEL}>{r.attention}</span>
            <span className="rounded-full border border-signal/30 bg-signal-bg px-1.5 text-[10px] font-medium text-signal tabular-nums">
              {attentionTotal}
            </span>
          </div>
          {shown.map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className="flex w-full min-w-0 items-center gap-2 text-left text-[12px] text-muted hover:text-accent transition-colors"
              title={item.title}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[attentionTone(item.state)]}`}
              />
              <span className="font-mono text-[11px] shrink-0">{displayKey(item.key)}</span>
              <span className="truncate">{item.title}</span>
            </button>
          ))}
          {overflow > 0 && (
            <button
              onClick={() => onToggleColumn("attention")}
              className="text-[12px] text-muted hover:text-accent transition-colors"
            >
              {r.more(overflow)}
            </button>
          )}
        </div>
      )}

      <div className="space-y-0.5">
        <p className={LABEL}>{r.pipeline}</p>
        {KANBAN_COLUMNS.map(({ id }) => {
          const active = activeColumns.has(id);
          const count = counts[id];
          return (
            <button
              key={id}
              onClick={() => onToggleColumn(id)}
              className={`flex w-full items-center justify-between text-[12px] transition-colors ${
                active
                  ? "-mx-1.5 rounded-md bg-accent/10 px-1.5 text-accent"
                  : count === 0
                    ? "text-muted/50 hover:text-foreground"
                    : "text-muted hover:text-foreground"
              }`}
            >
              <span>{t.inbox.columns[id]}</span>
              <span className="tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5 pt-2 border-t border-border">
        <p className={LABEL}>{r.status}</p>
        <div className="flex items-center gap-1.5 text-[12px] text-muted">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${summary.errors === 0 ? "bg-success" : "bg-danger"}`}
          />
          <span>{r.accounts(summary.total)}</span>
          {summary.errors > 0 && (
            <span className="text-danger">{r.accountErrors(summary.errors)}</span>
          )}
        </div>
        {state?.settings.intakePaused ? (
          <div className="flex items-center gap-1.5 text-[12px] text-muted">
            <Pause size={12} className="shrink-0" />
            <span>
              {t.inbox.intake.paused}
              {state.parkedCount > 0 && ` · ${state.parkedCount} ${t.inbox.intake.queued}`}
            </span>
          </div>
        ) : (
          <p className="text-[12px] text-muted/60">{r.intakeActive}</p>
        )}
      </div>

      {repoScoped && (
        <div className="space-y-1.5 pt-2 border-t border-border">
          <div className="flex items-center gap-1.5">
            <p className={LABEL}>{t.inbox.repoPage.worktrees}</p>
            <span className="font-mono text-[11px] text-muted/50 tabular-nums">
              {worktrees.length}
            </span>
          </div>
          {worktrees.length === 0 ? (
            <p className="text-[12px] text-muted/60">{t.inbox.repoPage.worktreesEmpty}</p>
          ) : (
            worktrees.map((it) => (
              <Link
                key={it.id}
                href={itemHref(it.id, pathname)}
                className="flex min-w-0 items-center gap-2 text-[12px] text-muted hover:text-accent transition-colors"
              >
                <span className="font-mono text-[11px] shrink-0">{displayKey(it.key)}</span>
                <span className="flex-1 truncate">{it.title}</span>
                {it.worktree && (
                  <span className="flex items-center gap-1 shrink-0 font-mono text-[11px] text-muted/70">
                    <GitBranch size={11} />
                    {it.worktree.branch}
                  </span>
                )}
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
