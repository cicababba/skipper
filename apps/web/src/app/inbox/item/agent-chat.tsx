"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import {
  canCoderChatApply,
  isPlanChatText,
  type AgentChatKind,
  type LifecycleState,
  type PlanChatMessage,
  type PrReviewComment,
} from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { EventConsole } from "@/components/event-console";
import { ConsoleMarkdown } from "@/components/console-markdown";

// Coder / reviewer chat panel (#170): discuss-only clone of PlanChatPanel. The
// coder chat also carries Apply (#188): distill the discussion into re-entry
// instructions, preview them, then confirm to send the item back to coding.
// Agent activity streams into the matching console (coding / review) while a
// turn runs; a dead agent session degrades to a fresh, seeded run.

interface AgentChatPanelProps {
  kind: AgentChatKind;
  itemId: string;
  /** Drives the coder-only Apply gate (#188). */
  itemState: LifecycleState;
  /** Worktree-relative path the user has open (coder only); passed as turn context. */
  selectedFile?: string | null;
  onBusyChange: (busy: boolean) => void;
  onCountChange?: (count: number) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

const STICKY_THRESHOLD = 24;

export function AgentChatPanel({
  kind,
  itemId,
  itemState,
  selectedFile,
  onBusyChange,
  onCountChange,
  inputRef,
}: AgentChatPanelProps) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;
  const c = t.inbox.chat;
  const strings =
    kind === "coder"
      ? { empty: c.emptyCoder, placeholder: c.placeholderCoder, fresh: c.freshCoder }
      : { empty: c.emptyReviewer, placeholder: c.placeholderReviewer, fresh: c.freshReviewer };
  const applyAvailable = kind === "coder" && canCoderChatApply(itemState);

  const [messages, setMessages] = useState<PlanChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"send" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [pendingApply, setPendingApply] = useState<PrReviewComment[] | null>(null);

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
    window.skipper.agentChat.getHistory(kind, itemId).then((h) => {
      if (!cancelled) setMessages(h);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, itemId]);

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
    if (!text || busy || !window.skipper) return;
    setMessages((m) => [...m, { role: "user", text, at: new Date().toISOString() }]);
    setInput("");
    setError(null);
    setNotice(null);
    // A new message supersedes any previewed distillation.
    setPendingApply(null);
    setBusy("send");
    try {
      const res = await window.skipper.agentChat.send(
        kind,
        itemId,
        text,
        selectedFile ? { selectedFile } : undefined,
      );
      if (res.ok) {
        setMessages((m) => [...m, { role: "assistant", text: res.reply, at: new Date().toISOString() }]);
        setFresh(res.mode === "fresh");
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
    if (busy || messages.length === 0 || !window.skipper) return;
    setError(null);
    setNotice(null);
    setBusy("apply");
    try {
      const res = await window.skipper.agentChat.prepareApply(itemId);
      if (res.ok) setPendingApply(res.instructions);
      else if (res.cancelled) setNotice(chat.cancelled);
      else setError(res.error ? `${c.applyFailed}: ${res.error}` : c.applyFailed);
    } finally {
      setBusy(null);
    }
  };

  const confirmApply = async () => {
    if (busy || !pendingApply || !window.skipper) return;
    setError(null);
    setNotice(null);
    setBusy("apply");
    try {
      const res = await window.skipper.agentChat.confirmApply(itemId, pendingApply);
      // On success the item transitions to coding; interlocutorFor unmounts this
      // panel via the manifest broadcast, so only clear the preview here.
      if (res.ok) setPendingApply(null);
      else setError(res.error ? `${c.applyFailed}: ${res.error}` : c.applyFailed);
    } finally {
      setBusy(null);
    }
  };

  const stream = kind === "coder" ? window.skipper?.coding : window.skipper?.review;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 space-y-2 text-sm"
      >
        {messages.length === 0 && !busy ? (
          <p className="text-[12px] text-muted/70">{strings.empty}</p>
        ) : (
          messages.map((m, i) =>
            !isPlanChatText(m) ? null : m.role === "user" ? (
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
        {busy && stream && (
          <EventConsole
            itemId={itemId}
            getEvents={stream.getEvents}
            onEvent={stream.onEvent}
            collapsible
            title={chat.activity}
          />
        )}

        {fresh && <p className="text-[12px] text-warning/80">{strings.fresh}</p>}

        {pendingApply && (
          <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <p className="text-[12px] font-medium text-accent">{c.applyPreviewTitle}</p>
            <ul className="max-h-[40vh] space-y-1.5 overflow-y-auto">
              {pendingApply.map((instr, i) => (
                <li key={i} className="text-[12px] text-foreground/90">
                  {instr.path && (
                    <span className="mr-1.5 rounded bg-card-hover px-1.5 py-0.5 font-mono text-[11px] text-muted">
                      {instr.path}
                    </span>
                  )}
                  <span className="whitespace-pre-wrap break-words">{instr.body}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void confirmApply()}
                disabled={!!busy}
                className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
              >
                {busy === "apply" && <Loader2 size={11} className="animate-spin" />}
                {c.applyConfirm}
              </button>
              <button
                onClick={() => setPendingApply(null)}
                disabled={!!busy}
                className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
              >
                {c.applyCancel}
              </button>
            </div>
          </div>
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
            placeholder={strings.placeholder}
            disabled={!!busy}
            className="flex-1 bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-2 py-1.5 text-sm disabled:opacity-50"
          />
          <button
            onClick={() => void submit()}
            disabled={!input.trim() || !!busy}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {busy === "send" ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            {chat.send}
          </button>
        </div>

        {applyAvailable && !pendingApply && (
          <button
            onClick={() => void apply()}
            disabled={messages.length === 0 || !!busy}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {busy === "apply" && <Loader2 size={11} className="animate-spin" />}
            {busy === "apply" ? c.applying : c.apply}
          </button>
        )}

        {notice && <p className="text-[12px] text-muted/80">{notice}</p>}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-bg text-danger px-3 py-2 text-[12px]">
            <span className="flex-1 break-all">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 hover:opacity-70">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
