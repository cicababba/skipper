"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type {
  PlanChatMessage,
  StoredPlan,
  WorktreeDiffTotals,
  WorktreeStatusResult,
} from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { buildTimeline } from "@/lib/inbox/timeline";
import { OverviewIssueBody } from "./overview-issue-body";
import { OverviewTimeline } from "./overview-timeline";
import { NowRail } from "./now-rail";

type Ready = Extract<WorktreeStatusResult, { ok: true }>;

// Overview tab (#169): the item's control center — issue body + timeline on the
// left, the "Now" rail on the right (#167 two-pane grammar). Tab state lives in
// the shell, so cross-tab jumps arrive as onNavigateTab.
export function OverviewDetailView({ onNavigateTab }: { onNavigateTab: (tab: "plan" | "review") => void }) {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state } = useOrchestrator();
  const item = state?.items.find((i) => i.id === id);

  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [chat, setChat] = useState<PlanChatMessage[]>([]);
  const [wtStatus, setWtStatus] = useState<Ready | null>(null);
  const [totals, setTotals] = useState<WorktreeDiffTotals | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Reset per-item state during render when the item changes (the sanctioned
  // alternative to clearing state inside the loaders below, as event-console does).
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setStored(null);
    setChat([]);
    setWtStatus(null);
    setTotals(null);
  }

  const planRef = item?.plan?.ref;
  const composite = item?.plan?.confidence;
  const rescoring = item?.plan?.rescoring;
  useEffect(() => {
    if (!window.skipper || !planRef) return;
    let cancelled = false;
    window.skipper.orchestrator
      .getPlan(id)
      .then((s) => {
        if (!cancelled) setStored(s);
      })
      .catch(() => {
        if (!cancelled) setStored(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, planRef, composite, rescoring]);

  useEffect(() => {
    if (!window.skipper) return;
    let cancelled = false;
    window.skipper.planChat
      .getHistory(id)
      .then((h) => {
        if (!cancelled) setChat(h);
      })
      .catch(() => {
        if (!cancelled) setChat([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id, planRef]);

  const worktreePath = item?.worktree?.path;
  useEffect(() => {
    if (!worktreePath || !window.skipper) return;
    let cancelled = false;
    window.skipper.orchestrator.getWorktreeStatus(id).then((r) => {
      if (!cancelled) setWtStatus(r.ok ? r : null);
    });
    window.skipper.orchestrator.getWorktreeChanges(id).then((r) => {
      if (!cancelled) setTotals(r.ok ? r.totals : null);
    });
    return () => {
      cancelled = true;
    };
  }, [id, worktreePath]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!item) return null;

  const entries = buildTimeline(item, stored, chat, now);

  return (
    <div className="min-h-full p-6">
      <div className="flex flex-col gap-4 wide:grid wide:grid-cols-[minmax(0,1fr)_300px] wide:gap-8 wide:items-start">
        <NowRail
          item={item}
          storedPlan={stored}
          totals={totals}
          wtStatus={wtStatus}
          now={now}
          onNavigateTab={onNavigateTab}
        />
        <div className="min-w-0 space-y-4 wide:col-start-1 wide:row-start-1">
          <OverviewIssueBody item={item} />
          <OverviewTimeline entries={entries} itemId={id} onNavigateTab={onNavigateTab} />
        </div>
      </div>
    </div>
  );
}
