"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, EyeOff, SquareTerminal } from "lucide-react";
import {
  displayKey,
  slugKey,
  type LifecycleState,
  type TrackedItem,
  type WorktreeStatusResult,
} from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useTerminal } from "@/lib/terminal-context";
import { useT } from "@/lib/app-i18n";
import { repoKey } from "@/lib/inbox/model";
import { confirmAndUntrack } from "../item-actions";
import { StateBadge } from "../state-badge";
import { StaleRepoBadge } from "../stale-repo-badge";
import { IssueDetailView } from "./issue-detail";
import { PlanDetailView } from "./plan-detail";
import { CodingDetailView } from "./coding-detail";
import { ReviewDetailView } from "./review-detail";
import { WorktreeDetailView } from "./worktree-detail";

type DetailTab = "detail" | "plan" | "coding" | "review" | "worktree";

const VISIBLE_TABS: DetailTab[] = ["detail", "plan", "coding", "review", "worktree"];

function tabEnabled(tab: DetailTab, item: TrackedItem): boolean {
  switch (tab) {
    case "detail":
    case "plan":
      return true;
    case "coding":
      return item.transitions.some((t) => t.to === "coding");
    case "review":
      return item.review != null || item.state === "agent-review" || item.state === "human-review";
    case "worktree":
      return item.worktree != null;
  }
}

function rawTabForState(state: LifecycleState, item: TrackedItem): DetailTab {
  switch (state) {
    case "triage":
    case "closed":
      return "detail";
    case "planning":
    case "plan-gate":
    case "queued":
      return "plan";
    case "coding":
      return "coding";
    case "agent-review":
    case "human-review":
    case "pr-open":
    case "in-review":
    case "changes-requested":
    case "merged":
      return "review";
    case "needs-input":
    case "blocked":
      return item.resumeTo ? rawTabForState(item.resumeTo, item) : "plan";
    case "failed":
      return item.transitions.some((t) => t.to === "coding") ? "coding" : "plan";
  }
}

function defaultTabFor(item: TrackedItem): DetailTab {
  const tab = rawTabForState(item.state, item);
  return tabEnabled(tab, item) ? tab : "plan";
}

// 5-tab issue-detail shell (#112). The active tab is latched once when the item
// first resolves, so a background state change never swaps the view mid-edit.
export function ItemDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state, untrackItem } = useOrchestrator();
  const { openTerminal } = useTerminal();
  const { t } = useT();
  const router = useRouter();

  const item = state?.items.find((i) => i.id === id);

  const [tab, setTab] = useState<DetailTab | null>(null);
  if (tab === null && item) setTab(defaultTabFor(item));

  const [wtStatus, setWtStatus] = useState<Extract<WorktreeStatusResult, { ok: true }> | null>(
    null,
  );
  const worktreePath = item?.worktree?.path;
  useEffect(() => {
    if (!worktreePath || !window.skipper) return;
    let cancelled = false;
    window.skipper.orchestrator.getWorktreeStatus(id).then((result) => {
      if (!cancelled) setWtStatus(result.ok ? result : null);
    });
    return () => {
      cancelled = true;
    };
  }, [id, worktreePath]);

  // Bare fallback: PlanDetailView self-handles the missing item, as before.
  if (!item) return <PlanDetailView />;

  const activeTab = tab ?? defaultTabFor(item);
  const tabs = VISIBLE_TABS.filter((tk) => tk !== "worktree" || item.worktree != null);

  const terminalReady = wtStatus?.present === true ? wtStatus : null;
  const showTerminal = activeTab !== "detail" && item.worktree != null;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-4 space-y-2 shrink-0">
        <Link
          href="/inbox"
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-foreground transition-colors w-fit"
        >
          <ArrowLeft size={13} />
          {t.inbox.plan.back}
        </Link>
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0 flex-1">
            <span className="font-mono text-[13px] text-muted shrink-0">
              {displayKey(item.key)}
            </span>
            <h1 className="text-xl font-semibold tracking-tight min-w-0">{item.title}</h1>
            <button
              onClick={() => void window.skipper?.openExternal(item.url)}
              className="p-1 rounded text-muted hover:text-accent transition-colors shrink-0 self-center"
              title={item.url}
            >
              <ExternalLink size={14} />
            </button>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {showTerminal && (
              <button
                onClick={() => {
                  if (terminalReady)
                    void openTerminal(terminalReady.path, `issue-${slugKey(item.key)}`);
                }}
                disabled={!terminalReady}
                className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <SquareTerminal size={13} />
                {t.inbox.worktree.openTerminal}
              </button>
            )}
            <button
              onClick={() => {
                void confirmAndUntrack(item, untrackItem, t).then((done) => {
                  if (done) router.push("/inbox");
                });
              }}
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
            >
              <EyeOff size={13} />
              {t.inbox.actions.untrack}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-muted">
          <span>{repoKey(item.repo)}</span>
          <StaleRepoBadge item={item} />
          <StateBadge item={item} />
          <span className="text-[11px] font-medium px-1.5 py-0.5 rounded border bg-card text-muted border-border uppercase">
            {item.source}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 px-6 pt-2 border-b border-border shrink-0">
        {tabs.map((tk) => {
          const enabled = tabEnabled(tk, item);
          const active = activeTab === tk;
          return (
            <button
              key={tk}
              disabled={!enabled}
              onClick={enabled ? () => setTab(tk) : undefined}
              className={`px-3 py-1.5 text-[12px] font-medium rounded-t-md border-b-2 transition-colors ${
                active
                  ? "border-accent text-foreground"
                  : enabled
                    ? "border-transparent text-muted hover:text-foreground"
                    : "border-transparent text-muted/40 cursor-not-allowed"
              }`}
            >
              {t.inbox.tabs[tk]}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex flex-col">
        {activeTab === "detail" ? (
          <IssueDetailView />
        ) : activeTab === "plan" ? (
          <PlanDetailView />
        ) : activeTab === "coding" ? (
          <CodingDetailView />
        ) : activeTab === "review" ? (
          <ReviewDetailView />
        ) : (
          <WorktreeDetailView />
        )}
      </div>
    </div>
  );
}
