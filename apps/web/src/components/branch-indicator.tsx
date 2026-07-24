"use client";

import { useEffect, useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import { useGitStatus } from "@/lib/git-status-context";

// Branch chip (public core — issue #1). Shows the active repo's branch and
// ahead/behind counts. The file tree broadcasts the active repo via the
// "skipper:focus-project" event; with a single tracked repo we don't wait
// for a click.

export function BranchIndicator() {
  const { repos } = useGitStatus();
  const [focusedRepo, setFocusedRepo] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ repoPath?: string }>).detail;
      if (detail?.repoPath) setFocusedRepo(detail.repoPath);
    };
    window.addEventListener("skipper:focus-project", handler);
    return () => window.removeEventListener("skipper:focus-project", handler);
  }, []);

  const active = useMemo(() => {
    const keys = Object.keys(repos).filter((k) => repos[k]);
    if (focusedRepo && repos[focusedRepo]) return focusedRepo;
    if (keys.length === 1) return keys[0];
    return null;
  }, [repos, focusedRepo]);

  const status = active ? repos[active] : null;
  if (!status?.branch) return null;

  return (
    <span
      className="flex items-center gap-1 text-[10px] text-muted/60 font-mono truncate"
      title={active ?? undefined}
    >
      <GitBranch size={10} className="shrink-0" />
      <span className="truncate">{status.branch}</span>
      {status.ahead > 0 && <span className="text-success shrink-0">↑{status.ahead}</span>}
      {status.behind > 0 && <span className="text-warning shrink-0">↓{status.behind}</span>}
    </span>
  );
}
