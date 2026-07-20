"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FolderX,
  GitBranch,
  Inbox,
  Loader2,
  SquareTerminal,
  Sparkles,
} from "lucide-react";
import { displayKey, slugKey, type WorktreeStatusResult } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useTerminal } from "@/lib/terminal-context";
import { useT } from "@/lib/app-i18n";
import { repoKey } from "@/lib/inbox/model";
import { FileTree } from "@/components/file-tree";
import { StateBadge } from "../state-badge";
import { MemoriesCard } from "./memories-card";
import { WorktreeFileView } from "./worktree-file-view";

type StatusState =
  | { kind: "loading" }
  | { kind: "ready"; status: Extract<WorktreeStatusResult, { ok: true }> }
  | { kind: "error"; message: string };

// Worktree control center (#40): file tree + editor rooted at the item's
// worktree, plus terminal / claude-resume entry points into it.
export function WorktreeDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state } = useOrchestrator();
  const { openTerminal } = useTerminal();
  const { t } = useT();
  const w = t.inbox.worktree;

  const item = state?.items.find((i) => i.id === id);
  const worktree = item?.worktree;

  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!worktree || !window.skipper) return;
    let cancelled = false;
    window.skipper.orchestrator.getWorktreeStatus(id).then((result) => {
      if (cancelled) return;
      setStatus(
        result.ok
          ? { kind: "ready", status: result }
          : { kind: "error", message: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [id, worktree]);

  if (!item || !worktree) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <Inbox size={40} className="opacity-30" />
        <p className="text-sm text-muted max-w-md">{w.noWorktree}</p>
      </div>
    );
  }

  const ready = status.kind === "ready" ? status.status : null;
  const usable = ready?.present === true;
  const terminalLabel = `issue-${slugKey(item.key)}`;

  const openWorktreeTerminal = () => {
    if (!ready) return;
    void openTerminal(ready.path, terminalLabel);
  };

  const openClaude = () => {
    if (!ready) return;
    void openTerminal(
      ready.path,
      `claude · ${terminalLabel}`,
      ready.sessionId ? `claude --resume ${ready.sessionId}` : "claude",
    );
  };

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <div className="space-y-2 shrink-0">
        <Link
          href="/inbox"
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-foreground transition-colors w-fit"
        >
          <ArrowLeft size={13} />
          {t.inbox.plan.back}
        </Link>
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
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-card font-mono text-[11px]"
            title={ready?.path ?? worktree.path}
          >
            <GitBranch size={11} />
            {worktree.branch}
          </span>
        </div>
      </div>

      {status.kind === "error" && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 px-3 py-2 text-sm shrink-0">
          <AlertTriangle size={14} className="shrink-0" />
          {w.statusFailed}: {status.message}
        </div>
      )}

      {ready && !usable && (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <FolderX size={40} className="opacity-30" />
          <p className="text-sm text-muted max-w-md">{w.pruned}</p>
          <p className="text-[11px] text-muted/60 font-mono break-all max-w-lg">{ready.path}</p>
        </div>
      )}

      {usable && (
        <>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <button
              onClick={openWorktreeTerminal}
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
            >
              <SquareTerminal size={13} />
              {w.openTerminal}
            </button>
            <button
              onClick={openClaude}
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
              title={ready.sessionId ? `claude --resume ${ready.sessionId}` : "claude"}
            >
              <Sparkles size={13} />
              {ready.sessionId ? w.resumeClaude : w.openClaude}
            </button>
          </div>

          <div className="shrink-0">
            <MemoriesCard
              itemId={id}
              phase="coding"
              refs={item.usedMemory?.coding}
              title={t.inbox.plan.memories.consulted}
            />
          </div>

          <div className="flex-1 min-h-0 flex rounded-lg border border-border overflow-hidden">
            <div className="w-64 shrink-0 border-r border-border bg-sidebar min-h-0">
              <FileTree
                rootPath={ready.path}
                rootLabel={terminalLabel}
                onOpenFile={setSelectedPath}
              />
            </div>
            <div className="flex-1 min-w-0 bg-background">
              {selectedPath ? (
                <WorktreeFileView key={selectedPath} path={selectedPath} />
              ) : (
                <div className="h-full flex items-center justify-center text-[13px] text-muted/60">
                  {w.pickFile}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {status.kind === "loading" && (
        <div className="flex items-center justify-center gap-2 py-24 text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      )}
    </div>
  );
}
