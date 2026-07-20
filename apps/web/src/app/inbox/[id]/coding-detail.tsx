"use client";

import { useParams } from "next/navigation";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { EventConsole } from "@/components/event-console";
import { ResumeSessionButton } from "./resume-session";

// Coding tab (#112): the coding agent's event console, extracted from the
// worktree view and made collapsible. Prop-less self-lookup.
export function CodingDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state } = useOrchestrator();
  const { t } = useT();

  const item = state?.items.find((i) => i.id === id);
  if (!item) return null;

  return (
    <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
      <ResumeSessionButton
        itemId={id}
        item={item}
        sessionId={item.worktree?.sessionId}
        running={item.state === "coding"}
      />

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
