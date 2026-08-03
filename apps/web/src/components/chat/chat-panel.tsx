"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import {
  isPlanChatText,
  type AttachComposerFileResult,
  type ChatErrorKind,
  type PlanChatAttachment,
  type PlanChatMessage,
} from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { buildTranscript } from "@/lib/inbox/chat-transcript";
import { draftFromTurn } from "@/lib/inbox/chat-draft";
import { ChatComposer, type PendingChatAttachment } from "./chat-composer";
import { ChatTranscript } from "./chat-transcript";
import { useChatStream, type ChatStreamSource } from "./use-chat-stream";

// Shared chat panel (#260): the transcript + composer half every interlocutor
// has in common. The caller supplies an adapter (history / send / cancel), the
// streams that carry the agent's activity, and whatever per-kind actions belong
// under the composer.

export interface ChatSendResult {
  ok: boolean;
  reply?: string;
  error?: string;
  /** Structured failure cause (#301) — localized here, with `error` as detail. */
  errorKind?: ChatErrorKind;
  cancelled?: boolean;
}

export interface ChatAdapter {
  loadHistory: () => Promise<PlanChatMessage[]>;
  send: (text: string, attachments?: PlanChatAttachment[]) => Promise<ChatSendResult>;
  /** Presence turns the Send button into Stop while a turn is in flight. */
  cancel?: () => void;
}

/** Attachments (#281) are opt-in per interlocutor: without this adapter the
 *  composer renders no chip strip and ignores paste/drop. */
export interface ChatAttachmentsAdapter {
  attach: (file: File) => Promise<AttachComposerFileResult>;
  detach: (path: string) => void;
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const ATTACHABLE_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
  ".yaml",
  ".yml",
];
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

interface PendingAttachment extends PendingChatAttachment {
  path: string;
}

export interface ChatPanelHandle {
  reload: () => Promise<void>;
}

interface ChatPanelProps {
  itemId: string;
  /** Memoize on everything the calls close over, or history refetches on every render. */
  adapter: ChatAdapter;
  stream?: ChatStreamSource;
  /** Resuming-details that open a turn on this chat's stream (send + apply). */
  turnDetails: string[];
  /** The detail marking a send turn — its text events feed the streamed draft. */
  sendDetail: string;
  placeholder: string;
  disabled?: boolean;
  footer?: ReactNode;
  emptyState?: ReactNode;
  renderSystemMessage?: (message: PlanChatMessage) => ReactNode;
  /** Send busy only — wrappers OR in their own apply state. */
  onBusyChange: (busy: boolean) => void;
  onCountChange?: (count: number) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  attachments?: ChatAttachmentsAdapter;
  className?: string;
}

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  {
    itemId,
    adapter,
    stream,
    turnDetails,
    sendDetail,
    placeholder,
    disabled,
    footer,
    emptyState,
    renderSystemMessage,
    onBusyChange,
    onCountChange,
    inputRef,
    attachments,
    className,
  },
  ref,
) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;
  const chatT = t.inbox.chat;

  const [messages, setMessages] = useState<PlanChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // The failed bubble is tracked by its timestamp: sends are serialized by
  // `busy`, so the optimistic `at` identifies it across list edits.
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachWarning, setAttachWarning] = useState(false);

  // Previews are ObjectURLs keyed by the saved path, so a failed send can hand
  // the same chips back on dismiss instead of losing the thumbnail.
  const previewUrls = useRef(new Map<string, string>());
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pending;

  const releasePreview = useCallback((path: string) => {
    const url = previewUrls.current.get(path);
    if (!url) return;
    URL.revokeObjectURL(url);
    previewUrls.current.delete(path);
  }, []);

  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const turns = useChatStream(itemId, turnDetails, stream);
  const textCount = messages.filter(isPlanChatText).length;

  // A send may land before the initial history resolves; the optimistic bubble
  // must not be wiped by a load that started before it.
  const editedRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const reload = useCallback(async () => {
    const history = await adapter.loadHistory();
    editedRef.current = false;
    setMessages(history);
  }, [adapter]);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    onCountChange?.(textCount);
  }, [textCount, onCountChange]);

  useEffect(() => {
    let cancelled = false;
    // A new adapter (item, kind or context switch) is a fresh transcript, so an
    // earlier local edit stops protecting the list — unless a send is running.
    if (!busyRef.current) editedRef.current = false;
    void adapter.loadHistory().then((history) => {
      if (!cancelled && !editedRef.current) setMessages(history);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  useImperativeHandle(ref, () => ({ reload }), [reload]);

  // The live send turn: newest open turn opened by our own send detail.
  const liveSendTurn = busy
    ? [...turns].reverse().find((turn) => turn.open && turn.detail === sendDetail) ?? null
    : null;
  const draft = draftFromTurn(liveSendTurn);

  const sentAt = (at: string) => (m: PlanChatMessage) =>
    isPlanChatText(m) && m.role === "user" && m.at === at;
  const failedIndex = failedAt === null ? -1 : messages.findIndex(sentAt(failedAt));

  const items = useMemo(
    () =>
      buildTranscript(messages, turns, {
        failedIndex: failedIndex < 0 ? undefined : failedIndex,
        draft,
      }),
    [messages, turns, failedIndex, draft],
  );

  const attachFiles = async (files: File[]) => {
    if (!attachments) return;
    setError(null);
    for (const file of files) {
      if (pendingRef.current.length >= MAX_ATTACHMENTS) {
        setError(chatT.attachLimit);
        return;
      }
      if (!ATTACHABLE_EXTENSIONS.includes(extensionOf(file.name))) {
        setError(chatT.attachInvalidType);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(chatT.attachTooLarge);
        continue;
      }
      const res = await attachments.attach(file);
      if (!res.ok) {
        setError(res.error ? `${chatT.attachFailed}: ${res.error}` : chatT.attachFailed);
        continue;
      }
      const previewUrl = IMAGE_EXTENSIONS.includes(extensionOf(res.name))
        ? URL.createObjectURL(file)
        : undefined;
      if (previewUrl) previewUrls.current.set(res.path, previewUrl);
      const added: PendingAttachment = {
        id: res.path,
        name: res.name,
        path: res.path,
        ...(previewUrl ? { previewUrl } : {}),
      };
      pendingRef.current = [...pendingRef.current, added];
      setPending(pendingRef.current);
      if (!res.supported) setAttachWarning(true);
    }
  };

  const removeAttachment = (id: string) => {
    const next = pendingRef.current.filter((a) => a.id !== id);
    pendingRef.current = next;
    setPending(next);
    if (next.length === 0) setAttachWarning(false);
    releasePreview(id);
    attachments?.detach(id);
  };

  /** Rebuild the input chips from a message's attachments — the previews are
   *  still alive, so a dismissed failure looks exactly as it did before Send. */
  const chipsFrom = (attached: PlanChatAttachment[]): PendingAttachment[] =>
    attached.map((a) => {
      const previewUrl = previewUrls.current.get(a.path);
      return { id: a.path, name: a.name, path: a.path, ...(previewUrl ? { previewUrl } : {}) };
    });

  const send = async (text: string, attached: PlanChatAttachment[] = []) => {
    const at = new Date().toISOString();
    setError(null);
    setNotice(null);
    setFailedAt(null);
    setBusy(true);
    editedRef.current = true;
    setMessages((m) => [
      ...m,
      { role: "user", text, at, ...(attached.length > 0 ? { attachments: attached } : {}) },
    ]);
    try {
      const res = await adapter.send(text, attached.length > 0 ? attached : undefined);
      if (res.ok) {
        for (const a of attached) releasePreview(a.path);
        setMessages((m) => [
          ...m,
          { role: "assistant", text: res.reply ?? "", at: new Date().toISOString() },
        ]);
      } else if (res.cancelled) {
        // Cancel means "let me rephrase": hand the text back, drop the bubble.
        setMessages((m) => m.filter((x) => !sentAt(at)(x)));
        setInput(text);
        pendingRef.current = chipsFrom(attached);
        setPending(pendingRef.current);
        setNotice(chat.cancelled);
      } else {
        setFailedAt(at);
        const reason =
          res.errorKind === "turn-limit"
            ? chat.turnLimit
            : res.errorKind === "timeout"
              ? chat.timedOut
              : chat.failed;
        setError(res.error ? `${reason}: ${res.error}` : reason);
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const text = input.trim();
    if (!text || busy || disabled) return;
    const attached = pending.map(({ name, path }) => ({ name, path }));
    setInput("");
    pendingRef.current = [];
    setPending([]);
    setAttachWarning(false);
    void send(text, attached);
  };

  const failedMessage = () => {
    const failed = failedIndex < 0 ? null : messages[failedIndex];
    return failed && isPlanChatText(failed) ? failed : null;
  };

  const retry = () => {
    const failed = failedMessage();
    if (failed === null || busy || disabled) return;
    setMessages((m) => m.filter((_, i) => i !== failedIndex));
    void send(failed.text, failed.attachments ?? []);
  };

  const dismiss = () => {
    const failed = failedMessage();
    if (failed === null) return;
    setMessages((m) => m.filter((_, i) => i !== failedIndex));
    setFailedAt(null);
    setError(null);
    setInput(failed.text);
    if (failed.attachments?.length) {
      pendingRef.current = chipsFrom(failed.attachments);
      setPending(pendingRef.current);
    }
  };

  return (
    <div className={className ?? "flex flex-col h-full min-h-0"}>
      <ChatTranscript
        items={items}
        thinking={busy && !draft && !liveSendTurn}
        emptyState={emptyState}
        renderSystemMessage={renderSystemMessage ?? defaultSystemMessage}
        onRetry={retry}
        onDismiss={dismiss}
      />

      <div className="shrink-0 border-t border-card-hover p-4 space-y-3">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={submit}
          onStop={adapter.cancel}
          placeholder={placeholder}
          disabled={disabled}
          busy={busy}
          inputRef={inputRef}
          {...(attachments
            ? {
                attachments: pending,
                onAttachFiles: (files: File[]) => void attachFiles(files),
                onRemoveAttachment: removeAttachment,
                attachmentsWarning: attachWarning ? chatT.attachmentsWarning : null,
              }
            : {})}
        />

        {footer}

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
});

function defaultSystemMessage(): ReactNode {
  return null;
}
