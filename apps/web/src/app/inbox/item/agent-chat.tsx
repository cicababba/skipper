"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  CHAT_TURN_DETAILS,
  canCoderChatApply,
  type AgentChatKind,
  type LifecycleState,
  type PrReviewComment,
} from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { ChatPanel, type ChatAdapter } from "@/components/chat/chat-panel";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";

// Coder / reviewer chat panel (#170): discuss-only clone of PlanChatPanel. The
// coder chat also carries Apply (#188): distill the discussion into re-entry
// instructions, preview them, then confirm to send the item back to coding.
// A dead agent session degrades to a fresh, seeded run. Transcript, composer
// and per-turn activity live in ChatPanel (#260).

interface AgentChatPanelProps {
  kind: AgentChatKind;
  itemId: string;
  /** Drives the coder-only Apply gate (#188). */
  itemState: LifecycleState;
  /** Worktree-relative path the user has open (coder only); passed as turn context. */
  selectedFile?: string | null;
  onBusyChange: (busy: boolean) => void;
  onCountChange?: (count: number) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

const TURN_DETAILS: Record<AgentChatKind, string[]> = {
  coder: [CHAT_TURN_DETAILS.coderChat, CHAT_TURN_DETAILS.coderApply],
  reviewer: [CHAT_TURN_DETAILS.reviewerChat],
};

const SEND_DETAIL: Record<AgentChatKind, string> = {
  coder: CHAT_TURN_DETAILS.coderChat,
  reviewer: CHAT_TURN_DETAILS.reviewerChat,
};

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
      ? {
          title: c.emptyCoderTitle,
          empty: c.emptyCoder,
          placeholder: c.placeholderCoder,
          fresh: c.freshCoder,
        }
      : {
          title: c.emptyReviewerTitle,
          empty: c.emptyReviewer,
          placeholder: c.placeholderReviewer,
          fresh: c.freshReviewer,
        };
  const applyAvailable = kind === "coder" && canCoderChatApply(itemState);

  const [count, setCount] = useState(0);
  const [sendBusy, setSendBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [pendingApply, setPendingApply] = useState<PrReviewComment[] | null>(null);

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
      loadHistory: () => window.skipper?.agentChat.getHistory(kind, itemId) ?? Promise.resolve([]),
      send: async (text) => {
        // A new message supersedes any previewed distillation.
        setPendingApply(null);
        const res = await window.skipper?.agentChat.send(
          kind,
          itemId,
          text,
          selectedFile ? { selectedFile } : undefined,
        );
        if (!res) return { ok: false };
        if (!res.ok) return res;
        setFresh(res.mode === "fresh");
        return { ok: true, reply: res.reply };
      },
      cancel: () => void window.skipper?.agentChat.cancel(kind, itemId),
    }),
    [kind, itemId, selectedFile],
  );

  const apply = async () => {
    if (sendBusy || applyBusy || count === 0 || !window.skipper) return;
    setApplyError(null);
    setApplyNotice(null);
    setApplyBusy(true);
    try {
      const res = await window.skipper.agentChat.prepareApply(itemId);
      if (res.ok) setPendingApply(res.instructions);
      else if (res.cancelled) setApplyNotice(chat.cancelled);
      else setApplyError(res.error ? `${c.applyFailed}: ${res.error}` : c.applyFailed);
    } finally {
      setApplyBusy(false);
    }
  };

  const confirmApply = async () => {
    if (sendBusy || applyBusy || !pendingApply || !window.skipper) return;
    setApplyError(null);
    setApplyNotice(null);
    setApplyBusy(true);
    try {
      const res = await window.skipper.agentChat.confirmApply(itemId, pendingApply);
      // On success the item transitions to coding; interlocutorFor unmounts this
      // panel via the manifest broadcast, so only clear the preview here.
      if (res.ok) setPendingApply(null);
      else setApplyError(res.error ? `${c.applyFailed}: ${res.error}` : c.applyFailed);
    } finally {
      setApplyBusy(false);
    }
  };

  const footer = (
    <>
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
              disabled={sendBusy || applyBusy}
              className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
            >
              {applyBusy && <Loader2 size={11} className="animate-spin" />}
              {c.applyConfirm}
            </button>
            <button
              onClick={() => setPendingApply(null)}
              disabled={sendBusy || applyBusy}
              className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
            >
              {c.applyCancel}
            </button>
          </div>
        </div>
      )}

      {applyAvailable && !pendingApply && (
        <button
          onClick={() => void apply()}
          disabled={count === 0 || sendBusy || applyBusy}
          className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
        >
          {applyBusy && <Loader2 size={11} className="animate-spin" />}
          {applyBusy ? c.applying : c.apply}
        </button>
      )}

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
      itemId={itemId}
      adapter={adapter}
      stream={kind === "coder" ? window.skipper?.coding : window.skipper?.review}
      turnDetails={TURN_DETAILS[kind]}
      sendDetail={SEND_DETAIL[kind]}
      placeholder={strings.placeholder}
      footer={footer}
      emptyState={<ChatEmptyState title={strings.title} hint={strings.empty} />}
      onBusyChange={setSendBusy}
      onCountChange={reportCount}
      inputRef={inputRef}
    />
  );
}
