"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { UpdateState } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { useToast } from "@/lib/toast-context";

// VS Code-style update toast: headless subscriber that issues a generic toast
// when a new version has been downloaded in the background. "Restart now"
// installs immediately; "Later" dismisses — the update still installs
// automatically on next quit.
export function UpdateToast() {
  const { t } = useT();
  const { toast } = useToast();
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const updates = typeof window !== "undefined" ? window.skipper?.updates : null;
    if (!updates) return;
    updates.getState().then(setState).catch(() => {});
    const off = updates.onStateChanged(setState);
    return () => off?.();
  }, []);

  useEffect(() => {
    const version = state?.status === "ready" ? state.available : null;
    if (!version || dismissed === version) return;
    toast({
      id: `update-${version}`,
      title: t.tree.updates.ready,
      message: t.tree.updates.downloaded(version),
      icon: <RefreshCw size={14} className="text-accent" />,
      action: {
        label: t.tree.updates.restartNow,
        onClick: () => void window.skipper?.updates.restart(),
      },
      dismissLabel: t.tree.updates.later,
      onDismiss: () => setDismissed(version),
    });
  }, [state, dismissed, t, toast]);

  return null;
}
