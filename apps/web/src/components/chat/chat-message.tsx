"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { PlanChatTextMessage } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { hhmm } from "@/lib/inbox/chat-format";
import { ConsoleMarkdown } from "@/components/console-markdown";

// One transcript bubble (#260). User turns stay plain text, assistant turns are
// rendered as markdown; a failed send keeps its bubble and offers Retry/Dismiss
// instead of silently dropping what the user typed.

interface ChatMessageProps {
  message: PlanChatTextMessage;
  failed?: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function ChatMessage({ message, failed, onRetry, onDismiss }: ChatMessageProps) {
  const { t } = useT();
  const c = t.inbox.chat;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(message.text);
    setCopied(true);
  };

  const meta = (
    <div className="flex items-center gap-1.5 text-[11px] text-muted/60 opacity-0 transition-opacity group-hover:opacity-100">
      <span>{hhmm(message.at)}</span>
      <button
        onClick={copy}
        aria-label={c.copyMessage}
        title={c.copyMessage}
        className="flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        {copied && c.copied}
      </button>
    </div>
  );

  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        <div
          className={`max-w-[85%] rounded-lg px-3 py-2 whitespace-pre-wrap break-words ${
            failed ? "border border-danger/30 bg-danger-bg text-danger" : "bg-card-hover/40"
          }`}
        >
          {message.text}
        </div>
        {failed ? (
          <div className="flex items-center gap-2 text-[11px]">
            <button onClick={onRetry} className="text-accent hover:opacity-80 transition-opacity">
              {c.retry}
            </button>
            <button
              onClick={onDismiss}
              className="text-muted/70 hover:text-foreground transition-colors"
            >
              {c.dismiss}
            </button>
          </div>
        ) : (
          meta
        )}
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-0.5">
      <div className="max-w-[90%] text-foreground/90">
        <ConsoleMarkdown content={message.text} />
      </div>
      {meta}
    </div>
  );
}
