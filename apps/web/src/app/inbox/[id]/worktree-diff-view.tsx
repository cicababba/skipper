"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";
import { Check, Loader2, Save, X } from "lucide-react";
import type { WorktreeFileChange, WorktreeFileContents } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { loadLanguageFor } from "@/lib/codemirror-lang";
import { MergeEditor } from "./merge-editor";

type DiffMode = "split" | "unified" | "edit";

type FileState =
  | { kind: "loading" }
  | { kind: "ready"; file: WorktreeFileContents }
  | { kind: "error"; message: string };

interface WorktreeDiffViewProps {
  itemId: string;
  change: WorktreeFileChange;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

// Right-pane diff for one changed worktree file (#114). Parent mounts with
// key={change.path}, so a file switch remounts with fresh state; `mode` is
// lifted so the split/unified/edit choice persists across files.
export function WorktreeDiffView({
  itemId,
  change,
  mode,
  onModeChange,
  onSaved,
  onDirtyChange,
}: WorktreeDiffViewProps) {
  const { t } = useT();
  const r = t.inbox.review;
  const w = t.inbox.worktree;
  const fileName = change.path.split("/").pop() ?? change.path;

  const [fileState, setFileState] = useState<FileState>({ kind: "loading" });
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [langExt, setLangExt] = useState<Extension[]>([]);

  const editable = fileState.kind === "ready" && fileState.file.modified !== null;
  const dirty = editable && content !== savedContent;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current(dirty);
    return () => onDirtyChangeRef.current(false);
  }, [dirty]);

  useEffect(() => {
    let cancelled = false;
    loadLanguageFor(change.path).then((pack) => {
      if (!cancelled) setLangExt(pack ? [pack] : []);
    });
    return () => {
      cancelled = true;
    };
  }, [change.path]);

  useEffect(() => {
    if (!window.skipper) return;
    let cancelled = false;
    window.skipper.orchestrator.readWorktreeFile(itemId, change.path, change.oldPath).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setFileState({ kind: "ready", file: res.file });
        setContent(res.file.modified ?? "");
        setSavedContent(res.file.modified ?? "");
      } else {
        setFileState({ kind: "error", message: res.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, change.path, change.oldPath]);

  const handleSave = useCallback(async () => {
    if (!window.skipper || !dirtyRef.current) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await window.skipper.orchestrator.saveWorktreeFile(itemId, change.path, content);
      if (res.ok) {
        setSavedContent(content);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
        onSaved();
      } else {
        setSaveError(res.error);
      }
    } finally {
      setSaving(false);
    }
  }, [itemId, change.path, content, onSaved]);

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

  // Guard navigation away with unsaved worktree edits: beforeunload for
  // reload/close, capture-phase click for in-app links.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    const onClickCapture = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      const anchor = (e.target as HTMLElement).closest("a[href]");
      if (!anchor) return;
      if (!window.confirm(r.unsavedSwitch(change.path))) {
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
  }, [r, change.path]);

  const ready = fileState.kind === "ready" ? fileState.file : null;
  const showControls =
    ready !== null && !ready.binary && !ready.tooLarge && ready.modified !== null;

  const modeButton = (m: DiffMode, label: string) => (
    <button
      onClick={() => onModeChange(m)}
      className={`px-2 py-0.5 rounded transition-colors ${
        mode === m ? "bg-card-hover text-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-[11px] text-muted shrink-0">
        <span
          className="flex-1 truncate"
          title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
        >
          {fileName}
        </span>
        {showControls && (
          <div className="flex items-center gap-0.5 rounded border border-border p-0.5">
            {modeButton("split", w.viewSplit)}
            {modeButton("unified", w.viewUnified)}
            {modeButton("edit", w.viewEdit)}
          </div>
        )}
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
        {showControls && (
          <button
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className="flex items-center gap-1 font-medium px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            {r.save}
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {fileState.kind === "loading" && (
          <div className="h-full flex items-center justify-center gap-2 text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
        {fileState.kind === "error" && (
          <p className="p-4 text-sm text-red-300 break-all">
            {r.loadFailed}: {fileState.message}
          </p>
        )}
        {ready && ready.binary && (
          <div className="h-full flex items-center justify-center text-[13px] text-muted/60">
            {r.binaryFile}
          </div>
        )}
        {ready && ready.tooLarge && (
          <div className="h-full flex items-center justify-center text-[13px] text-muted/60">
            {r.tooLarge}
          </div>
        )}
        {ready && !ready.binary && !ready.tooLarge && ready.modified === null && (
          <div className="h-full flex flex-col">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-[11px] text-red-300 shrink-0">
              <X size={11} />
              {r.deletedFile}
            </div>
            <pre className="flex-1 overflow-auto p-3 text-[13px] text-muted whitespace-pre-wrap">
              {ready.original ?? ""}
            </pre>
          </div>
        )}
        {ready && !ready.binary && !ready.tooLarge && ready.modified !== null && mode === "edit" && (
          <CodeMirror
            value={content}
            onChange={setContent}
            theme={oneDark}
            extensions={langExt}
            height="100%"
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: false,
            }}
            style={{ height: "100%", fontSize: 13 }}
          />
        )}
        {ready && !ready.binary && !ready.tooLarge && ready.modified !== null && mode !== "edit" && (
          <MergeEditor
            filePath={change.path}
            original={ready.original ?? ""}
            modified={content}
            mode={mode}
            onChange={setContent}
          />
        )}
      </div>
    </div>
  );
}
