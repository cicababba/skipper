"use client";

import { useEffect, useRef } from "react";
import { Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { useT } from "@/lib/app-i18n";
import { COMPOSER_MIN_HEIGHT, clampAutosizeHeight } from "@/lib/inbox/chat-autosize";

// Chat composer (#260): autosizing textarea + Send, which becomes Stop while a
// turn is in flight and the interlocutor supports cancellation. Attachments
// (#281) are opt-in: without the props the paste/drop handlers and the chip
// strip are inert, so the plan and agent chats render exactly as before.

/** An attachment already saved by main, still pending in the input area. */
export interface PendingChatAttachment {
  id: string;
  name: string;
  /** ObjectURL for an image preview; absent for PDFs and text files. */
  previewUrl?: string;
}

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  attachments?: PendingChatAttachment[];
  onAttachFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  attachmentsWarning?: string | null;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder,
  disabled,
  busy,
  inputRef,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  attachmentsWarning,
}: ChatComposerProps) {
  const { t } = useT();
  const chat = t.inbox.plan.chat;
  const c = t.inbox.chat;
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef ?? ownRef;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${clampAutosizeHeight(el.scrollHeight)}px`;
  }, [value, ref]);

  const canStop = !!busy && !!onStop;
  const pending = attachments ?? [];

  const dropHandlers = onAttachFiles
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        },
        onDrop: (e: React.DragEvent) => {
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length === 0) return;
          e.preventDefault();
          onAttachFiles(files);
        },
      }
    : {};

  const pasteHandler = onAttachFiles
    ? (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        onAttachFiles(files);
      }
    : undefined;

  return (
    <div className="space-y-1.5" {...dropHandlers}>
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pending.map((attachment) => (
            <div
              key={attachment.id}
              className="group relative flex items-center gap-1.5 rounded-md border border-card-hover bg-card-hover/40 pl-2 pr-1 py-1 text-[11px] max-w-[180px]"
            >
              {attachment.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <Paperclip size={11} className="shrink-0 text-muted/70" />
              )}
              <span className="truncate text-muted">{attachment.name}</span>
              <button
                onClick={() => onRemoveAttachment?.(attachment.id)}
                aria-label={c.removeAttachment}
                title={c.removeAttachment}
                className="shrink-0 text-muted/60 hover:text-foreground transition-colors"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachmentsWarning && <p className="text-[12px] text-warning/80">{attachmentsWarning}</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={pasteHandler}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          disabled={!!busy || disabled}
          style={{ minHeight: COMPOSER_MIN_HEIGHT }}
          className="flex-1 resize-none bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-2 py-1.5 text-sm leading-relaxed disabled:opacity-50"
        />
        {canStop ? (
          <button
            onClick={onStop}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-danger/30 text-danger hover:bg-danger-bg transition-colors whitespace-nowrap"
          >
            <Square size={11} />
            {c.stop}
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={!value.trim() || !!busy || disabled}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            {chat.send}
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted/60">{c.enterHint}</p>
    </div>
  );
}
