"use client";

import {
  acceptanceString,
  type FilesDiff,
  type PlanAcceptance,
  type PlanFileRef,
  type PlanStep,
  type StepsDiff,
  type StringListDiff,
} from "@skipper/shared";
import { MarkdownRenderer } from "@/components/markdown-renderer";

// Inline diff mode for the plan document (#201): re-renders each section's
// current items classified against the revision diff — additions emerald,
// modifications amber, removals appended struck-through red. Read-only; the
// color language mirrors plan-changes.tsx.

type Change = "added" | "modified" | "removed" | "unchanged";

const BORDER: Record<Exclude<Change, "unchanged" | "removed">, string> = {
  added: "border-l-2 border-emerald-500/50 pl-2 -ml-2",
  modified: "border-l-2 border-amber-500/50 pl-2 -ml-2",
};

const MARKER: Record<Exclude<Change, "unchanged">, string> = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  removed: "text-red-400/70",
};

const REMOVED_CLASS = "text-red-400/70 line-through";

function markerGlyph(change: Exclude<Change, "unchanged">): string {
  return change === "removed" ? "−" : change === "added" ? "+" : "~";
}

function currentClass(change: Change): string {
  return change === "added" || change === "modified" ? BORDER[change] : "";
}

export function StepsDiffView({ steps, diff }: { steps: PlanStep[]; diff: StepsDiff }) {
  const added = new Set(diff.added.map((s) => s.title));
  const modified = new Set(diff.modified.map((m) => m.after.title));
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => {
        const change: Change = added.has(step.title)
          ? "added"
          : modified.has(step.title)
            ? "modified"
            : "unchanged";
        return (
          <li key={`c${i}`} className={`flex gap-3 ${currentClass(change)}`}>
            {change !== "unchanged" && (
              <span className={`font-mono text-[13px] ${MARKER[change]}`}>{markerGlyph(change)}</span>
            )}
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-foreground">{step.title}</p>
              {step.detail && (
                <p className="text-[13px] text-muted whitespace-pre-wrap">{step.detail}</p>
              )}
            </div>
          </li>
        );
      })}
      {diff.removed.map((step, i) => (
        <li key={`r${i}`} className="flex gap-3">
          <span className={`font-mono text-[13px] ${MARKER.removed}`}>{markerGlyph("removed")}</span>
          <p className={`text-sm font-medium ${REMOVED_CLASS}`}>{step.title}</p>
        </li>
      ))}
    </ol>
  );
}

export function FilesDiffView({ files, diff }: { files: PlanFileRef[]; diff: FilesDiff }) {
  const added = new Set(diff.added.map((f) => f.path));
  const modified = new Set(diff.modified.map((m) => m.after.path));
  return (
    <ul className="space-y-2">
      {files.map((file, i) => {
        const change: Change = added.has(file.path)
          ? "added"
          : modified.has(file.path)
            ? "modified"
            : "unchanged";
        return (
          <li key={`c${i}`} className={`flex items-baseline gap-2 ${currentClass(change)}`}>
            {change !== "unchanged" && (
              <span className={`font-mono text-[13px] ${MARKER[change]}`}>{markerGlyph(change)}</span>
            )}
            <code className="font-mono text-[13px] text-foreground break-all">{file.path}</code>
            <span className="text-sm text-muted">{file.reason}</span>
          </li>
        );
      })}
      {diff.removed.map((file, i) => (
        <li key={`r${i}`} className="flex items-baseline gap-2">
          <span className={`font-mono text-[13px] ${MARKER.removed}`}>{markerGlyph("removed")}</span>
          <code className={`font-mono text-[13px] break-all ${REMOVED_CLASS}`}>{file.path}</code>
          <span className={`text-sm ${REMOVED_CLASS}`}>{file.reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function LinesDiffView({ lines, diff }: { lines: string[]; diff: StringListDiff }) {
  const added = new Set(diff.added);
  return (
    <ul className="space-y-1">
      {lines.map((line, i) => {
        const change: Change = added.has(line) ? "added" : "unchanged";
        return (
          <li key={`c${i}`} className={`flex gap-2 text-sm text-foreground/90 ${currentClass(change)}`}>
            {change !== "unchanged" && (
              <span className={`font-mono ${MARKER[change]}`}>{markerGlyph(change)}</span>
            )}
            <span>{line}</span>
          </li>
        );
      })}
      {diff.removed.map((line, i) => (
        <li key={`r${i}`} className="flex gap-2 text-sm">
          <span className={`font-mono ${MARKER.removed}`}>{markerGlyph("removed")}</span>
          <span className={REMOVED_CLASS}>{line}</span>
        </li>
      ))}
    </ul>
  );
}

export function AcceptanceDiffView({
  rows,
  diff,
}: {
  rows: PlanAcceptance[];
  diff: StringListDiff;
}) {
  const added = new Set(diff.added);
  return (
    <ul className="space-y-2">
      {rows.map((row, i) => {
        const change: Change = added.has(acceptanceString(row)) ? "added" : "unchanged";
        return (
          <li key={`c${i}`} className={`flex gap-2 text-sm ${currentClass(change)}`}>
            {change !== "unchanged" && (
              <span className={`font-mono ${MARKER[change]}`}>{markerGlyph(change)}</span>
            )}
            <div className="min-w-0">
              <p className="text-foreground">{row.criterion}</p>
              <p className="text-muted">{row.addressedBy}</p>
            </div>
          </li>
        );
      })}
      {diff.removed.map((line, i) => (
        <li key={`r${i}`} className="flex gap-2 text-sm">
          <span className={`font-mono ${MARKER.removed}`}>{markerGlyph("removed")}</span>
          <span className={REMOVED_CLASS}>{line}</span>
        </li>
      ))}
    </ul>
  );
}

export function SummaryDiffView({ summary, before }: { summary: string; before: string | null }) {
  return (
    <div className="space-y-3">
      <MarkdownRenderer content={summary} />
      {before !== null && (
        <div className="border-l-2 border-red-400/40 pl-3 text-[13px] text-muted/70 line-through whitespace-pre-wrap">
          {before}
        </div>
      )}
    </div>
  );
}
