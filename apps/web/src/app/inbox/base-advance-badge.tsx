"use client";

import type { TrackedItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

// Base-advance flag (#329): another PR merged on this repo after the item's plan
// was written. Renders nothing unless the notice is set.
export function BaseAdvanceBadge({ item }: { item: TrackedItem }) {
  const { t } = useT();
  if (!item.baseAdvance) return null;
  return (
    <span
      className="text-[11px] font-medium px-1.5 py-0.5 rounded border border-warning/25 bg-warning-bg text-warning whitespace-nowrap"
      title={t.inbox.baseAdvance.tooltip}
    >
      {t.inbox.baseAdvance.badge}
    </span>
  );
}
