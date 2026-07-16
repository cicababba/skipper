"use client";

import {
  ArrowLeft,
  ExternalLink,
  GitPullRequest,
  Loader2,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { displayKey, type SolutionRecord } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { Section } from "@/app/inbox/[id]/plan-sections";

/**
 * Full read view of one captured SolutionRecord (#47): plan gist + diff, the
 * aggregate 👍/👎 the record accrued at points of use (read-only here), and a
 * delete for deliberate curation.
 */
export function MemoryRecordView({
  record,
  busy,
  onBack,
  onDelete,
}: {
  record: SolutionRecord;
  busy: boolean;
  onBack: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const plan = record.plan?.plan;
  const feedback = record.feedback ?? { up: 0, down: 0 };

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
        <span className="flex items-center gap-1 text-[12px] text-muted">
          <ThumbsUp size={12} className="text-accent/70" /> {feedback.up}
          <ThumbsDown size={12} className="text-muted/60 ml-1.5" /> {feedback.down}
        </span>
        <button
          onClick={onDelete}
          disabled={busy}
          className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-red-500/30 text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          {m.delete}
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => void window.skipper?.openExternal(record.url)}
          className="flex items-center gap-1.5 min-w-0 text-left hover:text-accent transition-colors"
          title={record.url}
        >
          <span className="font-mono text-muted shrink-0">
            {displayKey(record.issueKey ?? String(record.issueNumber))}
          </span>
          <span className="font-medium truncate">{record.title}</span>
          <ExternalLink size={12} className="shrink-0 opacity-50" />
        </button>
        <button
          onClick={() => void window.skipper?.openExternal(record.pr.url)}
          className="flex items-center gap-1 shrink-0 font-mono text-[12px] text-muted hover:text-accent transition-colors"
          title={record.pr.url}
        >
          <GitPullRequest size={12} />
          {record.pr.number}
        </button>
        <span className="text-[11px] text-muted/50">
          {m.captured} {new Date(record.capturedAt).toLocaleDateString()}
        </span>
      </div>

      <Section title={m.plan} editable={false} editing={false}>
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
            {(record.diffStats?.files ?? plan.files.map((f) => f.path)).length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {(record.diffStats?.files ?? plan.files.map((f) => f.path)).map((f) => (
                  <code
                    key={f}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-card-hover/60 text-muted font-mono"
                  >
                    {f}
                  </code>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-muted/60">{m.noPlan}</p>
        )}
      </Section>

      <Section
        title={m.diff}
        count={record.diffStats?.filesChanged}
        editable={false}
        editing={false}
      >
        {record.diff ? (
          <pre className="overflow-x-auto text-[12px] leading-relaxed font-mono text-muted whitespace-pre">
            {record.diff}
          </pre>
        ) : (
          <p className="text-[13px] text-muted/60">{m.noDiff}</p>
        )}
      </Section>
    </div>
  );
}
