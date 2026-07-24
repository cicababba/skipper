"use client";

import { useCallback, useSyncExternalStore } from "react";

// SSR-safe persisted UI state. The server snapshot is always the fallback;
// the client snapshot is applied right after hydration without a mismatch
// error (the useSyncExternalStore contract). Values are strings — callers
// encode/decode. The native "storage" event doesn't fire in the tab that
// wrote, so setters notify same-tab listeners explicitly.

type Store = "local" | "session";

const listeners = new Map<string, Set<() => void>>();

function storageOf(store: Store): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return store === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function emit(key: string) {
  listeners.get(key)?.forEach((cb) => cb());
}

export function useStoredState(
  key: string,
  fallback: string,
  store: Store = "local",
): [string, (value: string | ((current: string) => string)) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) cb();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(key);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );

  const read = useCallback((): string => {
    try {
      return storageOf(store)?.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }, [key, fallback, store]);

  const value = useSyncExternalStore(subscribe, read, () => fallback);

  const setValue = useCallback(
    (next: string | ((current: string) => string)) => {
      const resolved = typeof next === "function" ? next(read()) : next;
      try {
        storageOf(store)?.setItem(key, resolved);
      } catch {
        /* ignore quota/availability errors */
      }
      emit(key);
    },
    [key, store, read],
  );

  return [value, setValue];
}
