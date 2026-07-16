"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Inbox, Loader2, X } from "lucide-react";
import { displayKey, type IssuePlan, type StoredPlan } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { repoKey } from "@/lib/inbox/model";
import { bandClasses, pct, ReportBody } from "@/components/confidence-popover";
import { EventConsole } from "@/components/event-console";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MemoriesCard } from "./memories-card";
import {
  applySection,
  draftFor,
  sectionIsValid,
  type SectionDraft,
  type SectionId,
} from "@/lib/inbox/plan-edit";
import { StateBadge } from "../state-badge";
import {
  AcceptanceEditor,
  AcceptanceView,
  FilesEditor,
  FilesView,
  LinesEditor,
  LinesView,
  Section,
  StepsEditor,
  StepsView,
} from "./plan-sections";

const SIZES: IssuePlan["estimatedSize"][] = ["xs", "s", "m", "l", "xl"];

type GateAction = "approve" | "replan" | "park";

export function PlanDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const router = useRouter();
  const { state, requestTransition } = useOrchestrator();
  const { t } = useT();
  const p = t.inbox.plan;

  const item = state?.items.find((i) => i.id === id);
  const gate = item?.state === "plan-gate";

  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const planRef = item?.plan?.ref;
  const composite = item?.plan?.confidence;
  useEffect(() => {
    if (!window.skipper || !planRef) {
      setStored(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    window.skipper.orchestrator
      .getPlan(id)
      .then((s) => {
        if (!cancelled) setStored(s);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, planRef, composite]);

  const [editingSection, setEditingSection] = useState<SectionId | null>(null);
  const [draft, setDraft] = useState<SectionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [busyAction, setBusyAction] = useState<GateAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [parkOpen, setParkOpen] = useState(false);
  const [parkNote, setParkNote] = useState("");

  const plan = stored?.plan;

  const startEdit = (section: SectionId) => {
    if (!plan) return;
    setDraft(draftFor(plan, section));
    setEditingSection(section);
    setSaveError(null);
  };

  const cancelEdit = () => {
    setEditingSection(null);
    setDraft(null);
  };

  const persist = async (next: IssuePlan): Promise<boolean> => {
    if (!window.skipper) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await window.skipper.orchestrator.updatePlan(id, next);
      if (result.ok) {
        setStored(result.stored);
        return true;
      }
      setSaveError(result.error);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!plan || !draft) return;
    if (await persist(applySection(plan, draft))) cancelEdit();
  };

  const saveSize = async (size: IssuePlan["estimatedSize"]) => {
    if (!plan) return;
    await persist(applySection(plan, { section: "size", size }));
  };

  const runAction = async (action: GateAction) => {
    const to = action === "approve" ? "queued" : action === "replan" ? "planning" : "needs-input";
    const reason = action === "park" ? parkNote.trim() || undefined : undefined;
    setBusyAction(action);
    setActionError(null);
    try {
      const result = await requestTransition(id, to, reason);
      if (result.ok) router.push("/inbox");
      else setActionError(result.error);
    } finally {
      setBusyAction(null);
    }
  };

  const isElectron = typeof window !== "undefined" && !!window.skipper;

  if (!isElectron) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <Inbox size={40} className="opacity-30" />
        <p className="text-sm text-muted max-w-md">{t.inbox.empty.desktopOnly}</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted">
        <Loader2 size={16} className="animate-spin" />
        {t.inbox.empty.loading}
      </div>
    );
  }

  const backLink = (
    <Link
      href="/inbox"
      className="flex items-center gap-1.5 text-[12px] text-muted hover:text-foreground transition-colors w-fit"
    >
      <ArrowLeft size={13} />
      {p.back}
    </Link>
  );

  if (!item) {
    return (
      <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
        {backLink}
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <Inbox size={40} className="opacity-30" />
          <p className="text-sm text-muted max-w-md">{p.notFound}</p>
        </div>
      </div>
    );
  }

  const editBusy = editingSection !== null || saving;
  const actionsDisabled = editBusy || busyAction !== null;

  const section = (
    sid: Exclude<SectionId, "size">,
    title: string,
    count: number | undefined,
    view: React.ReactNode,
    edit: React.ReactNode,
  ) => (
    <Section
      title={title}
      count={count}
      editable={gate && !!plan && editingSection === null}
      editing={editingSection === sid}
      valid={draft ? sectionIsValid(draft) : false}
      saving={saving}
      onEdit={() => startEdit(sid)}
      onSave={() => void saveEdit()}
      onCancel={cancelEdit}
    >
      {editingSection === sid && draft ? edit : view}
    </Section>
  );

  return (
    <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
      {backLink}

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-[13px] text-muted shrink-0">{displayKey(item.key)}</span>
          <h1 className="text-xl font-semibold tracking-tight min-w-0">{item.title}</h1>
          <button
            onClick={() => void window.skipper?.openExternal(item.url)}
            className="p-1 rounded text-muted hover:text-accent transition-colors shrink-0 self-center"
            title={item.url}
          >
            <ExternalLink size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-muted">
          <span>{repoKey(item.repo)}</span>
          <StateBadge item={item} />
          {plan &&
            (gate ? (
              <select
                value={plan.estimatedSize}
                onChange={(e) => void saveSize(e.target.value as IssuePlan["estimatedSize"])}
                disabled={saving}
                className="bg-card border border-border rounded px-1.5 py-0.5 text-[11px] font-medium uppercase text-foreground focus:outline-none focus:border-accent disabled:opacity-50"
                title={p.size}
              >
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s.toUpperCase()}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[11px] font-medium px-1.5 py-0.5 rounded border bg-card text-muted border-border uppercase">
                {plan.estimatedSize}
              </span>
            ))}
          {stored && (
            <span className="text-muted/60">
              {p.generated}: {new Date(stored.generatedAt).toLocaleString()} · {stored.model}
            </span>
          )}
        </div>
      </div>

      {/* Gate actions */}
      {gate && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 space-y-2">
          {parkOpen ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={parkNote}
                onChange={(e) => setParkNote(e.target.value)}
                placeholder={p.parkNotePlaceholder}
                className="flex-1 bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md px-2 py-1.5 text-sm"
              />
              <button
                onClick={() => void runAction("park")}
                disabled={actionsDisabled}
                className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {busyAction === "park" && <Loader2 size={11} className="animate-spin" />}
                {p.parkConfirm}
              </button>
              <button
                onClick={() => {
                  setParkOpen(false);
                  setParkNote("");
                }}
                className="p-1.5 rounded text-muted hover:text-foreground transition-colors"
                title={p.cancel}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 flex-wrap"
              title={editBusy ? p.finishEditing : undefined}
            >
              <button
                onClick={() => void runAction("approve")}
                disabled={actionsDisabled}
                className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
              >
                {busyAction === "approve" && <Loader2 size={11} className="animate-spin" />}
                {t.inbox.actions.approve}
              </button>
              <button
                onClick={() => void runAction("replan")}
                disabled={actionsDisabled}
                className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
              >
                {busyAction === "replan" && <Loader2 size={11} className="animate-spin" />}
                {t.inbox.actions.replan}
              </button>
              <button
                onClick={() => setParkOpen(true)}
                disabled={actionsDisabled}
                className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
              >
                {t.inbox.actions.park}
              </button>
            </div>
          )}
          {actionError && <p className="text-[12px] text-red-300 break-all">{actionError}</p>}
        </div>
      )}
      {!gate && plan && <p className="text-[12px] text-muted/70">{p.readOnly}</p>}

      {saveError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2 text-sm">
          <span className="flex-1 break-all">
            {p.saveFailed}: {saveError}
          </span>
          <button onClick={() => setSaveError(null)} className="shrink-0 hover:text-red-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Body */}
      {item.state === "planning" ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            {t.inbox.states.planning}…
          </div>
          <EventConsole
            itemId={id}
            getEvents={window.skipper!.planning.getEvents}
            onEvent={window.skipper!.planning.onEvent}
          />
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : !plan ? (
        item.state === "triage" ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted">
            <Loader2 size={16} className="animate-spin" />
            {t.inbox.states[item.state]}…
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Inbox size={32} className="opacity-30" />
            <p className="text-sm text-muted max-w-md">{loadError ? p.loadFailed : p.noPlan}</p>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {section(
            "summary",
            p.sections.summary,
            undefined,
            <MarkdownRenderer content={plan.summary} />,
            draft?.section === "summary" ? (
              <textarea
                value={draft.text}
                onChange={(e) => setDraft({ section: "summary", text: e.target.value })}
                rows={6}
                className="w-full bg-card-hover/40 border border-card-hover focus:border-accent outline-none rounded-md p-3 text-sm resize-y"
              />
            ) : null,
          )}
          {section(
            "files",
            p.sections.files,
            plan.files.length,
            <FilesView files={plan.files} />,
            draft?.section === "files" ? (
              <FilesEditor
                files={draft.files}
                onChange={(files) => setDraft({ section: "files", files })}
              />
            ) : null,
          )}
          {section(
            "steps",
            p.sections.steps,
            plan.steps.length,
            <StepsView steps={plan.steps} />,
            draft?.section === "steps" ? (
              <StepsEditor
                steps={draft.steps}
                onChange={(steps) => setDraft({ section: "steps", steps })}
              />
            ) : null,
          )}
          {section(
            "acceptance",
            p.sections.acceptance,
            plan.acceptance.length,
            <AcceptanceView rows={plan.acceptance} />,
            draft?.section === "acceptance" ? (
              <AcceptanceEditor
                rows={draft.acceptance}
                onChange={(acceptance) => setDraft({ section: "acceptance", acceptance })}
              />
            ) : null,
          )}
          {section(
            "risks",
            p.sections.risks,
            plan.risks.length,
            <LinesView lines={plan.risks} />,
            draft?.section === "risks" ? (
              <LinesEditor
                lines={draft.lines}
                onChange={(lines) => setDraft({ section: "risks", lines })}
              />
            ) : null,
          )}
          {section(
            "openQuestions",
            p.sections.openQuestions,
            plan.openQuestions.length,
            <LinesView lines={plan.openQuestions} />,
            draft?.section === "openQuestions" ? (
              <LinesEditor
                lines={draft.lines}
                onChange={(lines) => setDraft({ section: "openQuestions", lines })}
              />
            ) : null,
          )}
          <Section title={p.sections.confidence} editable={false} editing={false}>
            {stored?.confidence ? (
              <div className="space-y-3 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">{t.inbox.popover.composite}</span>
                  <span
                    className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${bandClasses(stored.confidence.composite)}`}
                  >
                    {pct(stored.confidence.composite)}
                  </span>
                </div>
                {stored.editedAt && <p className="text-[11px] text-amber-300/80">{p.edited}</p>}
                <ReportBody report={stored.confidence} />
              </div>
            ) : (
              <p className="text-sm text-muted">{t.inbox.popover.reportUnavailable}</p>
            )}
          </Section>
          <MemoriesCard
            itemId={id}
            phase="planning"
            refs={item.usedMemory?.planning}
            title={p.sections.memories}
          />
        </div>
      )}
    </div>
  );
}
