"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";
import { AlertTriangle, Check, Loader2, Save } from "lucide-react";
import { useT } from "@/lib/app-i18n";
import { loadLanguageFor } from "@/lib/codemirror-lang";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "binary" }
  | { kind: "tooLarge" }
  | { kind: "error"; message: string };

// Single-file editor for the worktree control center (#40). The parent keys
// this component by path, so a file switch remounts with fresh state.
export function WorktreeFileView({ path }: { path: string }) {
  const { t } = useT();
  const r = t.inbox.review;
  const fileName = path.split("/").pop() ?? path;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [langExt, setLangExt] = useState<Extension[]>([]);

  const dirty = state.kind === "ready" && content !== savedContent;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    let cancelled = false;
    loadLanguageFor(path).then((pack) => {
      if (!cancelled) setLangExt(pack ? [pack] : []);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (!window.skipper?.fs?.readFile) return;
    let cancelled = false;
    window.skipper.fs
      .readFile(path)
      .then((res) => {
        if (cancelled) return;
        if (res.tooLarge) setState({ kind: "tooLarge" });
        else if (res.binary) setState({ kind: "binary" });
        else {
          setContent(res.content);
          setSavedContent(res.content);
          setState({ kind: "ready" });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const handleSave = useCallback(async () => {
    if (!window.skipper?.fs?.writeFile || !dirtyRef.current) return;
    setSaving(true);
    setSaveError(null);
    try {
      await window.skipper.fs.writeFile(path, content);
      setSavedContent(content);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : r.saveFailed);
    } finally {
      setSaving(false);
    }
  }, [path, content, r]);

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

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-[11px] text-muted shrink-0">
        <span className="flex-1 truncate" title={path}>
          {fileName}
        </span>
        {saveError && (
          <span className="flex items-center gap-1 text-red-300 break-all">
            <AlertTriangle size={11} />
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
          disabled={!dirty || saving}
          className="flex items-center gap-1 font-medium px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          {r.save}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {state.kind === "loading" && (
          <div className="h-full flex items-center justify-center gap-2 text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
        {state.kind === "error" && (
          <p className="p-4 text-sm text-red-300 break-all">
            {r.loadFailed}: {state.message}
          </p>
        )}
        {state.kind === "binary" && (
          <div className="h-full flex items-center justify-center text-[13px] text-muted/60">
            {r.binaryFile}
          </div>
        )}
        {state.kind === "tooLarge" && (
          <div className="h-full flex items-center justify-center text-[13px] text-muted/60">
            {r.tooLarge}
          </div>
        )}
        {state.kind === "ready" && (
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
      </div>
    </div>
  );
}
