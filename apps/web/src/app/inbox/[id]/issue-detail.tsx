"use client";

import { useParams } from "next/navigation";
import { Inbox } from "lucide-react";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { MarkdownRenderer } from "@/components/markdown-renderer";

// Detail tab (#112): the issue body rendered as GFM markdown. The shared
// header (key, title, badges) lives in the item-detail shell above the tabs.
export function IssueDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state } = useOrchestrator();
  const { t } = useT();

  const item = state?.items.find((i) => i.id === id);
  if (!item) return null;

  return (
    <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
      {item.body ? (
        <MarkdownRenderer content={item.body} />
      ) : (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <Inbox size={40} className="opacity-30" />
          <p className="text-sm text-muted max-w-md">{t.inbox.issueDetail.noBody}</p>
        </div>
      )}
    </div>
  );
}
