"use client";

import { useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  Loader2,
  Pencil,
  StickyNote,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { displayKey, type SolutionRecord } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { VoteButton } from "@/components/vote-button";
import { recordFiles } from "@/lib/inbox/memory-filters";
import { NoteEditor } from "./note-editor";

/**
 * Full view of one memory record (#255): the gist first, plan and diff behind
 * collapsibles, direct 👍/👎 curation, and — for manual notes — markdown
 * rendering plus inline editing.
 */
export function MemoryRecordView({
  record,
  busy,
  onBack,
  onDelete,
  onChanged,
}: {
  record: SolutionRecord;
  busy: boolean;
  onBack: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const plan = record.plan?.plan;
  const feedback = record.feedback ?? { up: 0, down: 0 };
  const isNote = record.kind === "note";
  const files = recordFiles(record);
  const [voting, setVoting] = useState(false);
  const [editing, setEditing] = useState(false);

  const curate = async (kind: "up" | "down") => {
    if (!window.skipper) return;
    setVoting(true);
    try {
      await window.skipper.memory.curate(record.itemId, record.curationVote === kind ? null : kind);
      onChanged();
    } finally {
      setVoting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[13px] text-muted hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          {m.close}
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <VoteButton
            active={record.curationVote === "up"}
            disabled={voting}
            label={t.inbox.plan.memories.helpful}
            count={feedback.up}
            onClick={() => void curate("up")}
          >
            <ThumbsUp size={13} />
          </VoteButton>
          <VoteButton
            active={record.curationVote === "down"}
            disabled={voting}
            label={t.inbox.plan.memories.notHelpful}
            count={feedback.down}
            onClick={() => void curate("down")}
          >
            <ThumbsDown size={13} />
          </VoteButton>
        </div>
        {isNote && (
          <button
            onClick={() => setEditing((v) => !v)}
            className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-border text-muted hover:text-foreground transition-colors"
          >
            <Pencil size={12} />
            {m.editNote}
          </button>
        )}
        <button
          onClick={onDelete}
          disabled={busy}
          className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-danger/25 text-danger hover:bg-danger/10 transition-colors disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          {m.delete}
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {isNote ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <StickyNote size={12} className="shrink-0 text-accent/70" />
            <span className="font-medium truncate">{record.title}</span>
            <span className="text-[10px] uppercase text-muted/50">{m.noteBadge}</span>
          </span>
        ) : (
          <button
            onClick={() => void window.skipper?.openExternal(record.url)}
            className="flex items-center gap-1.5 min-w-0 text-left hover:text-accent transition-colors"
            title={record.url}
          >
            <span className="font-mono text-muted shrink-0">
              {displayKey(record.issueKey ?? String(record.issueNumber ?? ""))}
            </span>
            <span className="font-medium truncate">{record.title}</span>
            <ExternalLink size={12} className="shrink-0 opacity-50" />
          </button>
        )}
        {record.pr && (
          <button
            onClick={() => void window.skipper?.openExternal(record.pr!.url)}
            className="flex items-center gap-1 shrink-0 font-mono text-[12px] text-muted hover:text-accent transition-colors"
            title={record.pr.url}
          >
            <GitPullRequest size={12} />
            {record.pr.number}
          </button>
        )}
        <span className="text-[11px] text-muted/50">
          {m.captured} {new Date(record.capturedAt).toLocaleDateString()}
        </span>
      </div>

      {isNote && editing ? (
        <NoteEditor
          repo={record.repo}
          existing={{
            id: record.itemId,
            title: record.title,
            body: record.note?.body ?? "",
            files: record.note?.files ?? [],
          }}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : isNote ? (
        <div className="text-[13px]">
          <MarkdownRenderer content={record.note?.body ?? ""} />
        </div>
      ) : (
        <>
          {record.lesson && (
            <div className="rounded-lg border border-accent/25 bg-accent/5 px-3 py-2.5 space-y-1">
              <span className="block text-[11px] uppercase tracking-wide text-accent/80">
                {m.lesson}
              </span>
              <p className="text-[13px] text-foreground/90 leading-relaxed whitespace-pre-wrap">
                {record.lesson}
              </p>
            </div>
          )}
          <p className="text-[13px] text-muted/90 leading-relaxed">{plan?.summary ?? m.noSummary}</p>
        </>
      )}

      {files.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[11px] text-muted/60">{m.files}</span>
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <code
                key={f}
                className="text-[11px] px-1.5 py-0.5 rounded bg-card-hover/60 text-muted font-mono"
              >
                {f}
              </code>
            ))}
          </div>
        </div>
      )}

      {!isNote && (
        <>
          <Collapsible title={m.plan}>
            {plan ? (
              <div className="space-y-3 text-[13px]">
                <p className="text-muted/90 leading-relaxed">{plan.summary}</p>
                {plan.steps.length > 0 && (
                  <ol className="list-decimal list-inside space-y-1 text-muted">
                    {plan.steps.map((s, i) => (
                      <li key={i}>{s.title}</li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <p className="text-[13px] text-muted/60">{m.noPlan}</p>
            )}
          </Collapsible>

          <Collapsible title={m.diff} count={record.diffStats?.filesChanged}>
            {record.diff ? (
              <pre className="overflow-x-auto text-[12px] leading-relaxed font-mono text-muted whitespace-pre">
                {record.diff}
              </pre>
            ) : (
              <p className="text-[13px] text-muted/60">{m.noDiff}</p>
            )}
          </Collapsible>
        </>
      )}
    </div>
  );
}

function Collapsible({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
        {count !== undefined && <span className="text-muted/50">{count}</span>}
      </button>
      {open && children}
    </div>
  );
}
