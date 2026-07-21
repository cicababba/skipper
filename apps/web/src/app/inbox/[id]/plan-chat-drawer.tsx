"use client";

import { useEffect, useRef } from "react";
import { MessageCircle, Sparkles, X } from "lucide-react";
import type { StoredPlan } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { PlanChatPanel } from "./plan-chat";

const FAB_ID = "plan-chat-fab";

export function PlanChatFab({
  unread,
  busy,
  onClick,
}: {
  unread: number;
  busy: boolean;
  onClick: () => void;
}) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;
  return (
    <button
      id={FAB_ID}
      onClick={onClick}
      aria-label={chat.open}
      title={chat.open}
      className="fixed bottom-6 right-6 z-[80] flex h-12 w-12 items-center justify-center rounded-full bg-accent text-background shadow-2xl transition-colors hover:bg-accent-hover"
    >
      {busy && (
        <span className="absolute -inset-1 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      )}
      <MessageCircle size={20} />
      {unread > 0 && (
        <span
          aria-label={chat.unread(unread)}
          className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white"
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

export function PlanChatDrawer({
  open,
  onClose,
  itemId,
  disabled,
  onPlanUpdated,
  onBusyChange,
  onCountChange,
}: {
  open: boolean;
  onClose: () => void;
  itemId: string;
  disabled: boolean;
  onPlanUpdated: (stored: StoredPlan) => void;
  onBusyChange: (busy: boolean) => void;
  onCountChange: (count: number) => void;
}) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      inputRef.current?.focus();
    } else {
      document.getElementById(FAB_ID)?.focus();
    }
  }, [open]);

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
          {chat.title}
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
      <div className="flex-1 min-h-0">
        <PlanChatPanel
          itemId={itemId}
          disabled={disabled}
          onPlanUpdated={onPlanUpdated}
          onBusyChange={onBusyChange}
          onCountChange={onCountChange}
          inputRef={inputRef}
        />
      </div>
    </div>
  );
}
