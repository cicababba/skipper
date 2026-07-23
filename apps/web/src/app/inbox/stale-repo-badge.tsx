"use client";

import type { TrackedItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

// Stale-repo flag (#120): the item's project was remapped to a different repo but
// the item stayed pinned to the old one (not auto-migratable). Renders nothing
// unless the flag is set.
export function StaleRepoBadge({ item }: { item: TrackedItem }) {
  const { t } = useT();
  if (!item.staleRepo) return null;
  return (
    <span
      className="text-[11px] font-medium px-1.5 py-0.5 rounded border border-warning/25 bg-warning-bg text-warning whitespace-nowrap"
      title={t.inbox.staleRepo.tooltip}
    >
      {t.inbox.staleRepo.badge}
    </span>
  );
}
