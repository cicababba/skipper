"use client";

import { Check, Edit2, Loader2, Plus, Trash2, X } from "lucide-react";
import type { PlanAcceptance, PlanFileRef, PlanStep } from "@skipper/shared";
import type { StepDraft } from "@/lib/inbox/plan-edit";
import { useT } from "@/lib/app-i18n";

const inputClasses =
  "w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-2 py-1.5 text-sm";

export function Section({
  title,
  count,
  editable,
  editing,
  valid,
  saving,
  onEdit,
  onSave,
  onCancel,
  children,
}: {
  title: string;
  count?: number;
  editable: boolean;
  editing: boolean;
  valid?: boolean;
  saving?: boolean;
  onEdit?: () => void;
  onSave?: () => void;
  onCancel?: () => void;
  children: React.ReactNode;
}) {
  const { t } = useT();
  const p = t.inbox.plan;
  return (
    <section className="rounded-lg border border-card-hover bg-card overflow-hidden">
      <header className="flex items-center gap-2 px-5 py-3 border-b border-card-hover">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted">{title}</h2>
        {count !== undefined && <span className="text-[11px] text-muted/50">{count}</span>}
        <div className="flex-1" />
        {editable && !editing && (
          <button
            onClick={onEdit}
            className="p-1 rounded text-muted hover:text-accent transition-colors"
            title={p.edit}
          >
            <Edit2 size={13} />
          </button>
        )}
        {editing && (
          <>
            <button
              onClick={onSave}
              disabled={!valid || saving}
              className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              {p.save}
            </button>
            <button
              onClick={onCancel}
              disabled={saving}
              className="p-1 rounded text-muted hover:text-foreground transition-colors"
              title={p.cancel}
            >
              <X size={13} />
            </button>
          </>
        )}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function AddButton({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
    >
      <Plus size={11} />
      {t.inbox.plan.add}
    </button>
  );
}

function RemoveButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useT();
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="p-1 rounded text-muted hover:text-red-300 transition-colors disabled:opacity-30 shrink-0"
      title={t.inbox.plan.remove}
    >
      <Trash2 size={13} />
    </button>
  );
}

function EmptyHint() {
  const { t } = useT();
  return <p className="text-sm text-muted/60">{t.inbox.plan.emptySection}</p>;
}

function statusPill(status: PlanFileRef["status"], labels: { existing: string; new: string }) {
  if (status === "new")
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-300 border-emerald-500/20">
        {labels.new}
      </span>
    );
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-card text-muted border-border">
      {labels.existing}
    </span>
  );
}

export function FilesView({ files }: { files: PlanFileRef[] }) {
  const { t } = useT();
  if (files.length === 0) return <EmptyHint />;
  return (
    <ul className="space-y-2">
      {files.map((file, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <code className="font-mono text-[13px] text-foreground break-all">{file.path}</code>
          {statusPill(file.status, t.inbox.plan.fileStatus)}
          <span className="text-sm text-muted">{file.reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function FilesEditor({
  files,
  onChange,
}: {
  files: PlanFileRef[];
  onChange: (files: PlanFileRef[]) => void;
}) {
  const { t } = useT();
  const p = t.inbox.plan;
  const update = (i: number, patch: Partial<PlanFileRef>) =>
    onChange(files.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-2">
      {files.map((file, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex-1 space-y-1.5">
            <input
              value={file.path}
              onChange={(e) => update(i, { path: e.target.value })}
              placeholder={p.path}
              className={`${inputClasses} font-mono text-[13px]`}
            />
            <input
              value={file.reason}
              onChange={(e) => update(i, { reason: e.target.value })}
              placeholder={p.reason}
              className={inputClasses}
            />
          </div>
          <select
            value={file.status ?? "existing"}
            onChange={(e) => update(i, { status: e.target.value as "existing" | "new" })}
            className="bg-card-hover/40 border border-card-hover rounded-md px-1.5 py-1 text-[11px] text-foreground focus:outline-none focus:border-accent"
          >
            <option value="existing">{p.fileStatus.existing}</option>
            <option value="new">{p.fileStatus.new}</option>
          </select>
          <RemoveButton
            onClick={() => onChange(files.filter((_, j) => j !== i))}
            disabled={files.length === 1}
          />
        </div>
      ))}
      <AddButton onClick={() => onChange([...files, { path: "", reason: "", status: "existing" }])} />
    </div>
  );
}

export function StepsView({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return <EmptyHint />;
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded border border-card-hover font-mono text-[11px] text-muted/70">
            {i + 1}
          </span>
          <div className="min-w-0 space-y-1 pt-px">
            <p className="text-sm font-medium text-foreground">{step.title}</p>
            {step.detail && (
              <p className="text-[13px] text-muted whitespace-pre-wrap">{step.detail}</p>
            )}
            {(step.files.length > 0 ||
              step.symbols.length > 0 ||
              (step.createdSymbols?.length ?? 0) > 0) && (
              <p className="font-mono text-[11px] text-muted/70 break-all">
                {[...step.files, ...step.symbols, ...(step.createdSymbols ?? [])].join(" · ")}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function StepsEditor({
  steps,
  onChange,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
}) {
  const { t } = useT();
  const p = t.inbox.plan;
  const update = (i: number, patch: Partial<StepDraft>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-3">
      {steps.map((step, i) => (
        <div key={i} className="rounded-md border border-card-hover p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted/60 shrink-0">{i + 1}.</span>
            <input
              value={step.title}
              onChange={(e) => update(i, { title: e.target.value })}
              placeholder={p.stepTitle}
              className={inputClasses}
            />
            <RemoveButton
              onClick={() => onChange(steps.filter((_, j) => j !== i))}
              disabled={steps.length === 1}
            />
          </div>
          <textarea
            value={step.detail}
            onChange={(e) => update(i, { detail: e.target.value })}
            placeholder={p.stepDetail}
            rows={3}
            className={`${inputClasses} resize-y`}
          />
          <div className="grid grid-cols-3 gap-1.5">
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted/60">
                {p.stepFiles} — {p.onePerLine}
              </span>
              <textarea
                value={step.filesText}
                onChange={(e) => update(i, { filesText: e.target.value })}
                rows={3}
                className={`${inputClasses} font-mono text-[12px] resize-y`}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted/60">
                {p.stepSymbols} — {p.onePerLine}
              </span>
              <textarea
                value={step.symbolsText}
                onChange={(e) => update(i, { symbolsText: e.target.value })}
                rows={3}
                className={`${inputClasses} font-mono text-[12px] resize-y`}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted/60">
                {p.stepCreates} — {p.onePerLine}
              </span>
              <textarea
                value={step.createdSymbolsText}
                onChange={(e) => update(i, { createdSymbolsText: e.target.value })}
                rows={3}
                className={`${inputClasses} font-mono text-[12px] resize-y`}
              />
            </label>
          </div>
        </div>
      ))}
      <AddButton
        onClick={() =>
          onChange([
            ...steps,
            { title: "", detail: "", filesText: "", symbolsText: "", createdSymbolsText: "" },
          ])
        }
      />
    </div>
  );
}

export function AcceptanceView({ rows }: { rows: PlanAcceptance[] }) {
  if (rows.length === 0) return <EmptyHint />;
  return (
    <ul className="space-y-2">
      {rows.map((row, i) => (
        <li key={i} className="text-sm">
          <p className="text-foreground">{row.criterion}</p>
          <p className="text-muted">{row.addressedBy}</p>
        </li>
      ))}
    </ul>
  );
}

export function AcceptanceEditor({
  rows,
  onChange,
}: {
  rows: PlanAcceptance[];
  onChange: (rows: PlanAcceptance[]) => void;
}) {
  const { t } = useT();
  const p = t.inbox.plan;
  const update = (i: number, patch: Partial<PlanAcceptance>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex-1 space-y-1.5">
            <input
              value={row.criterion}
              onChange={(e) => update(i, { criterion: e.target.value })}
              placeholder={p.criterion}
              className={inputClasses}
            />
            <input
              value={row.addressedBy}
              onChange={(e) => update(i, { addressedBy: e.target.value })}
              placeholder={p.addressedBy}
              className={inputClasses}
            />
          </div>
          <RemoveButton onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <AddButton onClick={() => onChange([...rows, { criterion: "", addressedBy: "" }])} />
    </div>
  );
}

export function LinesView({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <EmptyHint />;
  return (
    <ul className="list-disc pl-4 space-y-1">
      {lines.map((line, i) => (
        <li key={i} className="text-sm text-foreground/90">
          {line}
        </li>
      ))}
    </ul>
  );
}

export function LinesEditor({
  lines,
  onChange,
}: {
  lines: string[];
  onChange: (lines: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {lines.map((line, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={line}
            onChange={(e) => onChange(lines.map((l, j) => (j === i ? e.target.value : l)))}
            className={inputClasses}
          />
          <RemoveButton onClick={() => onChange(lines.filter((_, j) => j !== i))} />
        </div>
      ))}
      <AddButton onClick={() => onChange([...lines, ""])} />
    </div>
  );
}
