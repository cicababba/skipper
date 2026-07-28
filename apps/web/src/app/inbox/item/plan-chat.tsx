"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import {
  CHAT_TURN_DETAILS,
  isPlanChatText,
  type PlanChatMessage,
  type StoredPlan,
} from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { hhmm } from "@/lib/inbox/chat-format";
import { ChatPanel, type ChatAdapter, type ChatPanelHandle } from "@/components/chat/chat-panel";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";

// Conversational plan review (#145): chat with the planning session while the
// item sits at plan-gate. Discuss (Q&A, plan untouched) or Apply (re-emit the
// plan). Transcript, composer and per-turn activity live in ChatPanel (#260).

interface PlanChatPanelProps {
  itemId: string;
  /** Editing a section or running a gate action locks the chat out. */
  disabled: boolean;
  onPlanUpdated: (stored: StoredPlan) => void;
  onBusyChange: (busy: boolean) => void;
  onCountChange?: (count: number) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

const TURN_DETAILS = [CHAT_TURN_DETAILS.planChat, CHAT_TURN_DETAILS.planApply];

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
  const c = t.inbox.chat;

  const [count, setCount] = useState(0);
  const [sendBusy, setSendBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  const panelRef = useRef<ChatPanelHandle>(null);

  useEffect(() => {
    onBusyChange(sendBusy || applyBusy);
  }, [sendBusy, applyBusy, onBusyChange]);

  const reportCount = useCallback(
    (n: number) => {
      setCount(n);
      onCountChange?.(n);
    },
    [onCountChange],
  );

  const adapter: ChatAdapter = useMemo(
    () => ({
      loadHistory: () => window.skipper?.planChat.getHistory(itemId) ?? Promise.resolve([]),
      send: async (text) => {
        const res = await window.skipper?.planChat.send(itemId, text);
        if (!res) return { ok: false };
        return res.ok ? { ok: true, reply: res.reply } : res;
      },
      cancel: () => void window.skipper?.planChat.cancel(itemId),
    }),
    [itemId],
  );

  const apply = async () => {
    if (sendBusy || applyBusy || disabled || count === 0 || !window.skipper) return;
    setApplyError(null);
    setApplyNotice(null);
    setApplyBusy(true);
    try {
      const res = await window.skipper.planChat.apply(itemId);
      if (res.ok) {
        onPlanUpdated(res.stored);
        await panelRef.current?.reload();
      } else if (res.cancelled) setApplyNotice(chat.cancelled);
      else setApplyError(res.error ? `${chat.applyFailed}: ${res.error}` : chat.applyFailed);
    } finally {
      setApplyBusy(false);
    }
  };

  const footer = (
    <>
      <button
        onClick={() => void apply()}
        disabled={count === 0 || sendBusy || applyBusy || disabled}
        className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
      >
        {applyBusy && <Loader2 size={11} className="animate-spin" />}
        {applyBusy ? chat.applying : chat.apply}
      </button>
      {applyNotice && <p className="text-[12px] text-muted/80">{applyNotice}</p>}
      {applyError && (
        <p className="rounded-lg border border-danger/25 bg-danger-bg px-3 py-2 text-[12px] text-danger break-all">
          {applyError}
        </p>
      )}
    </>
  );

  return (
    <ChatPanel
      ref={panelRef}
      itemId={itemId}
      adapter={adapter}
      stream={window.skipper?.planning}
      turnDetails={TURN_DETAILS}
      sendDetail={CHAT_TURN_DETAILS.planChat}
      placeholder={chat.placeholder}
      disabled={disabled}
      footer={footer}
      emptyState={<ChatEmptyState title={c.emptyPlanTitle} hint={chat.empty} />}
      renderSystemMessage={appliedMarker}
      onBusyChange={setSendBusy}
      onCountChange={reportCount}
      inputRef={inputRef}
    />
  );
}

function appliedMarker(message: PlanChatMessage) {
  if (isPlanChatText(message)) return null;
  return <AppliedMarker message={message} />;
}

function AppliedMarker({ message }: { message: Extract<PlanChatMessage, { kind: "applied" }> }) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;
  return (
    <div className="flex justify-center py-1">
      <span className="flex items-center gap-1.5 rounded-full bg-card-hover/40 px-2.5 py-0.5 text-[11px] text-muted/70">
        <Check size={11} className="text-success" />
        {chat.applied(message.changeCount)} · {hhmm(message.at)}
      </span>
    </div>
  );
}
