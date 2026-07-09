"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { languages } from "@codemirror/language-data";
import { LanguageSupport } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import {
  Save,
  X,
  AlertTriangle,
  Circle,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useEditorTabs } from "@/lib/editor-tabs-context";
import { FileIcon } from "@/components/file-icon";
import { useT } from "@/lib/app-i18n";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary"; size: number }
  | { kind: "tooLarge"; size: number }
  | { kind: "error"; code: "noPath" | "desktopOnly" | "readFailed"; message?: string };

export function EditorFallback() {
  const { t } = useT();
  return (
    <div className="flex-1 flex items-center justify-center text-muted/50 text-sm">
      {t.wiki.editor.loadingEditor}
    </div>
  );
}

// Resolves a language pack for the given filename using CodeMirror's
// language-data index (~100 languages). The pack is loaded lazily via
// dynamic import, so only the parser for the actual file is pulled in.
// Unknown extensions return null → editor opens the file as plain text.
async function loadLanguageFor(
  filename: string,
): Promise<LanguageSupport | null> {
  const desc =
    // Match by extension first (cheap)
    languages.find((l) =>
      l.extensions.some((ext) =>
        filename.toLowerCase().endsWith("." + ext.toLowerCase()),
      ),
    ) ??
    // Then by explicit filename (Makefile, Dockerfile, etc.)
    languages.find((l) =>
      l.filename?.test(filename.split("/").pop() ?? filename),
    );
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function EditorView() {
  const { t } = useT();
  const te = t.wiki.editor;
  const router = useRouter();
  const params = useSearchParams();
  const filePath = params.get("path") ?? "";
  const { tabs, activePath, openTab, closeTab } = useEditorTabs();
  const fileName = useMemo(
    () => filePath.split("/").pop() || filePath,
    [filePath],
  );

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [originalContent, setOriginalContent] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [langExt, setLangExt] = useState<Extension[]>([]);
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  // Lazy-load the language pack for this file (syntax highlighting).
  // Unknown types keep langExt empty → plain-text editing still works.
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    loadLanguageFor(filePath).then((pack) => {
      if (cancelled) return;
      setLangExt(pack ? [pack] : []);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Track this file in the multi-tab strip. openTab is idempotent — if the
  // file is already a tab, it just becomes active. The URL is the source of
  // truth for "what to load"; the context tracks "what's open".
  useEffect(() => {
    if (filePath) openTab(filePath);
  }, [filePath, openTab]);

  const dirty = state.kind === "ready" && content !== originalContent;
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Load the file
  useEffect(() => {
    if (!filePath) {
      // Sync guard-branch setState; fine for this legacy surface (retired via #2)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ kind: "error", code: "noPath" });
      return;
    }
    if (typeof window === "undefined" || !window.nestbrain?.fs?.readFile) {
      setState({ kind: "error", code: "desktopOnly" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    window.nestbrain.fs
      .readFile(filePath)
      .then((res) => {
        if (cancelled) return;
        if (res.tooLarge) {
          setState({ kind: "tooLarge", size: res.size });
        } else if (res.binary) {
          setState({ kind: "binary", size: res.size });
        } else {
          setOriginalContent(res.content);
          setContent(res.content);
          setState({ kind: "ready", content: res.content });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          code: "readFailed",
          message: err instanceof Error ? err.message : undefined,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleSave = useCallback(async () => {
    if (state.kind !== "ready") return;
    if (!window.nestbrain?.fs?.writeFile) return;
    if (content === originalContent) return;
    setSaving(true);
    setError(null);
    try {
      await window.nestbrain.fs.writeFile(filePath, content);
      setOriginalContent(content);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : te.saveFailed);
    }
    setSaving(false);
  }, [content, originalContent, filePath, state.kind, te]);

  // Cmd/Ctrl+S to save
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave]);

  // Warn on browser/window close if dirty
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Guard client-side navigation via anchor clicks (sidebar Next.js <Link>s
  // don't fire beforeunload). Capture-phase click handler on document.
  useEffect(() => {
    if (!dirty) return;
    function onClickCapture(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const link = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("http")) return;
      const currentFull =
        window.location.pathname + window.location.search;
      if (href === currentFull || href === window.location.pathname) return;
      const ok = window.confirm(te.unsavedLeave(fileName));
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, [dirty, fileName, te]);

  const handleClose = useCallback(
    (pathToClose: string = filePath, isDirty: boolean = dirty) => {
      if (isDirty) {
        const ok = window.confirm(
          te.unsavedClose(pathToClose.split("/").pop() ?? pathToClose),
        );
        if (!ok) return;
      }
      const next = closeTab(pathToClose);
      if (next) {
        router.push(`/editor?path=${encodeURIComponent(next)}`);
      } else {
        router.push("/");
      }
    },
    [dirty, filePath, closeTab, router, te],
  );

  const extensions = useMemo(() => langExt, [langExt]);

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {/* Multi-tab strip + right-aligned save controls */}
      <div className="flex items-center border-b border-border bg-sidebar shrink-0">
        <TabsStrip
          tabs={tabs}
          activePath={activePath}
          currentDirty={dirty}
          onActivate={(p) => router.push(`/editor?path=${encodeURIComponent(p)}`)}
          onClose={(p) => handleClose(p, p === filePath ? dirty : false)}
        />

        <div className="flex items-center gap-3 px-4 shrink-0">
          {error && (
            <span className="flex items-center gap-1.5 text-[11px] text-red-400">
              <AlertTriangle size={11} />
              {error}
            </span>
          )}
          {savedFlash && (
            <span className="flex items-center gap-1.5 text-[11px] text-green-400/80">
              <Check size={11} />
              {te.saved}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-background text-[11px] font-medium rounded-md hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title={te.saveTitle}
          >
            <Save size={11} />
            {te.save}
          </button>
        </div>
      </div>

      {/* Editor area — keep all open files in the tab strip above; the active
          path drives the editor content via the URL */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {state.kind === "loading" && (
          <div className="h-full flex items-center justify-center text-muted/50 text-sm">
            {te.loading}
          </div>
        )}
        {state.kind === "error" && (
          <div className="h-full flex items-center justify-center text-red-400/80 text-sm">
            {state.message ??
              (state.code === "noPath"
                ? te.errNoPath
                : state.code === "desktopOnly"
                  ? te.errDesktopOnly
                  : te.errReadFailed)}
          </div>
        )}
        {state.kind === "binary" && (
          <div className="h-full flex flex-col items-center justify-center text-muted/60 text-sm gap-2">
            <AlertTriangle size={20} className="text-muted/40" />
            <p>{te.binaryFile}</p>
            <p className="text-[11px] text-muted/40">{formatSize(state.size)}</p>
          </div>
        )}
        {state.kind === "tooLarge" && (
          <div className="h-full flex flex-col items-center justify-center text-muted/60 text-sm gap-2">
            <AlertTriangle size={20} className="text-muted/40" />
            <p>{te.tooLarge(formatSize(state.size))}</p>
            <p className="text-[11px] text-muted/40">
              {te.tooLargeHint}
            </p>
          </div>
        )}
        {state.kind === "ready" && (
          <CodeMirror
            ref={cmRef}
            value={content}
            onChange={setContent}
            theme={oneDark}
            extensions={extensions}
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

/**
 * Horizontal scrollable tab strip with overflow chevrons (VSCode style).
 * The strip itself is `overflow-x-auto` so the user can scroll-wheel
 * sideways; the chevrons are just shortcuts. They appear only when the
 * strip is wider than its container.
 */
function TabsStrip({
  tabs,
  activePath,
  currentDirty,
  onActivate,
  onClose,
}: {
  tabs: string[];
  activePath: string | null;
  currentDirty: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const { t } = useT();
  const te = t.wiki.editor;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);

  // Recompute overflow on tab-count change + on container resize.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  // Auto-scroll the active tab into view when the active path changes.
  useEffect(() => {
    if (!activePath || !scrollerRef.current) return;
    const node = scrollerRef.current.querySelector<HTMLElement>(
      `[data-tab-path="${cssEscape(activePath)}"]`,
    );
    node?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [activePath]);

  const scrollBy = (delta: number) => {
    scrollerRef.current?.scrollBy({ left: delta, behavior: "smooth" });
  };

  return (
    <div className="flex items-center min-w-0 flex-1">
      {overflow && (
        <button
          onClick={() => scrollBy(-200)}
          className="px-1 py-2 text-muted/50 hover:text-foreground transition-colors shrink-0"
          title={te.scrollLeft}
        >
          <ChevronLeft size={14} />
        </button>
      )}
      <div
        ref={scrollerRef}
        className="flex items-stretch flex-1 min-w-0 overflow-x-auto scrollbar-none"
        style={{ scrollbarWidth: "none" }}
      >
        {tabs.map((path) => {
          const isActive = path === activePath;
          const name = path.split("/").pop() || path;
          const showDirty = isActive && currentDirty;
          return (
            <div
              key={path}
              data-tab-path={path}
              onClick={() => !isActive && onActivate(path)}
              className={`group flex items-center gap-2 px-3 py-2 border-r border-border cursor-pointer text-[12px] transition-colors shrink-0 max-w-[220px] ${
                isActive
                  ? "bg-background text-foreground"
                  : "text-muted/70 hover:text-foreground hover:bg-card"
              }`}
              title={path}
            >
              <FileIcon name={name} size={13} />
              <span className="truncate">{name}</span>
              {showDirty ? (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(path);
                  }}
                  className="ml-1 shrink-0"
                  title={te.unsavedDot}
                >
                  <Circle size={8} className="text-accent fill-accent group-hover:hidden" />
                  <X
                    size={13}
                    className="text-muted/50 hover:text-foreground hidden group-hover:inline"
                  />
                </span>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(path);
                  }}
                  className="ml-1 shrink-0 text-muted/30 group-hover:text-muted/60 hover:text-foreground transition-colors"
                  title={te.close}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {overflow && (
        <button
          onClick={() => scrollBy(200)}
          className="px-1 py-2 text-muted/50 hover:text-foreground transition-colors shrink-0"
          title={te.scrollRight}
        >
          <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}

/** Minimal CSS.escape polyfill for attribute selectors. */
function cssEscape(s: string): string {
  return s.replace(/(["\\#.[\]:>~+*=^$()|/?{}@!,;'`%& \t\n])/g, "\\$1");
}
