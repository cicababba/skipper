"use client";

import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
import type { PullRequest, TrackedItem } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";

function openExternal(url: string) {
  void window.skipper?.openExternal(url);
}

export function useTrackedPull(item: TrackedItem): PullRequest | undefined {
  const { state } = useOrchestrator();
  if (!item.pr) return undefined;
  return state?.accounts[item.accountId]?.pullRequests.find(
    (pr) =>
      pr.number === item.pr!.number &&
      pr.repo.owner === item.repo.owner &&
      pr.repo.name === item.repo.name,
  );
}

const CI_STYLES = {
  passing: { icon: CircleCheck, classes: "text-emerald-500 border-emerald-500/30" },
  failing: { icon: CircleX, classes: "text-red-500 border-red-500/30" },
  pending: { icon: CircleDashed, classes: "text-amber-500 border-amber-500/30" },
} as const;

export function CiBadge({ item }: { item: TrackedItem }) {
  const { t } = useT();
  const pull = useTrackedPull(item);
  if (!pull?.ciStatus) return null;
  const { icon: Icon, classes } = CI_STYLES[pull.ciStatus];
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        openExternal(`${pull.url}/checks`);
      }}
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap hover:brightness-125 transition-[filter] ${classes}`}
      title={t.inbox.ci[pull.ciStatus]}
    >
      <Icon size={11} />
      CI
    </button>
  );
}
