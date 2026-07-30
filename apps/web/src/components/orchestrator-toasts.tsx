"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { OrchestratorState } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { useToast } from "@/lib/toast-context";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { toastContentFor } from "@/lib/inbox/transition-toast-content";
import { diffTransitionToasts, type TransitionToast } from "@/lib/inbox/transition-toasts";
import { itemHref } from "@/lib/inbox/nav";

// Headless subscriber (#286): every orchestrator snapshot is diffed against the
// previous one and the attention-worthy transitions become toasts, so an item
// reaching the gate is visible from any route. The toast id is per item+event, so
// a repeated event replaces its toast instead of stacking.
export function OrchestratorToasts() {
  const { t } = useT();
  const { toast } = useToast();
  const { state } = useOrchestrator();
  const router = useRouter();
  const previous = useRef<OrchestratorState | null>(null);

  useEffect(() => {
    if (!state) return;
    const events = diffTransitionToasts(previous.current, state);
    previous.current = state;
    for (const event of events) {
      const content = toastContentFor(event, t);
      toast({
        id: `orch-${event.itemId}-${event.kind}`,
        variant: content.variant,
        title: content.title,
        message: content.message,
        ...(content.durationMs !== undefined ? { durationMs: content.durationMs } : {}),
        action: {
          label: content.actionLabel,
          onClick: () => openTarget(event, (href) => router.push(href)),
        },
      });
    }
  }, [state, t, toast, router]);

  return null;
}

function openTarget(event: TransitionToast, push: (href: string) => void) {
  if (
    event.kind === "plan-gate" ||
    event.kind === "human-review" ||
    event.kind === "needs-input"
  ) {
    push(itemHref(event.itemId));
    return;
  }
  void window.skipper?.openExternal(event.prUrl);
}
