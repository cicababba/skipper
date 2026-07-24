"use client";

import { useEffect } from "react";
import type { ReactNode, RefObject } from "react";
import { MessageCircle, Sparkles, X } from "lucide-react";
import { useT } from "@/lib/app-i18n";

// Generic chat FAB + docked drawer (#170, generalized from #167's plan chat).
// The panel is passed in as children so one drawer serves the plan, coder and
// reviewer interlocutors. A single FAB (one interlocutor is active at a time)
// owns focus return.

const FAB_ID = "item-chat-fab";

export function ChatFab({
  unread,
  busy,
  onClick,
  label,
  unreadLabel,
}: {
  unread: number;
  busy: boolean;
  onClick: () => void;
  label: string;
  unreadLabel: (n: number) => string;
}) {
  return (
    <button
      id={FAB_ID}
      onClick={onClick}
      aria-label={label}
      title={label}
      className="fixed bottom-6 right-6 z-[80] flex h-12 w-12 items-center justify-center rounded-full bg-accent text-background shadow-2xl transition-colors hover:bg-accent-hover"
    >
      {busy && (
        <span className="absolute -inset-1 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      )}
      <MessageCircle size={20} />
      {unread > 0 && (
        <span
          aria-label={unreadLabel(unread)}
          className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-medium text-background"
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

export function ChatDrawer({
  open,
  onClose,
  title,
  focusRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Focused when the drawer opens; the FAB regains focus on close. */
  focusRef: RefObject<HTMLInputElement | null>;
  children: ReactNode;
}) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      focusRef.current?.focus();
    } else {
      document.getElementById(FAB_ID)?.focus();
    }
  }, [open, focusRef]);

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-y-0 right-0 z-[90] flex w-full flex-col border-l border-border bg-card shadow-2xl transition-transform duration-200 wide:w-[420px] ${
        open ? "translate-x-0" : "translate-x-full pointer-events-none"
      }`}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-card-hover px-4 py-3">
        <Sparkles size={13} className="text-accent" />
        <h2 className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          {title}
        </h2>
        <button
          onClick={onClose}
          aria-label={chat.close}
          title={chat.close}
          className="p-1 rounded text-muted hover:text-foreground transition-colors"
        >
          <X size={16} />
        </button>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
