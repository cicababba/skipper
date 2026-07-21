"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, EyeOff, SquareTerminal } from "lucide-react";
import {
  displayKey,
  slugKey,
  type TrackedItem,
  type WorktreeStatusResult,
} from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useTerminal } from "@/lib/terminal-context";
import { useT } from "@/lib/app-i18n";
import { repoKey } from "@/lib/inbox/model";
import { useStoredState } from "@/lib/use-stored-state";
import { unreadCount } from "@/lib/inbox/plan-chat-unread";
import { confirmAndUntrack } from "../item-actions";
import { StateBadge } from "../state-badge";
import { StaleRepoBadge } from "../stale-repo-badge";
import { OverviewDetailView } from "./overview-detail";
import { PlanDetailView } from "./plan-detail";
import { ReviewDetailView } from "./review-detail";
import { WorktreeDetailView } from "./worktree-detail";
import { ItemChatProvider, useItemChat, type ChatKind } from "./item-chat";
import { ChatDrawer, ChatFab } from "./chat-drawer";
import { PlanChatPanel } from "./plan-chat";
import { AgentChatPanel } from "./agent-chat";

type DetailTab = "overview" | "plan" | "review" | "worktree";

const VISIBLE_TABS: DetailTab[] = ["overview", "plan", "review", "worktree"];

function tabEnabled(tab: DetailTab, item: TrackedItem): boolean {
  switch (tab) {
    case "overview":
    case "plan":
      return true;
    case "review":
      return item.review != null || item.state === "agent-review" || item.state === "human-review";
    case "worktree":
      return item.worktree != null;
  }
}

// Landing rule (#169, decision 4): the plan-gate — and a parked item that will
// resume there — open on Plan; everything else opens on Overview.
function defaultTabFor(item: TrackedItem): DetailTab {
  if (item.state === "plan-gate") return "plan";
  if ((item.state === "needs-input" || item.state === "blocked") && item.resumeTo === "plan-gate") {
    return "plan";
  }
  return "overview";
}

// The interlocutor the shell FAB/drawer routes to for the active tab (#170).
function interlocutorFor(tab: DetailTab, item: TrackedItem, planAvailable: boolean): ChatKind | null {
  switch (tab) {
    case "plan":
      return planAvailable ? "plan" : null;
    case "review":
      return item.review != null && item.state !== "agent-review" ? "reviewer" : null;
    case "worktree":
      return item.worktree != null && item.state !== "coding" ? "coder" : null;
    default:
      return null;
  }
}

// 4-tab issue-detail shell (#169). The active tab is latched once when the item
// first resolves, so a background state change never swaps the view mid-edit.
export function ItemDetailView() {
  return (
    <ItemChatProvider>
      <ItemDetailShell />
    </ItemChatProvider>
  );
}

function ItemDetailShell() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state, untrackItem } = useOrchestrator();
  const { openTerminal } = useTerminal();
  const { t } = useT();
  const router = useRouter();
  const {
    chatBusy,
    setChatBusy,
    planAvailable,
    planDisabled,
    notifyPlanUpdated,
    worktreeSelection,
  } = useItemChat();

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

  // Per-interlocutor drawer/seen (localStorage) + live message count. Plan reuses
  // the pre-#170 keys so an in-flight discussion keeps its badge across the lift.
  const [planOpen, setPlanOpen] = useStoredState(`skipper-plan-drawer:${id}`, "0");
  const [planSeen, setPlanSeen] = useStoredState(`skipper-plan-chat-seen:${id}`, "0");
  const [coderOpen, setCoderOpen] = useStoredState(`skipper-coder-drawer:${id}`, "0");
  const [coderSeen, setCoderSeen] = useStoredState(`skipper-coder-chat-seen:${id}`, "0");
  const [reviewerOpen, setReviewerOpen] = useStoredState(`skipper-reviewer-drawer:${id}`, "0");
  const [reviewerSeen, setReviewerSeen] = useStoredState(`skipper-reviewer-chat-seen:${id}`, "0");
  const [planCount, setPlanCount] = useState(0);
  const [coderCount, setCoderCount] = useState(0);
  const [reviewerCount, setReviewerCount] = useState(0);

  useEffect(() => {
    if (planOpen === "1") setPlanSeen(String(planCount));
  }, [planOpen, planCount, setPlanSeen]);
  useEffect(() => {
    if (coderOpen === "1") setCoderSeen(String(coderCount));
  }, [coderOpen, coderCount, setCoderSeen]);
  useEffect(() => {
    if (reviewerOpen === "1") setReviewerSeen(String(reviewerCount));
  }, [reviewerOpen, reviewerCount, setReviewerSeen]);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Bare fallback: PlanDetailView self-handles the missing item, as before.
  if (!item) return <PlanDetailView />;

  const activeTab = tab ?? defaultTabFor(item);
  const tabs = VISIBLE_TABS.filter((tk) => tk !== "worktree" || item.worktree != null);

  const terminalReady = wtStatus?.present === true ? wtStatus : null;
  const showTerminal = item.worktree != null;

  const interlocutor = interlocutorFor(activeTab, item, planAvailable);
  const chatByKind: Record<ChatKind, { open: string; setOpen: typeof setPlanOpen; count: number; seen: string }> = {
    plan: { open: planOpen, setOpen: setPlanOpen, count: planCount, seen: planSeen },
    coder: { open: coderOpen, setOpen: setCoderOpen, count: coderCount, seen: coderSeen },
    reviewer: { open: reviewerOpen, setOpen: setReviewerOpen, count: reviewerCount, seen: reviewerSeen },
  };
  const active = interlocutor ? chatByKind[interlocutor] : null;
  const activeOpen = active?.open === "1";
  const cc = t.inbox.chat;
  const chatTitle =
    interlocutor === "plan" ? cc.planTitle : interlocutor === "coder" ? cc.coderTitle : cc.reviewerTitle;
  const fabLabel =
    interlocutor === "plan" ? cc.openPlan : interlocutor === "coder" ? cc.openCoder : cc.openReviewer;

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
        {activeTab === "overview" ? (
          <OverviewDetailView onNavigateTab={(tk) => setTab(tk)} />
        ) : activeTab === "plan" ? (
          <PlanDetailView />
        ) : activeTab === "review" ? (
          <ReviewDetailView />
        ) : (
          <WorktreeDetailView />
        )}
      </div>

      {interlocutor && active && !activeOpen && (
        <ChatFab
          unread={unreadCount(active.count, active.seen)}
          busy={chatBusy[interlocutor]}
          onClick={() => active.setOpen("1")}
          label={fabLabel}
          unreadLabel={t.inbox.plan.chat.unread}
        />
      )}
      {interlocutor && active && (
        <ChatDrawer
          open={activeOpen}
          onClose={() => active.setOpen("0")}
          title={chatTitle}
          focusRef={inputRef}
        >
          {interlocutor === "plan" ? (
            <PlanChatPanel
              itemId={id}
              disabled={planDisabled}
              onPlanUpdated={notifyPlanUpdated}
              onBusyChange={(b) => setChatBusy("plan", b)}
              onCountChange={setPlanCount}
              inputRef={inputRef}
            />
          ) : (
            <AgentChatPanel
              kind={interlocutor}
              itemId={id}
              selectedFile={interlocutor === "coder" ? worktreeSelection : null}
              onBusyChange={(b) => setChatBusy(interlocutor, b)}
              onCountChange={interlocutor === "coder" ? setCoderCount : setReviewerCount}
              inputRef={inputRef}
            />
          )}
        </ChatDrawer>
      )}
    </div>
  );
}
