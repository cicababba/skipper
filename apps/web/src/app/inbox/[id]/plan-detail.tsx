"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Inbox, Loader2, X } from "lucide-react";
import { type IssuePlan, type StoredPlan } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { useStoredState } from "@/lib/use-stored-state";
import { EventConsole } from "@/components/event-console";
import {
  applySection,
  draftFor,
  type SectionDraft,
  type SectionId,
} from "@/lib/inbox/plan-edit";
import { PlanDocument } from "./plan-document";
import { DecisionRail, type GateAction } from "./decision-rail";
import { PlanChatDrawer, PlanChatFab } from "./plan-chat-drawer";

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
  const rescoring = item?.plan?.rescoring;
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
    // rescoring is load-bearing twice (#164): the flag-set broadcast refetches the
    // applied plan even if onPlanUpdated was missed mid-navigation, and the
    // flag-clear guarantees a refetch even when the new composite equals the old.
  }, [id, planRef, composite, rescoring]);

  const [editingSection, setEditingSection] = useState<SectionId | null>(null);
  const [draft, setDraft] = useState<SectionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [busyAction, setBusyAction] = useState<GateAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);

  // Rescore delta (#164): snapshot the composite the instant rescoring starts so
  // the rail can show "↑/↓ from X%" once the new score lands. Client-only —
  // resets on remount and when switching items.
  const [prevComposite, setPrevComposite] = useState<number | null>(null);
  const wasRescoring = useRef(false);
  useEffect(() => {
    if (rescoring && !wasRescoring.current) {
      setPrevComposite(stored?.confidence?.composite ?? null);
    }
    wasRescoring.current = !!rescoring;
  }, [rescoring, stored]);
  useEffect(() => {
    setPrevComposite(null);
    wasRescoring.current = false;
  }, [id]);

  const [chatCount, setChatCount] = useState(0);
  const [drawerOpen, setDrawerOpen] = useStoredState(`skipper-plan-drawer:${id}`, "0");
  const [seen, setSeen] = useStoredState(`skipper-plan-chat-seen:${id}`, "0");
  const drawerIsOpen = drawerOpen === "1";
  useEffect(() => {
    if (drawerIsOpen) setSeen(String(chatCount));
  }, [drawerIsOpen, chatCount, setSeen]);
  const unread = Math.max(0, chatCount - Number(seen));

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

  const runAction = async (action: GateAction, note?: string) => {
    const to = action === "approve" ? "queued" : action === "replan" ? "planning" : "needs-input";
    const reason = action === "park" ? note?.trim() || undefined : undefined;
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

  if (!item) {
    return (
      <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
        <Link
          href="/inbox"
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-foreground transition-colors w-fit"
        >
          <ArrowLeft size={13} />
          {p.back}
        </Link>
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <Inbox size={40} className="opacity-30" />
          <p className="text-sm text-muted max-w-md">{p.notFound}</p>
        </div>
      </div>
    );
  }

  const editBusy = editingSection !== null || saving;
  const actionsDisabled = editBusy || busyAction !== null || chatBusy;

  return (
    <div className="min-h-full p-6">
      {saveError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2 text-sm">
          <span className="flex-1 break-all">
            {p.saveFailed}: {saveError}
          </span>
          <button onClick={() => setSaveError(null)} className="shrink-0 hover:text-red-200">
            <X size={14} />
          </button>
        </div>
      )}

      {item.state === "planning" ? (
        <div className="max-w-[720px] mx-auto space-y-3">
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
        <>
          <div className="flex flex-col gap-4 wide:grid wide:grid-cols-[minmax(0,1fr)_300px] wide:gap-8 wide:items-start">
            <DecisionRail
              itemId={id}
              stored={stored!}
              plan={plan}
              gate={gate}
              rescoring={rescoring}
              prevComposite={prevComposite}
              editBusy={editBusy}
              actionsDisabled={actionsDisabled}
              busyAction={busyAction}
              actionError={actionError}
              saving={saving}
              onAction={(action, note) => void runAction(action, note)}
              onSizeChange={(size) => void saveSize(size)}
            />
            <PlanDocument
              itemId={id}
              plan={plan}
              gate={gate}
              editingSection={editingSection}
              draft={draft}
              saving={saving}
              onStartEdit={startEdit}
              onDraftChange={setDraft}
              onSave={() => void saveEdit()}
              onCancel={cancelEdit}
              memoryRefs={item.usedMemory?.planning}
              memoriesTitle={p.sections.memories}
            />
          </div>
          {gate && !drawerIsOpen && (
            <PlanChatFab unread={unread} busy={chatBusy} onClick={() => setDrawerOpen("1")} />
          )}
          {gate && (
            <PlanChatDrawer
              open={drawerIsOpen}
              onClose={() => setDrawerOpen("0")}
              itemId={id}
              disabled={editBusy || busyAction !== null}
              onPlanUpdated={setStored}
              onBusyChange={setChatBusy}
              onCountChange={setChatCount}
            />
          )}
        </>
      )}
    </div>
  );
}
