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

export type ToastVariant = "info" | "success" | "error";

export interface ToastOptions {
  /** Stable id — issuing the same id again replaces the toast in place. */
  id?: string;
  variant?: ToastVariant;
  title: string;
  message?: string;
  icon?: ReactNode;
  action?: { label: string; onClick: () => void };
  /** Explicit value forces auto-dismiss even for error/action toasts. */
  durationMs?: number;
  dismissLabel?: string;
  /** Fired only when the user clicks dismiss, not on auto-dismiss. */
  onDismiss?: () => void;
}

export interface ToastItem extends ToastOptions {
  id: string;
  variant: ToastVariant;
}

interface ToastState {
  toasts: ToastItem[];
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

export const VISIBLE_TOASTS = 3;
const DEFAULT_DURATION_MS = 5000;

function autoDismissMs(item: ToastItem): number | null {
  if (item.durationMs !== undefined) return item.durationMs;
  if (item.variant === "error" || item.action) return null;
  return DEFAULT_DURATION_MS;
}

const ToastContext = createContext<ToastState>({
  toasts: [],
  toast: () => "",
  dismiss: () => {},
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = options.id ?? `toast-${++counter.current}`;
    const item: ToastItem = { ...options, id, variant: options.variant ?? "info" };
    setToasts((cur) => {
      const idx = cur.findIndex((t) => t.id === id);
      if (idx < 0) return [...cur, item];
      const next = [...cur];
      next[idx] = item;
      return next;
    });
    return id;
  }, []);

  // Timers start only once a toast is visible, so a queued toast gets its full
  // duration after being promoted into a free slot.
  useEffect(() => {
    const pending = timers.current;
    const visible = toasts.slice(0, VISIBLE_TOASTS);
    const visibleIds = new Set(visible.map((t) => t.id));
    for (const [id, handle] of pending) {
      if (!visibleIds.has(id)) {
        clearTimeout(handle);
        pending.delete(id);
      }
    }
    for (const item of visible) {
      if (pending.has(item.id)) continue;
      const ms = autoDismissMs(item);
      if (ms === null) continue;
      pending.set(
        item.id,
        setTimeout(() => {
          pending.delete(item.id);
          dismiss(item.id);
        }, ms),
      );
    }
  }, [toasts, dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending.values()) clearTimeout(handle);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
