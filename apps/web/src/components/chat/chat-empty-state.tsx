"use client";

import { MessagesSquare } from "lucide-react";

// Per-interlocutor empty state (#260): the panel opens on an invitation rather
// than a bare line of grey text.

export function ChatEmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <MessagesSquare size={22} className="text-muted/40" />
      <p className="text-[13px] font-medium text-foreground/80">{title}</p>
      <p className="max-w-[32ch] text-[12px] text-muted/70">{hint}</p>
    </div>
  );
}
