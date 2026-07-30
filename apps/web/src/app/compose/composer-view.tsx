"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { RepoRef } from "@skipper/shared";
import { useStoredState } from "@/lib/use-stored-state";
import { composeHref } from "@/lib/inbox/nav";
import { ChatView } from "./chat-view";
import { QuickView } from "./quick-view";
import type { ComposeMode } from "./mode-toggle";

// The composer's two paths (#137) behind one route: the URL decides, and when it
// says nothing the last used mode does — a habitual quick user lands in quick.

export function ComposerView() {
  const params = useSearchParams();
  const router = useRouter();
  const owner = params.get("owner") ?? "";
  const name = params.get("name") ?? "";
  const repo: RepoRef = useMemo(() => ({ owner, name }), [owner, name]);

  const draftId = params.get("draft");

  const [storedMode, setStoredMode] = useStoredState("composer.mode", "chat", "local");
  const urlMode = params.get("mode");
  // A saved draft settles the mode (#138): the path it came from, which the
  // /drafts link spells out — a transcript-less draft is a quick one (#272).
  const mode: ComposeMode = draftId
    ? urlMode === "quick"
      ? "quick"
      : "chat"
    : urlMode === "quick" || urlMode === "chat"
      ? urlMode
      : storedMode === "quick"
        ? "quick"
        : "chat";

  const switchMode = useCallback(
    (next: ComposeMode) => {
      setStoredMode(next);
      router.replace(composeHref(repo, next === "quick" ? "quick" : undefined));
    },
    [repo, router, setStoredMode],
  );

  return mode === "quick" ? (
    <QuickView repo={repo} mode={mode} onSwitch={switchMode} draftId={draftId} />
  ) : (
    <ChatView repo={repo} mode={mode} onSwitch={switchMode} draftId={draftId} />
  );
}
