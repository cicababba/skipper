"use client";

import { useState } from "react";
import { CheckCircle2, ExternalLink, Eye, Loader2, Pencil, Plus, X } from "lucide-react";
import type { ComposerDraftIssue } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { FileSuggestInput } from "@/app/repos/repo/file-picker";
import type { DraftEdit } from "@/lib/composer/draft-state";
import type { CardCreateState } from "@/lib/composer/create-flow";

// One editable issue of the draft (#136). Every field is the user's to rewrite;
// what they touch is flagged so the next distillation is told to keep it.

const inputClasses =
  "w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-2 py-1.5 text-sm";

export function DraftIssueCard({
  index,
  issue,
  relations,
  labelSuggestions,
  createState,
  locked,
  busy,
  onEdit,
  onBlur,
  onRetry,
}: {
  index: number;
  issue: ComposerDraftIssue;
  relations: string[];
  labelSuggestions: string[];
  createState: CardCreateState;
  /** A created issue is frozen — it exists on the tracker now. */
  locked: boolean;
  busy: boolean;
  onEdit: (index: number, edit: DraftEdit) => void;
  onBlur: () => void;
  onRetry: () => void;
}) {
  const { t } = useT();
  const c = t.composer;
  const [preview, setPreview] = useState(false);
  const disabled = locked || busy || createState.status === "creating";

  const editCriterion = (i: number, value: string) => {
    const next = [...issue.acceptanceCriteria];
    next[i] = value;
    onEdit(index, { field: "acceptanceCriteria", value: next });
  };

  return (
    <section className="rounded-lg border border-card-hover bg-card overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-card-hover">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted">
          {c.issueN(index + 1)}
        </h3>
        <div className="flex-1" />
        <CreateBadge state={createState} onRetry={onRetry} />
        <button
          onClick={() => setPreview((v) => !v)}
          className="p-1 rounded text-muted hover:text-accent transition-colors"
          title={preview ? c.edit : c.preview}
          aria-label={preview ? c.edit : c.preview}
        >
          {preview ? <Pencil size={13} /> : <Eye size={13} />}
        </button>
      </header>

      <div className="px-4 py-3 space-y-3">
        <Field label={c.fieldTitle}>
          <input
            value={issue.title}
            disabled={disabled}
            aria-label={c.fieldTitle}
            onChange={(e) => onEdit(index, { field: "title", value: e.target.value })}
            onBlur={onBlur}
            className={inputClasses}
          />
        </Field>

        <Field label={c.fieldBody}>
          {preview ? (
            <div className="rounded-md border border-card-hover bg-card-hover/20 px-3 py-2 text-sm">
              <MarkdownRenderer content={issue.body} />
            </div>
          ) : (
            <textarea
              value={issue.body}
              disabled={disabled}
              aria-label={c.fieldBody}
              rows={8}
              onChange={(e) => onEdit(index, { field: "body", value: e.target.value })}
              onBlur={onBlur}
              className={`${inputClasses} resize-y font-mono text-[12px]`}
            />
          )}
        </Field>

        <Field label={c.fieldAcceptance}>
          <div className="space-y-1.5">
            {issue.acceptanceCriteria.map((criterion, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  value={criterion}
                  disabled={disabled}
                  placeholder={c.criterionPlaceholder}
                  aria-label={`${c.fieldAcceptance} ${i + 1}`}
                  onChange={(e) => editCriterion(i, e.target.value)}
                  onBlur={onBlur}
                  className={inputClasses}
                />
                <button
                  onClick={() =>
                    onEdit(index, {
                      field: "acceptanceCriteria",
                      value: issue.acceptanceCriteria.filter((_, j) => j !== i),
                    })
                  }
                  disabled={disabled}
                  aria-label={c.remove}
                  className="shrink-0 p-1 rounded text-muted hover:text-danger transition-colors disabled:opacity-40"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                onEdit(index, {
                  field: "acceptanceCriteria",
                  value: [...issue.acceptanceCriteria, ""],
                })
              }
              disabled={disabled}
              className="flex items-center gap-1 text-[11px] text-muted hover:text-accent transition-colors disabled:opacity-40"
            >
              <Plus size={11} />
              {c.addCriterion}
            </button>
          </div>
        </Field>

        <Field label={c.fieldLabels}>
          <div className="space-y-1.5">
            {issue.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {issue.labels.map((label) => (
                  <span
                    key={label}
                    className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-card-hover/60 text-muted"
                  >
                    {label}
                    <button
                      onClick={() =>
                        onEdit(index, {
                          field: "labels",
                          value: issue.labels.filter((l) => l !== label),
                        })
                      }
                      disabled={disabled}
                      aria-label={`${c.remove} ${label}`}
                      className="hover:text-foreground transition-colors disabled:opacity-40"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <FileSuggestInput
              options={labelSuggestions}
              exclude={issue.labels}
              disabled={disabled}
              placeholder={c.labelPlaceholder}
              onPick={(label) => {
                onEdit(index, { field: "labels", value: [...issue.labels, label] });
                onBlur();
              }}
            />
          </div>
        </Field>

        {relations.length > 0 && (
          <Field label={c.relations}>
            <ul className="space-y-0.5">
              {relations.map((line) => (
                <li key={line} className="text-[11px] text-muted/70">
                  {line}
                </li>
              ))}
            </ul>
          </Field>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted/70 mb-1">{label}</p>
      {children}
    </div>
  );
}

function CreateBadge({ state, onRetry }: { state: CardCreateState; onRetry: () => void }) {
  const { t } = useT();
  const c = t.composer;
  if (state.status === "creating") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-muted">
        <Loader2 size={11} className="animate-spin" />
        {c.creating}
      </span>
    );
  }
  if (state.status === "created") {
    return (
      <button
        onClick={() => void window.skipper?.openExternal(state.url)}
        className="flex items-center gap-1 text-[11px] text-success hover:underline underline-offset-2"
        title={c.openIssue}
      >
        <CheckCircle2 size={11} />
        {c.createdN(state.number)}
        <ExternalLink size={10} />
      </button>
    );
  }
  if (state.status === "failed") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-danger">
        <span className="max-w-[24ch] truncate" title={state.error}>
          {c.createFailed}
        </span>
        <button onClick={onRetry} className="text-foreground hover:underline underline-offset-2">
          {c.retry}
        </button>
      </span>
    );
  }
  return null;
}
