"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Circle,
  ExternalLink,
  Inbox,
  Loader2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import type { WorktreeFileChange, WorktreeFileContents } from "@nestbrain/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { repoKey } from "@/lib/inbox/model";
import { markerClass } from "@/lib/git-status-context";
import { FileIcon } from "@/components/file-icon";
import { StateBadge } from "../state-badge";
import { MergeEditor } from "./merge-editor";

const STATUS_MARKER: Record<WorktreeFileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

type ChangesState =
  | { kind: "loading" }
  | { kind: "ready"; files: WorktreeFileChange[] }
  | { kind: "error"; message: string };

type FileState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; file: WorktreeFileContents }
  | { kind: "error"; message: string };

export function ReviewDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const router = useRouter();
  const { state, requestTransition, openPr } = useOrchestrator();
  const { t } = useT();
  const r = t.inbox.review;

  const item = state?.items.find((i) => i.id === id);
  const live = item?.state === "human-review";

  const [changes, setChanges] = useState<ChangesState>({ kind: "loading" });
  const [selected, setSelected] = useState<WorktreeFileChange | null>(null);
  const [fileState, setFileState] = useState<FileState>({ kind: "idle" });
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"openPr" | "close" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const dirty = fileState.kind === "ready" && content !== savedContent;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const fetchChanges = useCallback(
    async (keepSelection: boolean) => {
      if (!window.nestbrain) return;
      if (!keepSelection) setChanges({ kind: "loading" });
      const result = await window.nestbrain.orchestrator.getWorktreeChanges(id);
      if (result.ok) setChanges({ kind: "ready", files: result.files });
      else setChanges({ kind: "error", message: result.error });
    },
    [id],
  );

  useEffect(() => {
    if (item?.worktree) void fetchChanges(false);
  }, [item?.worktree, fetchChanges]);

  const openFile = useCallback(
    async (change: WorktreeFileChange) => {
      if (!window.nestbrain) return;
      setSelected(change);
      setSaveError(null);
      setFileState({ kind: "loading" });
      const result = await window.nestbrain.orchestrator.readWorktreeFile(
        id,
        change.path,
        change.oldPath,
      );
      if (result.ok) {
        setFileState({ kind: "ready", file: result.file });
        setContent(result.file.modified ?? "");
        setSavedContent(result.file.modified ?? "");
      } else {
        setFileState({ kind: "error", message: result.error });
      }
    },
    [id],
  );

  const selectFile = (change: WorktreeFileChange) => {
    if (change.path === selected?.path) return;
    if (dirtyRef.current && !window.confirm(r.unsavedSwitch(selected?.path ?? ""))) return;
    void openFile(change);
  };

  const handleSave = useCallback(async () => {
    if (!window.nestbrain || !selected || !dirtyRef.current || !live) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await window.nestbrain.orchestrator.saveWorktreeFile(
        id,
        selected.path,
        content,
      );
      if (result.ok) {
        setSavedContent(content);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
        void fetchChanges(true);
      } else {
        setSaveError(result.error);
      }
    } finally {
      setSaving(false);
    }
  }, [id, selected, content, live, fetchChanges]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave]);

  // Guard navigation away with unsaved worktree edits (editor-view pattern):
  // beforeunload for reload/close, capture-phase click for in-app links.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    const onClickCapture = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      const anchor = (e.target as HTMLElement).closest("a[href]");
      if (!anchor) return;
      if (!window.confirm(r.unsavedSwitch(selected?.path ?? ""))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [r, selected?.path]);

  const runOpenPr = async () => {
    setBusyAction("openPr");
    setActionError(null);
    try {
      const result = await openPr(id);
      if (result.ok) router.push("/inbox");
      else setActionError(result.error);
    } finally {
      setBusyAction(null);
    }
  };

  const runClose = async () => {
    setBusyAction("close");
    setActionError(null);
    try {
      const result = await requestTransition(id, "closed");
      if (result.ok) router.push("/inbox");
      else setActionError(result.error);
    } finally {
      setBusyAction(null);
    }
  };

  const isElectron = typeof window !== "undefined" && !!window.nestbrain;

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
      {t.inbox.plan.back}
    </Link>
  );

  if (!item) {
    return (
      <div className="min-h-full p-6 space-y-4 max-w-3xl mx-auto">
        {backLink}
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <Inbox size={40} className="opacity-30" />
          <p className="text-sm text-muted max-w-md">{t.inbox.plan.notFound}</p>
        </div>
      </div>
    );
  }

  const review = item.review;

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <div className="space-y-2 shrink-0">
        {backLink}
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-[13px] text-muted shrink-0">#{item.number}</span>
          <h1 className="text-xl font-semibold tracking-tight min-w-0">{item.title}</h1>
          <button
            onClick={() => void window.nestbrain?.openExternal(item.url)}
            className="p-1 rounded text-muted hover:text-accent transition-colors shrink-0 self-center"
            title={item.url}
          >
            <ExternalLink size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-muted">
          <span>{repoKey(item.repo)}</span>
          <StateBadge item={item} />
        </div>
      </div>

      {!live && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 px-3 py-2 text-sm shrink-0">
          <AlertTriangle size={14} className="shrink-0" />
          {r.leftReview}
        </div>
      )}

      {review && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-1.5 shrink-0 text-[12px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground">{r.agentReview}</span>
            <span className="px-1.5 py-0.5 rounded border bg-card-hover/40 border-border uppercase text-[11px]">
              {review.outcome}
            </span>
            <span className="text-muted">
              {review.rounds} {r.rounds}
            </span>
          </div>
          {review.reason && <p className="text-muted">{review.reason}</p>}
          {review.objections && review.objections.length > 0 && (
            <ul className="space-y-1 pt-1">
              {review.objections.map((o, i) => (
                <li key={i} className="flex items-start gap-1.5 text-muted">
                  <AlertTriangle
                    size={12}
                    className={`mt-0.5 shrink-0 ${o.blocking ? "text-red-400" : "text-amber-400"}`}
                  />
                  <span>
                    <span className="uppercase text-[10px] text-muted/60 mr-1">{o.kind}</span>
                    {o.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 space-y-2 shrink-0">
        <div
          className="flex items-center gap-2 flex-wrap"
          title={dirty ? r.saveBeforePr : undefined}
        >
          <button
            onClick={() => void runOpenPr()}
            disabled={dirty || busyAction !== null || !live}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {busyAction === "openPr" && <Loader2 size={11} className="animate-spin" />}
            {t.inbox.actions.openPr}
          </button>
          <button
            onClick={() => void runClose()}
            disabled={busyAction !== null || !live}
            className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            {busyAction === "close" && <Loader2 size={11} className="animate-spin" />}
            {t.inbox.actions.close}
          </button>
          {dirty && <span className="text-[11px] text-muted">{r.saveBeforePr}</span>}
        </div>
        {actionError && <p className="text-[12px] text-red-300 break-all">{actionError}</p>}
      </div>

      <div className="flex-1 min-h-0 flex rounded-lg border border-border overflow-hidden">
        <div className="w-64 shrink-0 border-r border-border bg-sidebar flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border text-[11px] text-muted shrink-0">
            <span>
              {changes.kind === "ready" ? r.filesChanged(changes.files.length) : r.title}
            </span>
            <button
              onClick={() => void fetchChanges(false)}
              className="p-1 rounded hover:text-foreground transition-colors"
              title={r.refresh}
            >
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {changes.kind === "loading" && (
              <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted">
                <Loader2 size={12} className="animate-spin" />
                {r.loading}
              </div>
            )}
            {changes.kind === "error" && (
              <p className="px-3 py-2 text-[12px] text-red-300 break-all">
                {r.loadFailed}: {changes.message}
              </p>
            )}
            {changes.kind === "ready" && changes.files.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-muted">{r.noChanges}</p>
            )}
            {changes.kind === "ready" &&
              changes.files.map((change) => {
                const marker = STATUS_MARKER[change.status];
                const active = change.path === selected?.path;
                return (
                  <button
                    key={change.path}
                    onClick={() => selectFile(change)}
                    className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-left transition-colors ${
                      active ? "bg-card-hover text-foreground" : "text-muted hover:bg-card-hover/50"
                    }`}
                    title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
                  >
                    <span className={`font-mono shrink-0 w-3 ${markerClass(marker)}`}>
                      {marker}
                    </span>
                    <FileIcon name={change.path.split("/").pop() ?? change.path} size={13} />
                    <span className="truncate min-w-0 flex-1" dir="rtl">
                      {change.path}
                    </span>
                    {active && dirty && (
                      <Circle size={7} className="shrink-0 fill-accent text-accent" />
                    )}
                  </button>
                );
              })}
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col bg-background">
          {selected && fileState.kind === "ready" && fileState.file.modified !== null && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-[11px] text-muted shrink-0">
              <span className="flex-1 truncate">
                {selected.status === "added"
                  ? r.newFile
                  : `${r.original} ← → ${r.modified}`}
              </span>
              {saveError && (
                <span className="text-red-300 break-all">
                  {r.saveFailed}: {saveError}
                </span>
              )}
              {savedFlash && (
                <span className="flex items-center gap-1 text-green-300">
                  <Check size={11} />
                  {r.saved}
                </span>
              )}
              <button
                onClick={() => void handleSave()}
                disabled={!dirty || saving || !live}
                className="flex items-center gap-1 font-medium px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Save size={11} />
                )}
                {r.save}
              </button>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-auto">
            {!selected && (
              <div className="h-full flex items-center justify-center text-[13px] text-muted/60">
                {r.pickFile}
              </div>
            )}
            {selected && fileState.kind === "loading" && (
              <div className="h-full flex items-center justify-center gap-2 text-muted">
                <Loader2 size={16} className="animate-spin" />
              </div>
            )}
            {selected && fileState.kind === "error" && (
              <p className="p-4 text-sm text-red-300 break-all">
                {r.loadFailed}: {fileState.message}
              </p>
            )}
            {selected && fileState.kind === "ready" && fileState.file.binary && (
              <div className="h-full flex items-center justify-center text-[13px] text-muted/60">
                {r.binaryFile}
              </div>
            )}
            {selected && fileState.kind === "ready" && fileState.file.tooLarge && (
              <div className="h-full flex items-center justify-center text-[13px] text-muted/60">
                {r.tooLarge}
              </div>
            )}
            {selected &&
              fileState.kind === "ready" &&
              !fileState.file.binary &&
              !fileState.file.tooLarge &&
              fileState.file.modified === null && (
                <div className="h-full flex flex-col">
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-[11px] text-red-300 shrink-0">
                    <X size={11} />
                    {r.deletedFile}
                  </div>
                  <pre className="flex-1 overflow-auto p-3 text-[13px] text-muted whitespace-pre-wrap">
                    {fileState.file.original ?? ""}
                  </pre>
                </div>
              )}
            {selected &&
              fileState.kind === "ready" &&
              !fileState.file.binary &&
              !fileState.file.tooLarge &&
              fileState.file.modified !== null && (
                <MergeEditor
                  key={selected.path}
                  filePath={selected.path}
                  original={fileState.file.original ?? ""}
                  modified={fileState.file.modified}
                  onChange={setContent}
                />
              )}
          </div>
        </div>
      </div>
    </div>
  );
}
