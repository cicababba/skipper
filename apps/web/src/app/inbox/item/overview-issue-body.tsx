"use client";

import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import type { TrackedItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { useStoredState } from "@/lib/use-stored-state";
import { MarkdownRenderer } from "@/components/markdown-renderer";

// Overview issue body (#169): the source issue rendered as GFM, collapsible and
// persisted per item so the timeline stays the focus once the body is read.
export function OverviewIssueBody({ item }: { item: TrackedItem }) {
  const { t } = useT();
  const [open, setOpen] = useStoredState(`skipper-overview-body:${item.id}`, "1");
  const isOpen = open === "1";

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setOpen(isOpen ? "0" : "1")}
        className="flex w-full items-center gap-1.5 px-4 py-2.5 text-[12px] font-medium text-muted hover:text-foreground transition-colors"
      >
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t.inbox.overview.issueBody}
      </button>
      {isOpen && (
        <div className="px-4 pb-4">
          {item.body ? (
            <MarkdownRenderer content={item.body} />
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Inbox size={32} className="opacity-30" />
              <p className="text-sm text-muted max-w-md">{t.inbox.issueDetail.noBody}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
