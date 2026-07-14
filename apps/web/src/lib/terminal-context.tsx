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

// Terminal session manager (public core — issue #18). Owns the session
// list and panel state; the xterm rendering lives in terminal-panel.tsx.
// Backend is the public PTY engine in apps/desktop/src/terminal.ts.

export interface TerminalSession {
  id: string;
  cwd: string;
  label: string;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeId: string | null;
  panelOpen: boolean;
  openTerminal: (cwd: string, label: string) => Promise<void>;
  newTerminal: () => Promise<void>;
  setActive: (id: string) => void;
  closeTerminal: (id: string) => void;
  togglePanel: () => void;
  toggleOrOpen: () => Promise<void>;
}

const TerminalContext = createContext<TerminalState>({
  sessions: [],
  activeId: null,
  panelOpen: false,
  openTerminal: async () => {},
  newTerminal: async () => {},
  setActive: () => {},
  closeTerminal: () => {},
  togglePanel: () => {},
  toggleOrOpen: async () => {},
});

function terminalApi() {
  if (typeof window === "undefined") return null;
  return window.skipper?.terminal ?? null;
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const exitUnsubs = useRef<Map<string, () => void>>(new Map());

  const removeSession = useCallback((id: string) => {
    exitUnsubs.current.get(id)?.();
    exitUnsubs.current.delete(id);
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setActiveId((cur) => (cur === id ? (next[next.length - 1]?.id ?? null) : cur));
      if (next.length === 0) setPanelOpen(false);
      return next;
    });
  }, []);

  const openTerminal = useCallback(
    async (cwd: string, label: string) => {
      const api = terminalApi();
      if (!api) return;
      const { id } = await api.create({ cwd });
      // Shell exited on its own (user typed `exit`, crash): drop the tab.
      exitUnsubs.current.set(
        id,
        api.onExit(id, () => removeSession(id)),
      );
      setSessions((prev) => [...prev, { id, cwd, label }]);
      setActiveId(id);
      setPanelOpen(true);
    },
    [removeSession],
  );

  // No default cwd since the workspace was removed (#39) — the worktree
  // control center (#40) will wire this to the selected item's worktree.
  const newTerminal = useCallback(async () => {}, []);

  const setActive = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const closeTerminal = useCallback(
    (id: string) => {
      terminalApi()?.kill(id);
      removeSession(id);
    },
    [removeSession],
  );

  const togglePanel = useCallback(() => {
    setPanelOpen((v) => !v);
  }, []);

  const toggleOrOpen = useCallback(async () => {
    if (sessions.length === 0) {
      await newTerminal();
    } else {
      setPanelOpen((v) => !v);
    }
  }, [sessions.length, newTerminal]);

  // Unmount (page navigation in dev): drop exit listeners; the sessions
  // themselves survive in the main process until killed or app quit.
  useEffect(() => {
    const unsubs = exitUnsubs.current;
    return () => {
      for (const unsub of unsubs.values()) unsub();
      unsubs.clear();
    };
  }, []);

  return (
    <TerminalContext.Provider
      value={{
        sessions,
        activeId,
        panelOpen,
        openTerminal,
        newTerminal,
        setActive,
        closeTerminal,
        togglePanel,
        toggleOrOpen,
      }}
    >
      {children}
    </TerminalContext.Provider>
  );
}

export function useTerminal() {
  return useContext(TerminalContext);
}
