"use client";

import { useEffect, useState } from "react";
import type { UpdateState } from "@skipper/shared";

// Settings footer. Shows the running app version straight from the updater
// bridge, so it matches the packaged version rather than the web build env.
// Without an Electron bridge (browser dev) it renders nothing.
export function AppVersionFooter() {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    const updates = typeof window !== "undefined" ? window.skipper?.updates : null;
    if (!updates) return;
    updates.getState().then(setState).catch(() => {});
    const off = updates.onStateChanged(setState);
    return () => off?.();
  }, []);

  if (!state?.current) return null;
  // Don't show the version twice in one viewport: when the updater runs, its
  // idle line already prints it ("You're on <v> — up to date",
  // updates-section.tsx:52, i18n key settings.updates.upToDate). The footer
  // only fills the gap where that line never appears — source builds
  // (disabled) and dev.
  if (state.status !== "disabled" && state.status !== "dev") return null;

  return <footer className="mt-10 text-[11px] text-muted/40">{`Skipper v${state.current}`}</footer>;
}
