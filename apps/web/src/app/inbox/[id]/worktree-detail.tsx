"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  FolderX,
  GitBranch,
  Inbox,
  Loader2,
  SquareTerminal,
  Sparkles,
} from "lucide-react";
import {
  displayKey,
  slugKey,
  type WorktreeFileChange,
  type WorktreeStatusResult,
} from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useTerminal } from "@/lib/terminal-context";
import { useT } from "@/lib/app-i18n";
import {
  buildClaudePrompt,
  changeForRelPath,
  shellQuote,
  worktreeRelPath,
} from "@/lib/inbox/worktree";
import { FileTree } from "@/components/file-tree";
import { useItemChat } from "./item-chat";
import { MemoriesCard } from "./memories-card";
import { WorktreeFileView } from "./worktree-file-view";
import { WorktreeChangesList } from "./worktree-changes-list";
import { WorktreeDiffView } from "./worktree-diff-view";

type StatusState =
  | { kind: "loading" }
  | { kind: "ready"; status: Extract<WorktreeStatusResult, { ok: true }> }
  | { kind: "error"; message: string };

export type ChangesState =
  | { kind: "loading" }
  | { kind: "ready"; files: WorktreeFileChange[] }
  | { kind: "error"; message: string };

type Selection =
  | { kind: "plain"; absPath: string }
  | { kind: "changed"; change: WorktreeFileChange };

// Worktree control center (#40/#114): file tree + per-line diff rooted at the
// item's worktree, a changed-only toggle, plus terminal / claude entry points.
export function WorktreeDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state } = useOrchestrator();
  const { openTerminal } = useTerminal();
  const { t } = useT();
  const w = t.inbox.worktree;
  const r = t.inbox.review;

  const item = state?.items.find((i) => i.id === id);
  const worktree = item?.worktree;

  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [listMode, setListMode] = useState<"all" | "changed">("all");
  const [viewMode, setViewMode] = useState<"split" | "unified" | "edit">("split");
  const [changes, setChanges] = useState<ChangesState>({ kind: "loading" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);

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

  const ready = status.kind === "ready" ? status.status : null;
  const usable = ready?.present === true;

  // Feed the coder chat (#170) the worktree-relative path of the open file, so a
  // coder-chat turn treats it as the subject. Cleared when the tab unmounts.
  const { setWorktreeSelection } = useItemChat();
  useEffect(() => {
    if (!ready) {
      setWorktreeSelection(null);
      return;
    }
    const rel =
      selection?.kind === "changed"
        ? selection.change.path
        : selection?.kind === "plain"
          ? worktreeRelPath(ready.path, selection.absPath)
          : null;
    setWorktreeSelection(rel);
    return () => setWorktreeSelection(null);
  }, [selection, ready, setWorktreeSelection]);

  const fetchChanges = useCallback(
    async (keepSelection: boolean) => {
      if (!window.skipper) return;
      if (!keepSelection) setChanges({ kind: "loading" });
      const result = await window.skipper.orchestrator.getWorktreeChanges(id);
      if (result.ok) setChanges({ kind: "ready", files: result.files });
      else setChanges({ kind: "error", message: result.error });
    },
    [id],
  );

  useEffect(() => {
    if (!usable || !window.skipper) return;
    let cancelled = false;
    window.skipper.orchestrator.getWorktreeChanges(id).then((result) => {
      if (cancelled) return;
      setChanges(
        result.ok
          ? { kind: "ready", files: result.files }
          : { kind: "error", message: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [id, usable]);

  const currentName =
    selection?.kind === "changed"
      ? selection.change.path
      : selection?.kind === "plain"
        ? selection.absPath
        : "";

  const select = useCallback(
    (next: Selection | null) => {
      if (dirtyRef.current && !window.confirm(r.unsavedSwitch(currentName))) return;
      setSelection(next);
    },
    [r, currentName],
  );

  const toggleListMode = (mode: "all" | "changed") => {
    if (mode === listMode) return;
    if (dirtyRef.current && !window.confirm(r.unsavedSwitch(currentName))) return;
    setListMode(mode);
  };

  const openFileFromTree = (abs: string) => {
    if (!ready) return;
    const rel = worktreeRelPath(ready.path, abs);
    const files = changes.kind === "ready" ? changes.files : [];
    const change = changeForRelPath(files, rel);
    select(change ? { kind: "changed", change } : { kind: "plain", absPath: abs });
  };

  if (!item || !worktree) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <Inbox size={40} className="opacity-30" />
        <p className="text-sm text-muted max-w-md">{w.noWorktree}</p>
      </div>
    );
  }

  const terminalLabel = `issue-${slugKey(item.key)}`;

  const openWorktreeTerminal = () => {
    if (!ready) return;
    void openTerminal(ready.path, terminalLabel);
  };

  const openClaudeWithContext = () => {
    if (!ready) return;
    const prompt = buildClaudePrompt({
      keyLabel: displayKey(item.key),
      title: item.title,
      branch: worktree.branch,
      changedFiles: changes.kind === "ready" ? changes.files.map((c) => c.path) : [],
    });
    void openTerminal(ready.path, `claude · ${terminalLabel}`, `claude ${shellQuote(prompt)}`);
  };

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <div className="flex items-center gap-2 flex-wrap shrink-0 text-[12px] text-muted">
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-card font-mono text-[11px]"
          title={ready?.path ?? worktree.path}
        >
          <GitBranch size={11} />
          {worktree.branch}
        </span>
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
              onClick={openClaudeWithContext}
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            >
              <Sparkles size={13} />
              {w.openClaudeContext}
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
            <div className="w-64 shrink-0 border-r border-border bg-sidebar flex flex-col min-h-0">
              <div className="flex items-center gap-0.5 p-1 border-b border-border shrink-0 text-[11px]">
                <button
                  onClick={() => toggleListMode("all")}
                  className={`flex-1 px-2 py-1 rounded transition-colors ${
                    listMode === "all"
                      ? "bg-card-hover text-foreground"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {w.allFiles}
                </button>
                <button
                  onClick={() => toggleListMode("changed")}
                  className={`flex-1 px-2 py-1 rounded transition-colors ${
                    listMode === "changed"
                      ? "bg-card-hover text-foreground"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {w.changedOnly}
                </button>
              </div>
              <div className="flex-1 min-h-0">
                {listMode === "all" ? (
                  <FileTree
                    rootPath={ready.path}
                    rootLabel={terminalLabel}
                    onOpenFile={openFileFromTree}
                  />
                ) : (
                  <WorktreeChangesList
                    changes={changes}
                    selectedPath={selection?.kind === "changed" ? selection.change.path : null}
                    dirty={dirty}
                    onSelect={(change) => select({ kind: "changed", change })}
                    onRefresh={() => void fetchChanges(false)}
                  />
                )}
              </div>
            </div>
            <div className="flex-1 min-w-0 bg-background">
              {selection?.kind === "changed" ? (
                <WorktreeDiffView
                  key={selection.change.path}
                  itemId={id}
                  change={selection.change}
                  mode={viewMode}
                  onModeChange={setViewMode}
                  onSaved={() => void fetchChanges(true)}
                  onDirtyChange={(next) => {
                    dirtyRef.current = next;
                    setDirty(next);
                  }}
                />
              ) : selection?.kind === "plain" ? (
                <WorktreeFileView key={selection.absPath} path={selection.absPath} />
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
