"use client";

import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ExternalLink } from "lucide-react";
import type { TrackedItem } from "@skipper/shared";
import { ATTENTION_SECTION_STATES, repoKey } from "@/lib/inbox/model";
import { formatAge, type SortDir, type SortKey } from "@/lib/inbox/table";
import { ConfidenceBadge } from "@/components/confidence-popover";
import { useT } from "@/lib/app-i18n";
import { StateBadge } from "./state-badge";
import { CiBadge } from "./ci-badge";
import { ItemActions } from "./item-actions";

function openExternal(url: string) {
  void window.skipper?.openExternal(url);
}

function Age({ iso }: { iso: string }) {
  const { t } = useT();
  const { value, unit } = formatAge(iso, new Date());
  return (
    <span className="text-muted whitespace-nowrap">
      {value}
      {t.inbox.age[unit]}
    </span>
  );
}

export function InboxTable({
  items,
  sortKey,
  sortDir,
  onSort,
}: {
  items: TrackedItem[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const { t } = useT();
  const router = useRouter();

  const header = (label: string, key?: SortKey) => (
    <th className="text-left font-medium text-[11px] uppercase tracking-wide text-muted/70 px-3 py-2">
      {key ? (
        <button
          onClick={() => onSort(key)}
          className="flex items-center gap-1 hover:text-foreground transition-colors uppercase tracking-wide"
        >
          {label}
          {sortKey === key &&
            (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <div className="rounded-xl border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card border-b border-border">
          <tr>
            {header(t.inbox.table.issue)}
            {header(t.inbox.table.repo, "repo")}
            {header(t.inbox.table.state, "state")}
            {header(t.inbox.table.confidence, "confidence")}
            {header(t.inbox.table.pr)}
            {header(t.inbox.table.age, "age")}
            {header(t.inbox.table.actions)}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((item) => {
            const attention = ATTENTION_SECTION_STATES.includes(item.state);
            return (
              <tr
                key={item.id}
                className={`hover:bg-card-hover/50 transition-colors ${
                  attention ? "border-l-2 border-l-amber-500/60" : ""
                }`}
              >
                <td className="px-3 py-2 max-w-[360px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <button
                      onClick={() => router.push(`/inbox/${encodeURIComponent(item.id)}`)}
                      className="flex items-baseline gap-2 text-left hover:text-accent transition-colors min-w-0 flex-1"
                      title={item.title}
                    >
                      <span className="font-mono text-[11px] text-muted shrink-0">
                        #{item.number}
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
                </td>
                <td className="px-3 py-2 text-muted whitespace-nowrap">{repoKey(item.repo)}</td>
                <td className="px-3 py-2">
                  <StateBadge item={item} />
                </td>
                <td className="px-3 py-2">
                  <ConfidenceBadge item={item} />
                </td>
                <td className="px-3 py-2">
                  {item.pr ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => openExternal(item.pr!.url)}
                        className="flex items-center gap-1 text-accent hover:underline whitespace-nowrap"
                      >
                        #{item.pr.number}
                        <ExternalLink size={11} />
                      </button>
                      <CiBadge item={item} />
                    </div>
                  ) : (
                    <span className="text-muted/40">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Age iso={item.createdAt} />
                </td>
                <td className="px-3 py-2">
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
