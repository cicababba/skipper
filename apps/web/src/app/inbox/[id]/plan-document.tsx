"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Edit2, Loader2, SplitSquareHorizontal, X } from "lucide-react";
import {
  diffCount,
  diffPlans,
  sectionDiffCounts,
  type IssuePlan,
  type PlanRevision,
  type UsedMemoryRef,
} from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { useStoredState } from "@/lib/use-stored-state";
import {
  sectionIsValid,
  type SectionDraft,
  type SectionId,
} from "@/lib/inbox/plan-edit";
import { MemoriesList } from "./memories-card";
import { PlanChangesBody } from "./plan-changes";
import {
  AcceptanceEditor,
  AcceptanceView,
  FilesEditor,
  FilesView,
  LinesEditor,
  LinesView,
  StepsEditor,
  StepsView,
} from "./plan-sections";
import {
  AcceptanceDiffView,
  FilesDiffView,
  LinesDiffView,
  StepsDiffView,
  SummaryDiffView,
} from "./plan-diff-sections";

export function docSectionDomId(sid: string): string {
  return `plan-doc-${sid}`;
}

function hhmm(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type DocSid = Exclude<SectionId, "size">;

interface PlanDocumentProps {
  itemId: string;
  plan: IssuePlan;
  gate: boolean;
  editingSection: SectionId | null;
  draft: SectionDraft | null;
  saving: boolean;
  onStartEdit: (sid: DocSid) => void;
  onDraftChange: (d: SectionDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  memoryRefs: UsedMemoryRef[] | undefined;
  memoriesTitle: string;
  revisions?: PlanRevision[];
}

function DocSection({
  sid,
  title,
  count,
  updatedCount,
  tone,
  collapsible,
  expanded,
  onToggle,
  editable,
  editing,
  valid,
  saving,
  onEdit,
  onSave,
  onCancel,
  children,
}: {
  sid: string;
  title: string;
  count?: number;
  updatedCount?: number;
  tone?: "warning";
  collapsible?: boolean;
  expanded: boolean;
  onToggle?: () => void;
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
  const showBody = !collapsible || expanded;
  return (
    <section id={docSectionDomId(sid)} className="scroll-mt-4 border-b border-border py-4">
      <div className="group flex items-center gap-2">
        {collapsible && (
          <button
            onClick={onToggle}
            className="p-0.5 -ml-1 rounded text-muted hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <h3
          className={`text-[11px] font-medium uppercase tracking-wide ${
            tone === "warning" ? "text-amber-300/80" : "text-muted"
          }`}
        >
          {title}
        </h3>
        {count !== undefined && (
          <span className="font-mono text-[11px] text-muted/50 tabular-nums">{count}</span>
        )}
        {updatedCount !== undefined && updatedCount > 0 && (
          <span className="rounded-full border border-accent/30 bg-accent/10 px-1.5 text-[10px] font-medium text-accent tabular-nums">
            {p.changes.updatedBadge(updatedCount)}
          </span>
        )}
        <div className="flex-1" />
        {editing ? (
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
        ) : (
          editable &&
          showBody && (
            <button
              onClick={onEdit}
              className="p-1 rounded text-muted hover:text-accent opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 transition-all"
              title={p.edit}
            >
              <Edit2 size={13} />
            </button>
          )
        )}
      </div>
      {showBody && (
        <div className={`mt-2 ${tone === "warning" ? "border-l-2 border-amber-500/40 pl-4" : ""}`}>
          {children}
        </div>
      )}
    </section>
  );
}

export function PlanDocument({
  itemId,
  plan,
  gate,
  editingSection,
  draft,
  saving,
  onStartEdit,
  onDraftChange,
  onSave,
  onCancel,
  memoryRefs,
  memoriesTitle,
  revisions,
}: PlanDocumentProps) {
  const { t } = useT();
  const p = t.inbox.plan;

  const latest = revisions?.at(-1);
  const changesDiff = useMemo(() => (latest ? diffPlans(latest.plan, plan) : null), [latest, plan]);
  const hasChanges = !!latest && !!changesDiff && diffCount(changesDiff) > 0;
  const counts = useMemo(() => (changesDiff ? sectionDiffCounts(changesDiff) : null), [changesDiff]);
  const highlights = useMemo(() => {
    if (!changesDiff) return null;
    return {
      steps: new Set([
        ...changesDiff.steps.added.map((s) => s.title),
        ...changesDiff.steps.modified.map((m) => m.after.title),
      ]),
      files: new Set([
        ...changesDiff.files.added.map((f) => f.path),
        ...changesDiff.files.modified.map((m) => m.after.path),
      ]),
      acceptance: new Set(changesDiff.acceptance.added),
      risks: new Set(changesDiff.risks.added),
      openQuestions: new Set(changesDiff.openQuestions.added),
      context: new Set(changesDiff.context.added),
      outOfScope: new Set(changesDiff.outOfScope.added),
      verificationCommands: new Set(changesDiff.verificationCommands.added),
      manualChecks: new Set(changesDiff.manualChecks.added),
    };
  }, [changesDiff]);

  const [dismissedAt, setDismissedAt] = useStoredState(
    `skipper-plan-banner-dismissed:${itemId}`,
    "",
  );
  const [showDiff, setShowDiff] = useState(false);
  const diffMode = showDiff && hasChanges && !!changesDiff;

  const [openCsv, setOpenCsv] = useStoredState(`skipper-plan-doc-open:${itemId}`, "");
  const openSet = new Set(openCsv.split(",").filter(Boolean));
  const toggle = (sid: string) =>
    setOpenCsv((cur) => {
      const set = new Set(cur.split(",").filter(Boolean));
      if (set.has(sid)) set.delete(sid);
      else set.add(sid);
      return [...set].join(",");
    });

  const viewChanges = () => {
    setOpenCsv((cur) => {
      const set = new Set(cur.split(",").filter(Boolean));
      set.add("changes");
      return [...set].join(",");
    });
    requestAnimationFrame(() => {
      document
        .getElementById(docSectionDomId("changes"))
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const renderDoc = (
    sid: DocSid,
    title: string,
    count: number | undefined,
    view: React.ReactNode,
    editor: React.ReactNode,
    opts?: { tone?: "warning"; collapsible?: boolean },
  ): React.ReactNode => {
    if (!gate && (count ?? 0) === 0) return null;
    const editing = editingSection === sid;
    const expanded = !opts?.collapsible || openSet.has(sid) || editing;
    return (
      <DocSection
        key={sid}
        sid={sid}
        title={title}
        count={count}
        updatedCount={counts?.[sid]}
        tone={opts?.tone}
        collapsible={opts?.collapsible}
        expanded={expanded}
        onToggle={() => toggle(sid)}
        editable={gate && editingSection === null && !showDiff}
        editing={editing}
        valid={draft ? sectionIsValid(draft) : false}
        saving={saving}
        onEdit={() => onStartEdit(sid)}
        onSave={onSave}
        onCancel={onCancel}
      >
        {editing && draft?.section === sid ? editor : view}
      </DocSection>
    );
  };

  const memoriesExpanded = openSet.has("memories");

  return (
    <div className="max-w-[720px] min-w-0 wide:col-start-1 wide:row-start-1">
      {hasChanges && (
        <div className="flex justify-end pb-1">
          <button
            onClick={() => setShowDiff((v) => !v)}
            disabled={editingSection !== null}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
              showDiff
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-border text-muted hover:text-foreground hover:bg-card-hover"
            }`}
          >
            <SplitSquareHorizontal size={12} />
            {showDiff ? p.changes.hideDiff : p.changes.showDiff}
          </button>
        </div>
      )}

      {/* Summary is required — always rendered, never collapsible. */}
      <DocSection
        sid="summary"
        title={p.sections.summary}
        updatedCount={counts?.summary}
        expanded
        editable={gate && editingSection === null && !showDiff}
        editing={editingSection === "summary"}
        valid={draft ? sectionIsValid(draft) : false}
        saving={saving}
        onEdit={() => onStartEdit("summary")}
        onSave={onSave}
        onCancel={onCancel}
      >
        {editingSection === "summary" && draft?.section === "summary" ? (
          <textarea
            value={draft.text}
            onChange={(e) => onDraftChange({ section: "summary", text: e.target.value })}
            rows={6}
            className="w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md p-3 text-sm resize-y"
          />
        ) : diffMode ? (
          <SummaryDiffView summary={plan.summary} before={changesDiff.summary?.before ?? null} />
        ) : (
          <MarkdownRenderer content={plan.summary} />
        )}
      </DocSection>

      {hasChanges && latest.source === "chat-apply" && latest.at !== dismissedAt && (
        <div className="my-3 flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[12px]">
          <span className="flex-1 text-accent">
            {p.changes.bannerUpdated(diffCount(changesDiff))} · {hhmm(latest.at)}
          </span>
          <button
            onClick={viewChanges}
            className="shrink-0 rounded-md border border-accent/30 px-2 py-1 font-medium text-accent hover:bg-accent/20 transition-colors"
          >
            {p.changes.bannerView}
          </button>
          <button
            onClick={() => setDismissedAt(latest.at)}
            className="shrink-0 text-accent/70 hover:text-accent transition-colors"
            title={p.cancel}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {hasChanges && (
        <DocSection
          sid="changes"
          title={p.changes.title}
          count={diffCount(changesDiff)}
          collapsible
          expanded={openSet.has("changes")}
          onToggle={() => toggle("changes")}
          editable={false}
          editing={false}
        >
          <PlanChangesBody diff={changesDiff} source={latest.source} at={latest.at} />
        </DocSection>
      )}

      {renderDoc(
        "steps",
        p.sections.steps,
        plan.steps.length,
        diffMode ? (
          <StepsDiffView steps={plan.steps} diff={changesDiff.steps} />
        ) : (
          <StepsView steps={plan.steps} highlight={highlights?.steps} />
        ),
        draft?.section === "steps" ? (
          <StepsEditor
            steps={draft.steps}
            onChange={(steps) => onDraftChange({ section: "steps", steps })}
          />
        ) : null,
        { collapsible: true },
      )}
      {renderDoc(
        "files",
        p.sections.files,
        plan.files.length,
        diffMode ? (
          <FilesDiffView files={plan.files} diff={changesDiff.files} />
        ) : (
          <FilesView files={plan.files} highlight={highlights?.files} />
        ),
        draft?.section === "files" ? (
          <FilesEditor
            files={draft.files}
            onChange={(files) => onDraftChange({ section: "files", files })}
          />
        ) : null,
        { collapsible: true },
      )}
      {renderDoc(
        "acceptance",
        p.sections.acceptance,
        plan.acceptance.length,
        diffMode ? (
          <AcceptanceDiffView rows={plan.acceptance} diff={changesDiff.acceptance} />
        ) : (
          <AcceptanceView rows={plan.acceptance} highlight={highlights?.acceptance} />
        ),
        draft?.section === "acceptance" ? (
          <AcceptanceEditor
            rows={draft.acceptance}
            onChange={(acceptance) => onDraftChange({ section: "acceptance", acceptance })}
          />
        ) : null,
        { collapsible: true },
      )}
      {renderDoc(
        "risks",
        p.sections.risks,
        plan.risks.length,
        diffMode ? (
          <LinesDiffView lines={plan.risks} diff={changesDiff.risks} />
        ) : (
          <LinesView lines={plan.risks} highlight={highlights?.risks} />
        ),
        draft?.section === "risks" ? (
          <LinesEditor
            lines={draft.lines}
            onChange={(lines) => onDraftChange({ section: "risks", lines })}
          />
        ) : null,
        { tone: "warning", collapsible: true },
      )}
      {renderDoc(
        "openQuestions",
        p.sections.openQuestions,
        plan.openQuestions.length,
        diffMode ? (
          <LinesDiffView lines={plan.openQuestions} diff={changesDiff.openQuestions} />
        ) : (
          <LinesView lines={plan.openQuestions} highlight={highlights?.openQuestions} />
        ),
        draft?.section === "openQuestions" ? (
          <LinesEditor
            lines={draft.lines}
            onChange={(lines) => onDraftChange({ section: "openQuestions", lines })}
          />
        ) : null,
        { tone: "warning", collapsible: true },
      )}

      {renderDoc(
        "context",
        p.sections.context,
        plan.context?.length,
        diffMode ? (
          <LinesDiffView lines={plan.context ?? []} diff={changesDiff.context} />
        ) : (
          <LinesView lines={plan.context ?? []} highlight={highlights?.context} />
        ),
        draft?.section === "context" ? (
          <LinesEditor
            lines={draft.lines}
            onChange={(lines) => onDraftChange({ section: "context", lines })}
          />
        ) : null,
        { collapsible: true },
      )}
      {renderDoc(
        "outOfScope",
        p.sections.outOfScope,
        plan.outOfScope?.length,
        diffMode ? (
          <LinesDiffView lines={plan.outOfScope ?? []} diff={changesDiff.outOfScope} />
        ) : (
          <LinesView lines={plan.outOfScope ?? []} highlight={highlights?.outOfScope} />
        ),
        draft?.section === "outOfScope" ? (
          <LinesEditor
            lines={draft.lines}
            onChange={(lines) => onDraftChange({ section: "outOfScope", lines })}
          />
        ) : null,
        { collapsible: true },
      )}
      {renderDoc(
        "verificationCommands",
        p.sections.verificationCommands,
        plan.verificationCommands?.length,
        diffMode ? (
          <LinesDiffView
            lines={plan.verificationCommands ?? []}
            diff={changesDiff.verificationCommands}
          />
        ) : (
          <LinesView
            lines={plan.verificationCommands ?? []}
            highlight={highlights?.verificationCommands}
          />
        ),
        draft?.section === "verificationCommands" ? (
          <LinesEditor
            lines={draft.lines}
            onChange={(lines) => onDraftChange({ section: "verificationCommands", lines })}
          />
        ) : null,
        { collapsible: true },
      )}
      {renderDoc(
        "manualChecks",
        p.sections.manualChecks,
        plan.manualChecks?.length,
        diffMode ? (
          <LinesDiffView lines={plan.manualChecks ?? []} diff={changesDiff.manualChecks} />
        ) : (
          <LinesView lines={plan.manualChecks ?? []} highlight={highlights?.manualChecks} />
        ),
        draft?.section === "manualChecks" ? (
          <LinesEditor
            lines={draft.lines}
            onChange={(lines) => onDraftChange({ section: "manualChecks", lines })}
          />
        ) : null,
        { collapsible: true },
      )}

      {memoryRefs && memoryRefs.length > 0 && (
        <DocSection
          sid="memories"
          title={memoriesTitle}
          count={memoryRefs.length}
          collapsible
          expanded={memoriesExpanded}
          onToggle={() => toggle("memories")}
          editable={false}
          editing={false}
        >
          <MemoriesList itemId={itemId} phase="planning" refs={memoryRefs} />
        </DocSection>
      )}
    </div>
  );
}
