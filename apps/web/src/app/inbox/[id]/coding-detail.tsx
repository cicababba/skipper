"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Inbox } from "lucide-react";
import { displayKey } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { repoKey } from "@/lib/inbox/model";
import { EventConsole } from "@/components/event-console";
import { StateBadge } from "../state-badge";

// Coding tab (#112): the coding agent's event console, extracted from the
// worktree view and made collapsible. Prop-less self-lookup.
export function CodingDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state } = useOrchestrator();
  const { t } = useT();

  const item = state?.items.find((i) => i.id === id);

  const backLink = (
    <Link
      href="/inbox"
      className="flex items-center gap-1.5 text-[12px] text-muted hover:text-foreground transition-colors w-fit"
    >
      <ArrowLeft size={13} />
      {t.inbox.plan.back}
    </Link>
  );

  if (!item) {
    return (
      <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
        {backLink}
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <Inbox size={40} className="opacity-30" />
          <p className="text-sm text-muted max-w-md">{t.inbox.plan.notFound}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
      {backLink}

      <div className="space-y-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-[13px] text-muted shrink-0">{displayKey(item.key)}</span>
          <h1 className="text-xl font-semibold tracking-tight min-w-0">{item.title}</h1>
          <button
            onClick={() => void window.skipper?.openExternal(item.url)}
            className="p-1 rounded text-muted hover:text-accent transition-colors shrink-0 self-center"
            title={item.url}
          >
            <ExternalLink size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-muted">
          <span>{repoKey(item.repo)}</span>
          <StateBadge item={item} />
        </div>
      </div>

      {window.skipper && (
        <EventConsole
          itemId={id}
          getEvents={window.skipper.coding.getEvents}
          onEvent={window.skipper.coding.onEvent}
          collapsible
          title={t.inbox.tabs.coding}
        />
      )}
    </div>
  );
}
