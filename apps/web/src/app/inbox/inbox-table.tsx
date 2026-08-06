"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { displayKey, type TrackedItem } from "@skipper/shared";
import { ATTENTION_SECTION_STATES, repoKey } from "@/lib/inbox/model";
import { formatAge } from "@/lib/inbox/table";
import { itemHref } from "@/lib/inbox/nav";
import { ConfidenceBadge } from "@/components/confidence-popover";
import { useT } from "@/lib/app-i18n";
import { StateBadge } from "./state-badge";
import { BlockedByBadges } from "./blocked-by";
import { CiBadge } from "./ci-badge";
import { ItemActions } from "./item-actions";
import { StaleRepoBadge } from "./stale-repo-badge";
import { BaseAdvanceBadge } from "./base-advance-badge";

function openExternal(url: string) {
  void window.skipper?.openExternal(url);
}

function AgeText({ iso }: { iso: string }) {
  const { t } = useT();
  const { value, unit } = formatAge(iso, new Date());
  return (
    <span className="whitespace-nowrap">
      {value}
      {t.inbox.age[unit]}
    </span>
  );
}

const Dot = () => <span className="text-muted/40">·</span>;

export function InboxTable({ items, repoScoped }: { items: TrackedItem[]; repoScoped: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const from = search.size > 0 ? `${pathname}?${search.toString()}` : pathname;

  const header = (label: string) => (
    <th className="text-left font-medium text-[11px] uppercase tracking-wide text-muted/70 px-3 py-2">
      {label}
    </th>
  );

  return (
    <div className="rounded-lg border border-card-hover bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card border-b border-card-hover">
          <tr>
            {header(t.inbox.table.issue)}
            {header(t.inbox.table.state)}
            {header(t.inbox.table.confidence)}
            {header(t.inbox.table.actions)}
          </tr>
        </thead>
        <tbody className="divide-y divide-card-hover">
          {items.map((item) => {
            const attention = ATTENTION_SECTION_STATES.includes(item.state);
            return (
              <tr
                key={item.id}
                className={`hover:bg-card-hover/50 transition-colors ${
                  attention ? "border-l-2 border-l-signal/50" : ""
                }`}
              >
                <td className="px-3 py-2.5 max-w-[420px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <button
                      onClick={() => router.push(itemHref(item.id, from))}
                      className="flex items-baseline gap-2 text-left hover:text-accent transition-colors min-w-0 flex-1"
                      title={item.title}
                    >
                      <span className="font-mono text-[11px] text-muted shrink-0">
                        {displayKey(item.key)}
                      </span>
                      <span className="truncate">{item.title}</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openExternal(item.url);
                      }}
                      className="shrink-0 text-muted hover:text-accent transition-colors"
                      title={item.url}
                    >
                      <ExternalLink size={11} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap mt-1 text-[11px] text-muted/70">
                    {!repoScoped && (
                      <>
                        <span className="flex items-center gap-1">
                          {repoKey(item.repo)}
                          <StaleRepoBadge item={item} />
                          <BaseAdvanceBadge item={item} />
                        </span>
                        <Dot />
                      </>
                    )}
                    <AgeText iso={item.createdAt} />
                    {item.pr && (
                      <>
                        <Dot />
                        <span className="flex items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openExternal(item.pr!.url);
                            }}
                            className="flex items-center gap-1 text-accent hover:underline whitespace-nowrap"
                          >
                            #{item.pr.number}
                            <ExternalLink size={10} />
                          </button>
                          <CiBadge item={item} />
                        </span>
                      </>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <StateBadge item={item} />
                    <BlockedByBadges item={item} />
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <ConfidenceBadge item={item} />
                </td>
                <td className="px-3 py-2.5">
                  <ItemActions item={item} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
