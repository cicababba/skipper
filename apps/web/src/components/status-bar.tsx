"use client";

import { Terminal as TerminalIcon, ChevronUp, ChevronDown } from "lucide-react";
import { useTerminal } from "@/lib/terminal-context";
import { useT } from "@/lib/app-i18n";

export function StatusBar() {
  const { t } = useT();
  const { sessions, panelOpen, toggleOrOpen } = useTerminal();
  const count = sessions.length;

  // Terminal is public core (#18) — no module gate.
  return (
    <div className="h-6 shrink-0 border-t border-border bg-sidebar flex items-center justify-end px-2 text-[11px] text-muted/70">
      <button
        onClick={toggleOrOpen}
        className={`flex items-center gap-1.5 px-2.5 h-full hover:bg-card transition-colors ${
          panelOpen && count > 0 ? "text-accent" : "text-muted/70 hover:text-foreground"
        }`}
        title={panelOpen ? t.common.statusBar.hideTerminal : t.common.statusBar.showTerminal}
      >
        <TerminalIcon size={12} />
        <span>{t.common.statusBar.terminal}</span>
        {count > 0 && (
          <span className="text-[9px] px-1 rounded bg-accent/20 text-accent/90">
            {count}
          </span>
        )}
        {panelOpen && count > 0 ? (
          <ChevronDown size={11} className="opacity-60" />
        ) : (
          <ChevronUp size={11} className="opacity-60" />
        )}
      </button>
    </div>
  );
}
