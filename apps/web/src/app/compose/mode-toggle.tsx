"use client";

import { MessageSquare, Zap } from "lucide-react";
import { useT } from "@/lib/app-i18n";

// The two ways into an issue (#137): the agent chat, or title + body straight to
// the tracker. Each view guards its own switch — leaving either one throws work
// away, so the guard belongs where the work lives.

export type ComposeMode = "chat" | "quick";

const MODES: ComposeMode[] = ["chat", "quick"];

export function ComposeModeToggle({
  mode,
  onSwitch,
}: {
  mode: ComposeMode;
  onSwitch: (mode: ComposeMode) => void;
}) {
  const { t } = useT();
  const q = t.composer.quick;

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
      {MODES.map((m) => (
        <button
          key={m}
          onClick={() => {
            if (m !== mode) onSwitch(m);
          }}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
            m === mode
              ? "bg-accent/10 text-accent"
              : "text-muted hover:text-foreground hover:bg-card-hover"
          }`}
        >
          {m === "chat" ? <MessageSquare size={11} /> : <Zap size={11} />}
          {m === "chat" ? q.modeChat : q.modeQuick}
        </button>
      ))}
    </div>
  );
}

export function ComposeSwitchConfirm({
  title,
  body,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const c = t.composer;

  return (
    <div className="m-4 space-y-2 rounded-lg border border-warning/30 bg-warning-bg p-3">
      <p className="text-[12px] font-medium text-warning">{title}</p>
      <p className="text-[12px] text-warning/80">{body}</p>
      <div className="flex items-center gap-2">
        <button
          onClick={onConfirm}
          className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-warning/30 bg-warning/10 text-warning hover:bg-warning/20 transition-colors"
        >
          {c.quick.leaveConfirm}
        </button>
        <button
          onClick={onCancel}
          className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
        >
          {c.cancel}
        </button>
      </div>
    </div>
  );
}
