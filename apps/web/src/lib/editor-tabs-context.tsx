"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useStoredState } from "./use-stored-state";

interface EditorTabsState {
  tabs: string[]; // absolute file paths, insertion order
  activePath: string | null;
  /**
   * Mark a file as open + active. If it's already in the list, just
   * promote it to active without changing order (VSCode style — opening
   * the same file again doesn't shuffle the tab strip).
   */
  openTab: (path: string) => void;
  closeTab: (path: string) => string | null; // returns the next active path, or null
  setActive: (path: string) => void;
  closeOthers: (keepPath: string) => void;
  closeAll: () => void;
}

const EditorTabsContext = createContext<EditorTabsState>({
  tabs: [],
  activePath: null,
  openTab: () => {},
  closeTab: () => null,
  setActive: () => {},
  closeOthers: () => {},
  closeAll: () => {},
});

const STORAGE_KEY = "nestbrain-editor-tabs";

interface Persisted {
  tabs: string[];
  activePath: string | null;
}

function parsePersisted(raw: string): Persisted {
  try {
    const parsed = JSON.parse(raw) as Persisted;
    if (Array.isArray(parsed.tabs)) {
      return {
        tabs: parsed.tabs.filter((p) => typeof p === "string" && p),
        activePath: typeof parsed.activePath === "string" ? parsed.activePath : null,
      };
    }
  } catch {
    /* ignore */
  }
  return { tabs: [], activePath: null };
}

export function EditorTabsProvider({ children }: { children: ReactNode }) {
  // sessionStorage (not localStorage) so closing the app forgets the open
  // files — the user starts each session fresh, same as VSCode's default.
  const [raw, setRaw] = useStoredState(STORAGE_KEY, "", "session");
  const { tabs, activePath } = useMemo(() => parsePersisted(raw), [raw]);

  const update = useCallback(
    (fn: (cur: Persisted) => Persisted) =>
      setRaw((cur) => JSON.stringify(fn(parsePersisted(cur)))),
    [setRaw],
  );

  const openTab = useCallback(
    (path: string) => {
      if (!path) return;
      update((cur) => ({
        tabs: cur.tabs.includes(path) ? cur.tabs : [...cur.tabs, path],
        activePath: path,
      }));
    },
    [update],
  );

  const closeTab = useCallback(
    (path: string) => {
      let nextActive: string | null = null;
      // The hook's functional update runs synchronously, so nextActive is
      // assigned before we return it.
      update((cur) => {
        const idx = cur.tabs.indexOf(path);
        if (idx < 0) {
          nextActive = cur.activePath;
          return cur;
        }
        const next = cur.tabs.filter((p) => p !== path);
        // If we just closed the active tab, prefer the right neighbor,
        // falling back to the left one. That matches VSCode's behavior.
        nextActive = cur.activePath === path ? (next[idx] ?? next[idx - 1] ?? null) : cur.activePath;
        return { tabs: next, activePath: nextActive };
      });
      return nextActive;
    },
    [update],
  );

  const setActive = useCallback(
    (path: string) => {
      update((cur) => ({ ...cur, activePath: path }));
    },
    [update],
  );

  const closeOthers = useCallback(
    (keepPath: string) => {
      update((cur) => ({
        tabs: cur.tabs.includes(keepPath) ? [keepPath] : cur.tabs,
        activePath: keepPath,
      }));
    },
    [update],
  );

  const closeAll = useCallback(() => {
    update(() => ({ tabs: [], activePath: null }));
  }, [update]);

  return (
    <EditorTabsContext.Provider
      value={{ tabs, activePath, openTab, closeTab, setActive, closeOthers, closeAll }}
    >
      {children}
    </EditorTabsContext.Provider>
  );
}

export function useEditorTabs() {
  return useContext(EditorTabsContext);
}
