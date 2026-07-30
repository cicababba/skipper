"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { Check, FolderGit2, Loader2, Save, Sparkles } from "lucide-react";
import { CHAT_TURN_DETAILS, type ComposerDraft, type RepoRef } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { ChatPanel, type ChatAdapter } from "@/components/chat/chat-panel";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { repoHref } from "@/lib/inbox/nav";
import {
  EMPTY_DRAFT_STATE,
  draftReducer,
  needsRegenWarning,
  type DraftEdit,
} from "@/lib/composer/draft-state";
import { DraftPane } from "./draft-pane";
import { ComposeModeToggle, ComposeSwitchConfirm, type ComposeMode } from "./mode-toggle";

// Chat composer (#136): a repo-grounded chat that turns a conversation into
// issues. Full-width until the first draft lands, then a split pane — and it
// stays split, because collapsing it back under the user would throw away the
// thing they came for.

const TURN_DETAILS = [CHAT_TURN_DETAILS.composerChat, CHAT_TURN_DETAILS.composerDraft];

export function ChatView({
  repo,
  mode,
  onSwitch,
  draftId,
}: {
  repo: RepoRef;
  mode: ComposeMode;
  onSwitch: (mode: ComposeMode) => void;
  /** Resume a saved draft (#138) instead of opening a fresh chat. */
  draftId?: string | null;
}) {
  const { t } = useT();
  const c = t.composer;
  const { owner, name } = repo;
  const repoKey = `${owner}/${name}`;

  const [chatId, setChatId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [distilling, setDistilling] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<ComposeMode | null>(null);
  // Bumped on every distillation: it keys the pane, so a regenerated draft
  // starts from clean per-card create states instead of inheriting stale ones.
  const [generation, setGeneration] = useState(0);
  const [state, dispatch] = useReducer(draftReducer, EMPTY_DRAFT_STATE);
  // The draft id once the chat is promoted (#138) — from then on main autosaves
  // every turn, so the button has nothing left to do but say so.
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  // An auto-saved draft (#272) is on disk but not kept on purpose: it still
  // offers "Save draft", and the next abandoned session may overwrite it.
  const [unfinished, setUnfinished] = useState(false);
  // The content is deliberately gone (published, or a confirmed mode switch) —
  // dispose must not capture it back as an unfinished draft.
  const discardRef = useRef(false);

  useEffect(() => {
    if (!window.skipper || !owner || !name) return;
    let started: string | null = null;
    let disposed = false;
    const open = draftId
      ? window.skipper.composer.resume({ owner, name }, draftId)
      : window.skipper.composer.start({ owner, name });
    void open.then((res) => {
      if (!res.ok) {
        setStartError(res.error);
        return;
      }
      started = res.chatId;
      if (disposed) {
        // A start() mints a fresh id, so this late record is ours alone to drop.
        // A resume() keys on the draft id instead: a concurrent mount holds that
        // same key, and disposing here would delete the record it just restored.
        if (!draftId) void window.skipper?.composer.dispose({ owner, name }, res.chatId);
        return;
      }
      setChatId(res.chatId);
      if (!draftId) return;
      setSavedDraftId(draftId);
      setUnfinished("unfinished" in res && res.unfinished === true);
      // The transcript rides ChatPanel's loadHistory; the draft pane is ours to
      // restore, flags included.
      void window.skipper?.composer.getChat({ owner, name }, res.chatId).then((chat) => {
        if (disposed || !chat?.draft) return;
        dispatch({ type: "hydrated", draft: chat.draft, editedFlags: chat.editedFlags ?? {} });
        setGeneration((g) => g + 1);
      });
    });
    return () => {
      disposed = true;
      if (started)
        void window.skipper?.composer.dispose(
          { owner, name },
          started,
          discardRef.current ? { discard: true } : undefined,
        );
    };
  }, [owner, name, draftId]);

  const adapter: ChatAdapter = useMemo(
    () => ({
      loadHistory: async () => {
        if (!chatId) return [];
        const chat = await window.skipper?.composer.getChat(repo, chatId);
        return chat?.messages ?? [];
      },
      send: async (text) => {
        if (!chatId) return { ok: false };
        const res = await window.skipper?.composer.send(repo, chatId, text);
        return res ?? { ok: false };
      },
      cancel: () => {
        if (chatId) void window.skipper?.composer.cancel(repo, chatId);
      },
    }),
    [repo, chatId],
  );

  // The draft lives here, never in the orchestrator context: a re-baseline from
  // a poll broadcast would wipe whatever the user is mid-way through typing.
  const pushDraft = useCallback(
    (draft: ComposerDraft, flags: Record<number, string[]>) => {
      if (chatId) void window.skipper?.composer.updateDraft(repo, chatId, draft, flags);
    },
    [repo, chatId],
  );

  const editField = useCallback((index: number, edit: DraftEdit) => {
    dispatch({ type: "fieldEdited", index, ...edit });
  }, []);

  // Debounced so main holds the current draft without a write per keystroke; a
  // blur pushes immediately through the same callback.
  const settled = useDebouncedValue(state, 500);
  useEffect(() => {
    if (settled.draft) pushDraft(settled.draft, settled.editedFlags);
  }, [settled, pushDraft]);

  const generate = async () => {
    if (!chatId || !window.skipper || sendBusy || distilling) return;
    setConfirmRegen(false);
    setDraftError(null);
    setDistilling(true);
    try {
      const res = await window.skipper.composer.generateDraft(repo, chatId);
      if (res.ok) {
        dispatch({ type: "draftGenerated", draft: res.draft });
        setGeneration((g) => g + 1);
      } else if (!res.cancelled) {
        setDraftError(res.error ? `${c.generateFailed}: ${res.error}` : c.generateFailed);
      }
    } finally {
      setDistilling(false);
    }
  };

  const save = async () => {
    if (!chatId || !window.skipper || (savedDraftId && !unfinished) || saveBusy) return;
    setDraftError(null);
    setSaveBusy(true);
    try {
      const res = await window.skipper.composer.saveDraft(repo, chatId);
      if (res.ok) {
        setSavedDraftId(res.draftId);
        setUnfinished(false);
      } else setDraftError(`${c.saveFailed}: ${res.error}`);
    } finally {
      setSaveBusy(false);
    }
  };

  // Publishing ends the draft's life (#138): the issues live on the tracker now.
  const onAllCreated = useCallback(() => {
    discardRef.current = true;
    if (!savedDraftId) return;
    void window.skipper?.drafts.remove(savedDraftId).then(() => setSavedDraftId(null));
  }, [savedDraftId]);

  const onGenerateClick = () => {
    if (needsRegenWarning(state)) setConfirmRegen(true);
    else void generate();
  };

  // The session is disposed on unmount, so a switch with a live conversation is
  // a discard — confirm it while there is still something to lose.
  const requestSwitch = (next: ComposeMode) => {
    if (count > 0 || state.draft) setConfirmSwitch(next);
    else onSwitch(next);
  };

  const split = state.draft !== null;

  const footer = (
    <>
      {confirmRegen ? (
        <div className="space-y-2 rounded-lg border border-warning/30 bg-warning-bg p-3">
          <p className="text-[12px] font-medium text-warning">{c.regenTitle}</p>
          <p className="text-[12px] text-warning/80">{c.regenBody}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void generate()}
              className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-warning/30 bg-warning/10 text-warning hover:bg-warning/20 transition-colors"
            >
              {c.regenConfirm}
            </button>
            <button
              onClick={() => setConfirmRegen(false)}
              className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
            >
              {c.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={onGenerateClick}
            disabled={count === 0 || sendBusy || distilling}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {distilling ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {distilling ? c.generating : split ? c.regenerate : c.generate}
          </button>
          {savedDraftId && !unfinished ? (
            <span className="flex items-center gap-1 text-[12px] text-success" title={c.savedHint}>
              <Check size={11} />
              {c.saved}
            </span>
          ) : (
            <button
              onClick={() => void save()}
              disabled={count === 0 || sendBusy || distilling || saveBusy}
              className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
            >
              {saveBusy ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
              {c.saveDraft}
            </button>
          )}
        </div>
      )}

      {draftError && (
        <p className="rounded-lg border border-danger/25 bg-danger-bg px-3 py-2 text-[12px] text-danger break-all">
          {draftError}
        </p>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2.5 border-b border-border px-5 py-3">
        <FolderGit2 size={15} className="text-accent shrink-0" />
        <h1 className="text-sm font-medium">{c.title}</h1>
        <Link
          href={repoHref({ owner, name })}
          className="text-[12px] text-muted hover:text-accent transition-colors truncate"
        >
          {repoKey}
        </Link>
        <div className="flex-1" />
        <ComposeModeToggle mode={mode} onSwitch={requestSwitch} />
      </div>

      {confirmSwitch && (
        <ComposeSwitchConfirm
          title={c.quick.leaveChatTitle}
          body={c.quick.leaveChatBody}
          onConfirm={() => {
            discardRef.current = true;
            onSwitch(confirmSwitch);
          }}
          onCancel={() => setConfirmSwitch(null)}
        />
      )}

      {startError && (
        <p className="m-4 rounded-lg border border-danger/25 bg-danger-bg px-3 py-2 text-[12px] text-danger">
          {c.startFailed}: {startError}
        </p>
      )}

      <div
        className={
          split
            ? "flex-1 min-h-0 grid grid-cols-1 wide:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
            : "flex-1 min-h-0"
        }
      >
        <div className="h-full min-h-0 border-r border-border">
          <ChatPanel
            itemId={chatId ? `${repoKey}:${chatId}` : repoKey}
            adapter={adapter}
            stream={window.skipper?.composer}
            turnDetails={TURN_DETAILS}
            sendDetail={CHAT_TURN_DETAILS.composerChat}
            placeholder={c.chatPlaceholder}
            disabled={!chatId || distilling}
            footer={footer}
            emptyState={<ChatEmptyState title={c.emptyTitle} hint={c.emptyHint} />}
            onBusyChange={setSendBusy}
            onCountChange={setCount}
          />
        </div>

        {split && state.draft && (
          <DraftPane
            key={generation}
            repo={repo}
            draft={state.draft}
            busy={distilling}
            onEdit={editField}
            onBlur={() => pushDraft(state.draft!, state.editedFlags)}
            onAllCreated={onAllCreated}
          />
        )}
      </div>
    </div>
  );
}
