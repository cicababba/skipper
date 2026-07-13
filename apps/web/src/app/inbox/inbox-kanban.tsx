"use client";

import { useRouter } from "next/navigation";
import { ExternalLink, TriangleAlert } from "lucide-react";
import type { TrackedItem } from "@nestbrain/shared";
import { ATTENTION_SECTION_STATES, KANBAN_COLUMNS, repoKey } from "@/lib/inbox/model";
import { formatAge } from "@/lib/inbox/table";
import { ConfidenceBadge } from "@/components/confidence-popover";
import { useT } from "@/lib/app-i18n";
import { StateBadge } from "./state-badge";
import { ItemActions } from "./item-actions";

function openExternal(url: string) {
  void window.nestbrain?.openExternal(url);
}

function KanbanCard({ item, showState }: { item: TrackedItem; showState: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const age = formatAge(item.createdAt, new Date());
  return (
    <article className="rounded-lg border border-border bg-background/60 p-2.5 space-y-2">
      <button
        onClick={() => router.push(`/inbox/${encodeURIComponent(item.id)}`)}
        className="text-left hover:text-accent transition-colors w-full"
        title={item.title}
      >
        <span className="font-mono text-[11px] text-muted mr-1.5">#{item.number}</span>
        <span className="text-[13px] line-clamp-2">{item.title}</span>
      </button>
      <p className="text-[11px] text-muted truncate">{repoKey(item.repo)}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {showState && <StateBadge item={item} />}
        <ConfidenceBadge item={item} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            openExternal(item.url);
          }}
          className="text-muted hover:text-accent transition-colors"
          title={item.url}
        >
          <ExternalLink size={10} />
        </button>
        {item.pr && (
          <button
            onClick={() => openExternal(item.pr!.url)}
            className="flex items-center gap-0.5 text-[11px] text-accent hover:underline"
          >
            #{item.pr.number}
            <ExternalLink size={10} />
          </button>
        )}
        <span className="text-[11px] text-muted/60 ml-auto">
          {age.value}
          {t.inbox.age[age.unit]}
        </span>
      </div>
      <ItemActions item={item} />
    </article>
  );
}

export function InboxKanban({ items }: { items: TrackedItem[] }) {
  const { t } = useT();
  const attention = items.filter((i) => ATTENTION_SECTION_STATES.includes(i.state));

  return (
    <div className="space-y-4">
      {attention.length > 0 && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-center gap-2 mb-2">
            <TriangleAlert size={14} className="text-amber-300" />
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-amber-300">
              {t.inbox.columns.attention}
            </h2>
            <span className="text-[11px] text-amber-300/70">{attention.length}</span>
          </div>
          <div className="flex gap-2.5 flex-wrap">
            {attention.map((item) => (
              <div key={item.id} className="w-[260px]">
                <KanbanCard item={item} showState />
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {KANBAN_COLUMNS.map((column) => {
          const columnItems = items.filter((i) => column.states.includes(i.state));
          const groups = column.states.length > 1;
          return (
            <section
              key={column.id}
              className="min-w-[240px] w-[240px] shrink-0 rounded-xl border border-border bg-card p-2.5"
            >
              <div className="flex items-center justify-between mb-2 px-0.5">
                <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted/70">
                  {t.inbox.columns[column.id]}
                </h2>
                <span className="text-[11px] text-muted/50">{columnItems.length}</span>
              </div>
              <div className="space-y-2">
                {columnItems.map((item) => (
                  <KanbanCard key={item.id} item={item} showState={groups} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
