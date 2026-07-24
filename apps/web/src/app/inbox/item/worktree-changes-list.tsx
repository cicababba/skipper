"use client";

import { Circle, Loader2, RefreshCw } from "lucide-react";
import type { WorktreeFileChange } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { markerClass } from "@/lib/git-status-context";
import { FileIcon } from "@/components/file-icon";
import type { ChangesState } from "./worktree-detail";

const STATUS_MARKER: Record<WorktreeFileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

interface WorktreeChangesListProps {
  changes: ChangesState;
  selectedPath: string | null;
  dirty: boolean;
  onSelect: (change: WorktreeFileChange) => void;
  onRefresh: () => void;
}

// Flat list of changed worktree paths (#114), the "Changed only" alternative to
// the FileTree. Deleted files live only here since they're off disk.
export function WorktreeChangesList({
  changes,
  selectedPath,
  dirty,
  onSelect,
  onRefresh,
}: WorktreeChangesListProps) {
  const { t } = useT();
  const r = t.inbox.review;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border text-[11px] text-muted shrink-0">
        <span>{changes.kind === "ready" ? r.filesChanged(changes.files.length) : r.title}</span>
        <button
          onClick={onRefresh}
          className="p-1 rounded hover:text-foreground transition-colors"
          title={r.refresh}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {changes.kind === "loading" && (
          <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted">
            <Loader2 size={12} className="animate-spin" />
            {r.loading}
          </div>
        )}
        {changes.kind === "error" && (
          <p className="px-3 py-2 text-[12px] text-danger break-all">
            {r.loadFailed}: {changes.message}
          </p>
        )}
        {changes.kind === "ready" && changes.files.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-muted">{r.noChanges}</p>
        )}
        {changes.kind === "ready" &&
          changes.files.map((change) => {
            const marker = STATUS_MARKER[change.status];
            const active = change.path === selectedPath;
            return (
              <button
                key={change.path}
                onClick={() => onSelect(change)}
                className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-left transition-colors ${
                  active ? "bg-card-hover text-foreground" : "text-muted hover:bg-card-hover/50"
                }`}
                title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
              >
                <span className={`font-mono shrink-0 w-3 ${markerClass(marker)}`}>{marker}</span>
                <FileIcon name={change.path.split("/").pop() ?? change.path} size={13} />
                <span className="truncate min-w-0 flex-1" dir="rtl">
                  {change.path}
                </span>
                {active && dirty && <Circle size={7} className="shrink-0 fill-accent text-accent" />}
              </button>
            );
          })}
      </div>
    </div>
  );
}
