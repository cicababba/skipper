"use client";

import { useEffect, useRef } from "react";
import { Loader2, Send, Square } from "lucide-react";
import { useT } from "@/lib/app-i18n";
import { COMPOSER_MIN_HEIGHT, clampAutosizeHeight } from "@/lib/inbox/chat-autosize";

// Chat composer (#260): autosizing textarea + Send, which becomes Stop while a
// turn is in flight and the interlocutor supports cancellation.

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
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

  return (
    <div className="space-y-1.5">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
