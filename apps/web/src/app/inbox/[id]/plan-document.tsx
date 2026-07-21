"use client";

import { Check, ChevronDown, ChevronRight, Edit2, Loader2, X } from "lucide-react";
import type { IssuePlan, UsedMemoryRef } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { useStoredState } from "@/lib/use-stored-state";
import {
  sectionIsValid,
  type SectionDraft,
  type SectionId,
} from "@/lib/inbox/plan-edit";
import { MemoriesList } from "./memories-card";
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

export function docSectionDomId(sid: string): string {
  return `plan-doc-${sid}`;
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
}

function DocSection({
  sid,
  title,
  count,
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
}: PlanDocumentProps) {
  const { t } = useT();
  const p = t.inbox.plan;

  const [openCsv, setOpenCsv] = useStoredState(`skipper-plan-doc-open:${itemId}`, "");
  const openSet = new Set(openCsv.split(",").filter(Boolean));
  const toggle = (sid: string) =>
    setOpenCsv((cur) => {
      const set = new Set(cur.split(",").filter(Boolean));
      if (set.has(sid)) set.delete(sid);
      else set.add(sid);
      return [...set].join(",");
    });

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
        tone={opts?.tone}
        collapsible={opts?.collapsible}
        expanded={expanded}
        onToggle={() => toggle(sid)}
        editable={gate && editingSection === null}
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
      {/* Summary is required — always rendered, never collapsible. */}
      <DocSection
        sid="summary"
        title={p.sections.summary}
        expanded
        editable={gate && editingSection === null}
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
        ) : (
          <MarkdownRenderer content={plan.summary} />
        )}
      </DocSection>

      {renderDoc(
        "steps",
        p.sections.steps,
        plan.steps.length,
        <StepsView steps={plan.steps} />,
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
        <FilesView files={plan.files} />,
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
        <AcceptanceView rows={plan.acceptance} />,
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
        <LinesView lines={plan.risks} />,
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
        <LinesView lines={plan.openQuestions} />,
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
        <LinesView lines={plan.context ?? []} />,
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
        <LinesView lines={plan.outOfScope ?? []} />,
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
        <LinesView lines={plan.verificationCommands ?? []} />,
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
        <LinesView lines={plan.manualChecks ?? []} />,
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
