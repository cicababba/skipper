"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { EyeOff, SquareTerminal } from "lucide-react";
import {
  slugKey,
  type LifecycleState,
  type TrackedItem,
  type WorktreeStatusResult,
} from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useTerminal } from "@/lib/terminal-context";
import { useT } from "@/lib/app-i18n";
import { confirmAndUntrack } from "../item-actions";
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
      <div className="flex items-center gap-1 px-6 pt-3 border-b border-border shrink-0">
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
        <div className="ml-auto flex items-center gap-1.5">
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
