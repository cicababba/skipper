"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import type { PlanChatMessage, StoredPlan } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { EventConsole } from "@/components/event-console";
import { ConsoleMarkdown } from "@/components/console-markdown";

// Conversational plan review (#145): chat with the planning session while the
// item sits at plan-gate. Discuss (Q&A, plan untouched) or Apply (re-emit the
// plan). Agent activity streams into the planner console while a turn runs.

interface PlanChatPanelProps {
  itemId: string;
  /** Editing a section or running a gate action locks the chat out. */
  disabled: boolean;
  onPlanUpdated: (stored: StoredPlan) => void;
  onBusyChange: (busy: boolean) => void;
  onCountChange?: (count: number) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

const STICKY_THRESHOLD = 24;

export function PlanChatPanel({
  itemId,
  disabled,
  onPlanUpdated,
  onBusyChange,
  onCountChange,
  inputRef,
}: PlanChatPanelProps) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;

  const [messages, setMessages] = useState<PlanChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"send" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);

  useEffect(() => {
    onBusyChange(busy !== null);
  }, [busy, onBusyChange]);

  useEffect(() => {
    onCountChange?.(messages.length);
  }, [messages.length, onCountChange]);

  useEffect(() => {
    if (!window.skipper) return;
    let cancelled = false;
    window.skipper.planChat.getHistory(itemId).then((h) => {
      if (!cancelled) setMessages(h);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stuckRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - STICKY_THRESHOLD;
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || busy || disabled || !window.skipper) return;
    setMessages((m) => [...m, { role: "user", text, at: new Date().toISOString() }]);
    setInput("");
    setError(null);
    setNotice(null);
    setBusy("send");
    try {
      const res = await window.skipper.planChat.send(itemId, text);
      if (res.ok) {
        setMessages((m) => [...m, { role: "assistant", text: res.reply, at: new Date().toISOString() }]);
      } else {
        // Roll back the optimistic user turn and hand the text back.
        setMessages((m) => m.slice(0, -1));
        setInput(text);
        if (res.cancelled) setNotice(chat.cancelled);
        else setError(res.error ? `${chat.failed}: ${res.error}` : chat.failed);
      }
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (busy || disabled || messages.length === 0 || !window.skipper) return;
    setError(null);
    setNotice(null);
    setBusy("apply");
    try {
      const res = await window.skipper.planChat.apply(itemId);
      if (res.ok) onPlanUpdated(res.stored);
      else if (res.cancelled) setNotice(chat.cancelled);
      else setError(res.error ? `${chat.applyFailed}: ${res.error}` : chat.applyFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 space-y-2 text-sm"
      >
        {messages.length === 0 && !busy ? (
          <p className="text-[12px] text-muted/70">{chat.empty}</p>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-card-hover/40 px-3 py-2 whitespace-pre-wrap break-words">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="max-w-[90%] text-foreground/90">
                <ConsoleMarkdown content={m.text} />
              </div>
            ),
          )
        )}
        {busy === "send" && (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Loader2 size={13} className="animate-spin" />
            {chat.thinking}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-card-hover p-4 space-y-3">
        {busy && (
          <EventConsole
            itemId={itemId}
            getEvents={window.skipper!.planning.getEvents}
            onEvent={window.skipper!.planning.onEvent}
            collapsible
            title={chat.activity}
          />
        )}

        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={chat.placeholder}
            disabled={!!busy || disabled}
            className="flex-1 bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-2 py-1.5 text-sm disabled:opacity-50"
          />
          <button
            onClick={() => void submit()}
            disabled={!input.trim() || !!busy || disabled}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {busy === "send" ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            {chat.send}
          </button>
        </div>

        <button
          onClick={() => void apply()}
          disabled={messages.length === 0 || !!busy || disabled}
          className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
        >
          {busy === "apply" && <Loader2 size={11} className="animate-spin" />}
          {busy === "apply" ? chat.applying : chat.apply}
        </button>

        {notice && <p className="text-[12px] text-muted/80">{notice}</p>}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2 text-[12px]">
            <span className="flex-1 break-all">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 hover:text-red-200">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
