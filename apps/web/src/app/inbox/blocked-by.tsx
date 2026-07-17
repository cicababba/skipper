"use client";

import { displayKey, type TrackedItem } from "@skipper/shared";
import { repoKey } from "@/lib/inbox/model";
import { blockingItemsFor } from "@/lib/inbox/blocked";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";

function openExternal(url: string) {
  void window.skipper?.openExternal(url);
}

export function BlockedByBadges({ item }: { item: TrackedItem }) {
  const { t } = useT();
  const { state } = useOrchestrator();
  if (item.state !== "blocked") return null;
  const blockers = blockingItemsFor(item, state?.items ?? []);
  if (blockers.length === 0) return null;
  return (
    <>
      {blockers.map((blocker) => {
        const label =
          repoKey(blocker.repo) === repoKey(item.repo)
            ? displayKey(blocker.key)
            : `${repoKey(blocker.repo)}#${blocker.key}`;
        return (
          <button
            key={blocker.id}
            onClick={(e) => {
              e.stopPropagation();
              openExternal(blocker.url);
            }}
            className="inline-block text-[11px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap bg-amber-500/10 text-amber-300 border-amber-500/20 hover:bg-amber-500/20 transition-colors"
            title={blocker.title}
            aria-label={`${t.inbox.blockedBy} ${label}`}
          >
            {t.inbox.blockedBy} {label}
          </button>
        );
      })}
    </>
  );
}
