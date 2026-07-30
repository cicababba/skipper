"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { FolderGit2 } from "lucide-react";
import type { ComposerDraft, RepoRef } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { repoHref } from "@/lib/inbox/nav";
import { draftReducer, type DraftEdit, type DraftState } from "@/lib/composer/draft-state";
import { DraftPane } from "./draft-pane";
import { ComposeModeToggle, ComposeSwitchConfirm, type ComposeMode } from "./mode-toggle";

// Quick path (#137): one empty card straight to the tracker — no agent session,
// no distillation. The card itself is the chat composer's create path; what it
// borrows from the chat side is the composer record (#272), started on the first
// edit purely so an abandoned card survives as an unfinished draft. A repo with
// no local checkout has no record to start — quick then works renderer-only, and
// there is nothing to auto-save.

const EMPTY_QUICK_DRAFT: ComposerDraft = {
  issues: [{ title: "", body: "", acceptanceCriteria: [], labels: [] }],
  relations: [],
};

const EMPTY_QUICK_STATE: DraftState = { draft: EMPTY_QUICK_DRAFT, editedFlags: {} };

interface QuickSession {
  id: string | null;
  starting: boolean;
  /** A start failed (unlinked repo): don't retry on every keystroke. */
  failed: boolean;
  unmounted: boolean;
  discard: boolean;
}

export function QuickView({
  repo,
  mode,
  onSwitch,
  draftId,
}: {
  repo: RepoRef;
  mode: ComposeMode;
  onSwitch: (mode: ComposeMode) => void;
  /** Resume an unfinished quick draft (#272) instead of an empty card. */
  draftId?: string | null;
}) {
  const { t } = useT();
  const c = t.composer;
  const { owner, name } = repo;
  const repoKey = `${owner}/${name}`;

  const [state, dispatch] = useReducer(draftReducer, EMPTY_QUICK_STATE);
  const [confirmSwitch, setConfirmSwitch] = useState<ComposeMode | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  // A resume the user asked for that failed is worth saying out loud: the card
  // would otherwise come up empty and stop persisting without explanation. A
  // failed silent start on the fresh path stays silent by design.
  const [resumeError, setResumeError] = useState<string | null>(null);
  const session = useRef<QuickSession>({
    id: null,
    starting: false,
    failed: false,
    unmounted: false,
    discard: false,
  });

  useEffect(() => {
    const s = session.current;
    s.id = null;
    s.starting = false;
    s.failed = false;
    s.unmounted = false;
    s.discard = false;
    if (draftId && window.skipper && owner && name) {
      void window.skipper.composer.resume({ owner, name }, draftId).then((res) => {
        if (!res.ok) {
          s.failed = true;
          setResumeError(res.error);
          return;
        }
        // A resume keys on the draft id, so a concurrent mount holds the same
        // record: a late one must not dispose what that mount just restored.
        if (s.unmounted) return;
        s.id = res.chatId;
        setChatId(res.chatId);
        void window.skipper?.composer.getChat({ owner, name }, res.chatId).then((chat) => {
          if (s.unmounted || !chat?.draft) return;
          dispatch({ type: "hydrated", draft: chat.draft, editedFlags: chat.editedFlags ?? {} });
        });
      });
    }
    return () => {
      s.unmounted = true;
      if (s.id)
        void window.skipper?.composer.dispose(
          { owner, name },
          s.id,
          s.discard ? { discard: true } : undefined,
        );
    };
  }, [owner, name, draftId]);

  const startSession = useCallback(() => {
    const s = session.current;
    if (draftId || s.id || s.starting || s.failed) return;
    if (!window.skipper || !owner || !name) return;
    s.starting = true;
    void window.skipper.composer.start({ owner, name }).then((res) => {
      s.starting = false;
      if (!res.ok) {
        s.failed = true;
        return;
      }
      if (s.unmounted) {
        // A start mints a fresh id, so this late record is ours alone to drop.
        void window.skipper?.composer.dispose(
          { owner, name },
          res.chatId,
          s.discard ? { discard: true } : undefined,
        );
        return;
      }
      s.id = res.chatId;
      setChatId(res.chatId);
    });
  }, [owner, name, draftId]);

  const editField = useCallback(
    (index: number, edit: DraftEdit) => {
      dispatch({ type: "fieldEdited", index, ...edit });
      startSession();
    },
    [startSession],
  );

  // Debounced like the chat composer's draft pane: main holds the current card
  // without a write per keystroke. Keyed on chatId too, so the content typed
  // before the session existed lands as soon as it does.
  const settled = useDebouncedValue(state, 500);
  useEffect(() => {
    if (!chatId || chatId !== session.current.id || !settled.draft) return;
    void window.skipper?.composer.updateDraft(
      { owner, name },
      chatId,
      settled.draft,
      settled.editedFlags,
    );
  }, [settled, chatId, owner, name]);

  // Publishing ends the draft's life (#138/#272): the issues are on the tracker.
  const onAllCreated = useCallback(() => {
    session.current.discard = true;
    if (draftId) void window.skipper?.drafts.remove(draftId);
  }, [draftId]);

  const draft = state.draft ?? EMPTY_QUICK_DRAFT;
  const dirty = draft.issues.some((i) => i.title.trim() !== "" || i.body.trim() !== "");

  const requestSwitch = (next: ComposeMode) => {
    if (dirty) setConfirmSwitch(next);
    else onSwitch(next);
  };

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
          title={c.quick.leaveQuickTitle}
          body={c.quick.leaveQuickBody}
          onConfirm={() => {
            session.current.discard = true;
            onSwitch(confirmSwitch);
          }}
          onCancel={() => setConfirmSwitch(null)}
        />
      )}

      {resumeError && (
        <p className="m-4 rounded-lg border border-danger/25 bg-danger-bg px-3 py-2 text-[12px] text-danger">
          {c.startFailed}: {resumeError}
        </p>
      )}

      <p className="shrink-0 px-5 pt-3 text-[12px] text-muted">{c.quick.hint}</p>

      <div className="flex-1 min-h-0 grid grid-cols-1">
        <DraftPane
          repo={repo}
          draft={draft}
          busy={false}
          onEdit={editField}
          onBlur={() => {}}
          onAllCreated={onAllCreated}
        />
      </div>
    </div>
  );
}
