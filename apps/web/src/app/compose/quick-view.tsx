"use client";

import { useCallback, useReducer, useState } from "react";
import Link from "next/link";
import { FolderGit2 } from "lucide-react";
import type { ComposerDraft, RepoRef } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { repoHref } from "@/lib/inbox/nav";
import { draftReducer, type DraftEdit, type DraftState } from "@/lib/composer/draft-state";
import { DraftPane } from "./draft-pane";
import { ComposeModeToggle, ComposeSwitchConfirm, type ComposeMode } from "./mode-toggle";

// Quick path (#137): one empty card straight to the tracker — no agent session,
// no distillation. The draft never leaves the renderer, so there is nothing to
// push back to main; everything else is the chat composer's create path.

const EMPTY_QUICK_DRAFT: ComposerDraft = {
  issues: [{ title: "", body: "", acceptanceCriteria: [], labels: [] }],
  relations: [],
};

const EMPTY_QUICK_STATE: DraftState = { draft: EMPTY_QUICK_DRAFT, editedFlags: {} };

export function QuickView({
  repo,
  mode,
  onSwitch,
}: {
  repo: RepoRef;
  mode: ComposeMode;
  onSwitch: (mode: ComposeMode) => void;
}) {
  const { t } = useT();
  const c = t.composer;
  const { owner, name } = repo;
  const repoKey = `${owner}/${name}`;

  const [state, dispatch] = useReducer(draftReducer, EMPTY_QUICK_STATE);
  const [confirmSwitch, setConfirmSwitch] = useState<ComposeMode | null>(null);

  const editField = useCallback((index: number, edit: DraftEdit) => {
    dispatch({ type: "fieldEdited", index, ...edit });
  }, []);

  const draft = state.draft ?? EMPTY_QUICK_DRAFT;
  const issue = draft.issues[0];
  const dirty = issue.title.trim() !== "" || issue.body.trim() !== "";

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
          onConfirm={() => onSwitch(confirmSwitch)}
          onCancel={() => setConfirmSwitch(null)}
        />
      )}

      <p className="shrink-0 px-5 pt-3 text-[12px] text-muted">{c.quick.hint}</p>

      <div className="flex-1 min-h-0 grid grid-cols-1">
        <DraftPane repo={repo} draft={draft} busy={false} onEdit={editField} onBlur={() => {}} />
      </div>
    </div>
  );
}
