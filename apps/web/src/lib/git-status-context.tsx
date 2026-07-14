"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Live git-status cache (public core — issue #1). The file tree registers
// every repo top it renders; we poll their status and expose it as a map so
// rows get per-file markers and the branch chip lights up. Backend is the
// public git engine in apps/desktop/src/git.ts.

export interface GitFileStatus {
  index: string; // 1 char
  worktree: string;
}

export interface GitRepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: Record<string, GitFileStatus>;
  hasUpstream?: boolean;
}

interface GitStatusState {
  repos: Record<string, GitRepoStatus | null>;
  registerRepo: (repoPath: string) => void;
  refresh: () => void;
}

const GitStatusContext = createContext<GitStatusState>({
  repos: {},
  registerRepo: () => {},
  refresh: () => {},
});

const POLL_MS = 10_000;

export function GitStatusProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<Record<string, GitRepoStatus | null>>({});
  const tracked = useRef<Set<string>>(new Set());

  const fetchOne = useCallback((repoPath: string) => {
    if (typeof window === "undefined" || !window.skipper?.git) return;
    void window.skipper.git.status(repoPath).then((status) => {
      setRepos((prev) => ({ ...prev, [repoPath]: status }));
    });
  }, []);

  const registerRepo = useCallback(
    (repoPath: string) => {
      if (tracked.current.has(repoPath)) return;
      tracked.current.add(repoPath);
      fetchOne(repoPath);
    },
    [fetchOne],
  );

  const refresh = useCallback(() => {
    for (const repoPath of tracked.current) fetchOne(repoPath);
  }, [fetchOne]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.skipper?.git) return;
    const interval = setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return (
    <GitStatusContext.Provider value={{ repos, registerRepo, refresh }}>
      {children}
    </GitStatusContext.Provider>
  );
}

export function useGitStatus() {
  return useContext(GitStatusContext);
}

export function pickMarker(file: GitFileStatus | undefined): string {
  if (!file) return "";
  const w = file.worktree;
  const i = file.index;
  if (w === "?" && i === "?") return "U"; // untracked
  if (w === "M" || i === "M") return "M";
  if (i === "A") return "A";
  if (w === "D" || i === "D") return "D";
  if (w === "!" || i === "!") return "!"; // ignored
  if (i === "R") return "R";
  return (w !== " " ? w : i).trim();
}

export function markerClass(marker: string): string {
  switch (marker) {
    case "M":
      return "text-amber-400";
    case "U":
    case "A":
      return "text-emerald-400";
    case "D":
      return "text-red-400";
    case "R":
      return "text-violet-400";
    default:
      return "text-muted/40";
  }
}
