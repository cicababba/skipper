"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Copy, ExternalLink, GitBranch, Loader2, SquareTerminal } from "lucide-react";
import {
  slugKey,
  type StoredPlan,
  type TrackedItem,
  type WorktreeDiffTotals,
  type WorktreeStatusResult,
} from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useTerminal } from "@/lib/terminal-context";
import { useT } from "@/lib/app-i18n";
import { pct, bandClasses } from "@/components/confidence-popover";
import { CloseItemDialog } from "@/components/close-item-dialog";
import { actionsFor } from "@/lib/inbox/actions";
import { nowSentence, railPrimary } from "@/lib/inbox/now";
import { formatDuration } from "@/lib/inbox/timeline";
import { ResumeSessionButton } from "./resume-session";

type Ready = Extract<WorktreeStatusResult, { ok: true }>;

// Overview "Now" rail (#169): status sentence, phase primary action, summary
// chips, and live links — the control surface that used to be scattered per tab.
export function NowRail({
  item,
  storedPlan,
  totals,
  wtStatus,
  now,
  onNavigateTab,
}: {
  item: TrackedItem;
  storedPlan: StoredPlan | null;
  totals: WorktreeDiffTotals | null;
  wtStatus: Ready | null;
  now: number;
  onNavigateTab: (tab: "plan" | "review") => void;
}) {
  const { t } = useT();
  const n = t.inbox.now;
  const router = useRouter();
  const { openTerminal } = useTerminal();
  const { openPr, requestTransition, closeItemOnTracker, untrackItem, state } = useOrchestrator();

  const [busyAction, setBusyAction] = useState<"openPr" | "resume" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const canCloseOnTracker = state?.sourceCapabilities[item.source]?.closeIssue ?? false;

  const runOpenPr = async () => {
    setBusyAction("openPr");
    setActionError(null);
    try {
      const result = await openPr(item.id);
      if (result.ok) router.push("/inbox");
      else setActionError(result.error);
    } finally {
      setBusyAction(null);
    }
  };

  const runTransition = async (to: TrackedItem["state"]) => {
    setBusyAction("resume");
    setActionError(null);
    try {
      const result = await requestTransition(item.id, to);
      if (result.ok) router.push("/inbox");
      else setActionError(result.error);
    } finally {
      setBusyAction(null);
    }
  };

  const sentence = nowSentence(item, now);
  let sentenceText = "";
  switch (sentence.kind) {
    case "waiting-you":
      sentenceText = n.waitingForYou;
      break;
    case "role-working":
      sentenceText = n.working(n.roleNames[sentence.role], formatDuration(sentence.sinceMs));
      break;
    case "queued":
      sentenceText = sentence.pinned ? n.queuedPinned : n.queued;
      break;
    case "parked":
      sentenceText = n.parked;
      break;
    case "upstream":
      sentenceText = n.upstream;
      break;
    case "settled":
      sentenceText = n.settled;
      break;
  }
  const parkedReason = sentence.kind === "parked" ? sentence.reason : undefined;

  const primary = railPrimary(item);
  const resumeAction = actionsFor(item).find((a) => a.id === "resume" || a.id === "retry");

  const composite = item.plan?.confidence;
  const review = item.review;
  const blockingCount = review?.objections?.filter((o) => o.blocking).length ?? 0;
  const size = storedPlan?.plan.estimatedSize;

  const copyBranch = () => {
    if (!item.worktree?.branch) return;
    void navigator.clipboard?.writeText(item.worktree.branch).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <>
    <div className="self-start wide:col-start-2 wide:row-start-1 wide:sticky wide:top-4 wide:max-h-[calc(100vh-230px)] wide:overflow-y-auto rounded-lg border border-card-hover bg-card p-4 space-y-4">
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted/70">{n.title}</p>
        <p className="text-sm text-foreground">{sentenceText}</p>
        {parkedReason && <p className="text-[12px] text-muted break-words">{parkedReason}</p>}
      </div>

      {primary && (
        <div className="space-y-2">
          {primary.kind === "action" && primary.action.id === "openPr" && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => void runOpenPr()}
                disabled={busyAction !== null}
                className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
              >
                {busyAction === "openPr" && <Loader2 size={11} className="animate-spin" />}
                {t.inbox.actions.openPr}
              </button>
              <button
                onClick={() => setCloseOpen(true)}
                disabled={busyAction !== null}
                className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
              >
                {t.inbox.actions.close}
              </button>
            </div>
          )}
          {primary.kind === "resume-session" &&
            (primary.sessionId ? (
              <ResumeSessionButton itemId={item.id} item={item} sessionId={primary.sessionId} running={false} />
            ) : resumeAction && resumeAction.kind === "transition" ? (
              <button
                onClick={() => void runTransition(resumeAction.to)}
                disabled={busyAction !== null}
                className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
              >
                {busyAction === "resume" && <Loader2 size={11} className="animate-spin" />}
                {t.inbox.actions[resumeAction.id]}
              </button>
            ) : null)}
          {primary.kind === "plan-link" && (
            <button
              onClick={() => onNavigateTab("plan")}
              className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            >
              {n.reviewPlan}
              <ArrowRight size={12} />
            </button>
          )}
          {actionError && <p className="text-[12px] text-red-300 break-all">{actionError}</p>}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {composite !== undefined && (
          <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${bandClasses(composite)}`}>
            {pct(composite)}
          </span>
        )}
        {size && (
          <span className="text-[11px] font-medium px-1.5 py-0.5 rounded border bg-card text-muted border-border uppercase">
            {size}
          </span>
        )}
        {totals && (
          <span className="text-[11px] font-medium px-1.5 py-0.5 rounded border bg-card border-border">
            <span className="text-emerald-300">+{totals.additions}</span>{" "}
            <span className="text-red-300">−{totals.deletions}</span>
          </span>
        )}
      </div>

      {review && (
        <div className="flex items-center gap-2 flex-wrap text-[12px]">
          <span className="uppercase text-[11px] px-1.5 py-0.5 rounded border bg-card-hover/40 border-border">
            {review.outcome}
          </span>
          <span className="text-muted">
            {review.rounds} {t.inbox.review.rounds}
          </span>
          {blockingCount > 0 && <span className="text-red-300">{n.blocking(blockingCount)}</span>}
          <button
            onClick={() => onNavigateTab("review")}
            className="inline-flex items-center gap-1 text-muted hover:text-accent transition-colors"
          >
            {t.inbox.overview.seeReview}
            <ArrowRight size={12} />
          </button>
        </div>
      )}

      <div className="space-y-1.5 pt-2 border-t border-border text-[12px]">
        {item.worktree?.branch && (
          <button
            onClick={copyBranch}
            className="flex items-center gap-1.5 text-muted hover:text-foreground transition-colors w-full text-left"
            title={n.branch}
          >
            <GitBranch size={12} className="shrink-0" />
            <span className="font-mono text-[11px] truncate flex-1">{item.worktree.branch}</span>
            {copied ? <Check size={12} className="shrink-0 text-emerald-300" /> : <Copy size={12} className="shrink-0 opacity-60" />}
          </button>
        )}
        {wtStatus?.present && (
          <button
            onClick={() => void openTerminal(wtStatus.path, `issue-${slugKey(item.key)}`)}
            className="flex items-center gap-1.5 text-muted hover:text-foreground transition-colors"
          >
            <SquareTerminal size={12} className="shrink-0" />
            {n.worktree}
          </button>
        )}
        <button
          onClick={() => void window.skipper?.openExternal(item.url)}
          className="flex items-center gap-1.5 text-muted hover:text-foreground transition-colors"
        >
          <ExternalLink size={12} className="shrink-0" />
          {n.remoteIssue}
        </button>
      </div>
    </div>
    {closeOpen && (
      <CloseItemDialog
        item={item}
        canCloseOnTracker={canCloseOnTracker}
        onCloseOnTracker={async () => {
          const res = await closeItemOnTracker(item.id);
          if (res.ok) router.push("/inbox");
          return res;
        }}
        onUntrack={async () => {
          const res = await untrackItem(item.id, true);
          if (res.ok) router.push("/inbox");
          return res.ok;
        }}
        onOpenInTracker={() => void window.skipper?.openExternal(item.url)}
        onDismiss={() => setCloseOpen(false)}
      />
    )}
    </>
  );
}
