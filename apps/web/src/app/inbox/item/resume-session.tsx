"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { slugKey, type TrackedItem, type WorktreeStatusResult } from "@skipper/shared";
import { useTerminal } from "@/lib/terminal-context";
import { useT } from "@/lib/app-i18n";

type Ready = Extract<WorktreeStatusResult, { ok: true }>;

// Resume the phase's Claude session in a terminal rooted at the worktree (#113).
// Sessions are cwd-scoped, so the worktree path must come from disk truth
// (getWorktreeStatus), not the manifest.
export function ResumeSessionButton({
  itemId,
  item,
  sessionId,
  running,
}: {
  itemId: string;
  item: TrackedItem;
  sessionId: string | undefined;
  running: boolean;
}) {
  const { openTerminal } = useTerminal();
  const { t } = useT();
  const [wtStatus, setWtStatus] = useState<Ready | null>(null);

  useEffect(() => {
    if (!window.skipper) return;
    let cancelled = false;
    window.skipper.orchestrator.getWorktreeStatus(itemId).then((result) => {
      if (!cancelled) setWtStatus(result.ok ? result : null);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const enabled = !!sessionId && wtStatus?.present === true && !running;

  const onClick = () => {
    if (!enabled || !wtStatus || !sessionId) return;
    void openTerminal(
      wtStatus.path,
      `claude · issue-${slugKey(item.key)}`,
      `claude --resume ${sessionId}`,
    );
  };

  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      title={running ? t.inbox.console.resumeRunning : undefined}
      className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
    >
      <Sparkles size={13} />
      {t.inbox.worktree.resumeClaude}
    </button>
  );
}
