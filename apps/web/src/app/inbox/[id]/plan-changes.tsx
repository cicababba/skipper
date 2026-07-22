"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  FilesDiff,
  PlanDiff,
  PlanFileRef,
  PlanRevisionSource,
  PlanStep,
  StepsDiff,
  StringListDiff,
} from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

function countsText(
  parts: { added: number; removed: number; modified?: number },
  labels: {
    added: (n: number) => string;
    removed: (n: number) => string;
    modified: (n: number) => string;
  },
): string {
  const out: string[] = [];
  if (parts.added) out.push(labels.added(parts.added));
  if (parts.removed) out.push(labels.removed(parts.removed));
  if (parts.modified) out.push(labels.modified(parts.modified));
  return out.join(", ");
}

function ChangeRow({
  label,
  counts,
  children,
}: {
  label: string;
  counts: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1.5 text-left"
      >
        <span className="text-muted">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-[13px] text-foreground">{label}</span>
        <span className="text-[11px] text-muted tabular-nums">{counts}</span>
      </button>
      {open && <div className="space-y-1 pb-2 pl-6 text-[12px]">{children}</div>}
    </div>
  );
}

function BeforeAfter({ before, after }: { before: string; after: string }) {
  const { t } = useT();
  const c = t.inbox.plan.changes;
  return (
    <div className="mt-1 space-y-0.5">
      <div className="text-[11px] text-muted">
        {c.before}: <span className="text-muted/80">{before}</span>
      </div>
      <div className="text-[11px] text-muted">
        {c.after}: <span className="text-foreground">{after}</span>
      </div>
    </div>
  );
}

function StringListDetail({ diff }: { diff: StringListDiff }) {
  return (
    <>
      {diff.removed.map((l, i) => (
        <div key={`r${i}`} className="text-red-400">
          − {l}
        </div>
      ))}
      {diff.added.map((l, i) => (
        <div key={`a${i}`} className="text-emerald-400">
          + {l}
        </div>
      ))}
    </>
  );
}

function fileLine(f: PlanFileRef): React.ReactNode {
  return (
    <>
      <span className="font-mono">{f.path}</span>
      {f.reason ? ` — ${f.reason}` : ""}
    </>
  );
}

function FilesDetail({ diff }: { diff: FilesDiff }) {
  return (
    <>
      {diff.removed.map((f, i) => (
        <div key={`r${i}`} className="text-red-400">
          − {fileLine(f)}
        </div>
      ))}
      {diff.added.map((f, i) => (
        <div key={`a${i}`} className="text-emerald-400">
          + {fileLine(f)}
        </div>
      ))}
      {diff.modified.map(({ before, after }, i) => (
        <div key={`m${i}`}>
          <span className="font-mono text-amber-400">{after.path}</span>
          {before.reason !== after.reason && (
            <BeforeAfter before={before.reason} after={after.reason} />
          )}
          {before.status !== after.status && (
            <BeforeAfter before={before.status ?? "—"} after={after.status ?? "—"} />
          )}
        </div>
      ))}
    </>
  );
}

function StepsDetail({ diff }: { diff: StepsDiff }) {
  const { t } = useT();
  const p = t.inbox.plan;
  const fieldDiff = (before: PlanStep, after: PlanStep) => {
    const rows: { label: string; before: string; after: string }[] = [];
    if (before.detail !== after.detail)
      rows.push({ label: p.stepDetail, before: before.detail, after: after.detail });
    if (before.files.join(", ") !== after.files.join(", "))
      rows.push({ label: p.stepFiles, before: before.files.join(", "), after: after.files.join(", ") });
    if (before.symbols.join(", ") !== after.symbols.join(", "))
      rows.push({
        label: p.stepSymbols,
        before: before.symbols.join(", "),
        after: after.symbols.join(", "),
      });
    if ((before.createdSymbols ?? []).join(", ") !== (after.createdSymbols ?? []).join(", "))
      rows.push({
        label: p.stepCreates,
        before: (before.createdSymbols ?? []).join(", "),
        after: (after.createdSymbols ?? []).join(", "),
      });
    return rows;
  };
  return (
    <>
      {diff.removed.map((s, i) => (
        <div key={`r${i}`} className="text-red-400">
          − {s.title}
        </div>
      ))}
      {diff.added.map((s, i) => (
        <div key={`a${i}`} className="text-emerald-400">
          + {s.title}
        </div>
      ))}
      {diff.modified.map(({ before, after }, i) => (
        <div key={`m${i}`}>
          <span className="text-amber-400">{after.title}</span>
          {fieldDiff(before, after).map((row, j) => (
            <div key={j} className="mt-1">
              <div className="text-[11px] uppercase tracking-wide text-muted/70">{row.label}</div>
              <BeforeAfter before={row.before} after={row.after} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

export function PlanChangesBody({
  diff,
  source,
  at,
}: {
  diff: PlanDiff;
  source: PlanRevisionSource;
  at: string;
}) {
  const { t } = useT();
  const p = t.inbox.plan;
  const c = p.changes;

  const rows: React.ReactNode[] = [];

  if (diff.summary) {
    rows.push(
      <ChangeRow key="summary" label={p.sections.summary} counts={c.changed}>
        <BeforeAfter before={diff.summary.before} after={diff.summary.after} />
      </ChangeRow>,
    );
  }
  if (diff.size) {
    rows.push(
      <ChangeRow key="size" label={p.size} counts={c.changed}>
        <div className="font-mono text-amber-400">
          {diff.size.before} → {diff.size.after}
        </div>
      </ChangeRow>,
    );
  }
  if (diff.steps.added.length || diff.steps.removed.length || diff.steps.modified.length) {
    rows.push(
      <ChangeRow
        key="steps"
        label={p.sections.steps}
        counts={countsText(
          {
            added: diff.steps.added.length,
            removed: diff.steps.removed.length,
            modified: diff.steps.modified.length,
          },
          c,
        )}
      >
        <StepsDetail diff={diff.steps} />
      </ChangeRow>,
    );
  }
  if (diff.files.added.length || diff.files.removed.length || diff.files.modified.length) {
    rows.push(
      <ChangeRow
        key="files"
        label={p.sections.files}
        counts={countsText(
          {
            added: diff.files.added.length,
            removed: diff.files.removed.length,
            modified: diff.files.modified.length,
          },
          c,
        )}
      >
        <FilesDetail diff={diff.files} />
      </ChangeRow>,
    );
  }

  const listSections: { key: keyof PlanDiff; label: string; diff: StringListDiff }[] = [
    { key: "acceptance", label: p.sections.acceptance, diff: diff.acceptance },
    { key: "risks", label: p.sections.risks, diff: diff.risks },
    { key: "openQuestions", label: p.sections.openQuestions, diff: diff.openQuestions },
    { key: "context", label: p.sections.context, diff: diff.context },
    { key: "outOfScope", label: p.sections.outOfScope, diff: diff.outOfScope },
    {
      key: "verificationCommands",
      label: p.sections.verificationCommands,
      diff: diff.verificationCommands,
    },
    { key: "manualChecks", label: p.sections.manualChecks, diff: diff.manualChecks },
  ];
  for (const s of listSections) {
    if (!s.diff.added.length && !s.diff.removed.length) continue;
    rows.push(
      <ChangeRow
        key={s.key}
        label={s.label}
        counts={countsText({ added: s.diff.added.length, removed: s.diff.removed.length }, c)}
      >
        <StringListDetail diff={s.diff} />
      </ChangeRow>,
    );
  }

  return (
    <div>
      <div className="mb-1 text-[11px] text-muted">
        {c.source[source]} · {new Date(at).toLocaleString()}
      </div>
      {rows}
    </div>
  );
}
