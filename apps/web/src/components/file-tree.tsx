"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  ExternalLink,
  GitBranch,
  Share2,
  Download,
  Loader2,
  Copy,
  Check,
  X,
} from "lucide-react";
import { useT } from "@/lib/app-i18n";
import { FileIcon } from "./file-icon";
import { useGitStatus, pickMarker, markerClass } from "@/lib/git-status-context";
import { useTerminal } from "@/lib/terminal-context";

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileTreeProps {
  rootPath: string;
}

type CreateKind = "file" | "dir";

export function FileTree({ rootPath }: FileTreeProps) {
  const router = useRouter();
  const { t } = useT();

  const [expanded, setExpanded] = useState<Set<string>>(
    new Set([rootPath, `${rootPath}/Projects`]),
  );
  const [refreshKey, setRefreshKey] = useState(0);
  // selectedPath can be a file or a directory. The "effective parent"
  // for creation = selectedPath if it's a directory, else its parent,
  // else rootPath.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedIsDir, setSelectedIsDir] = useState<boolean>(false);
  const [creating, setCreating] = useState<{
    kind: CreateKind;
    parent: string;
  } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    name: string;
    isDir: boolean;
  } | null>(null);
  const [session, setSession] = useState<{
    mode: "save" | "resume";
    project: string;
    busy: boolean;
    output: string;
  } | null>(null);

  async function runSession(mode: "save" | "resume", path: string, name: string) {
    if (typeof window === "undefined" || !window.nestbrain?.session) return;
    setSession({ mode, project: name, busy: true, output: "" });
    try {
      const r = await window.nestbrain.session.run(mode, path);
      setSession({ mode, project: name, busy: false, output: r.output });
    } catch (e) {
      setSession({ mode, project: name, busy: false, output: e instanceof Error ? e.message : "Failed" });
    }
  }

  const toggle = useCallback((path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectEntry = useCallback((path: string, isDir: boolean) => {
    setSelectedPath(path);
    setSelectedIsDir(isDir);
  }, []);

  const openFile = useCallback(
    (path: string) => {
      router.push(`/editor?path=${encodeURIComponent(path)}`);
    },
    [router],
  );

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // A directory that's a direct child of Projects/ (a project root).
  const isProjectDir = useCallback(
    (p: string): boolean => {
      const norm = p.replace(/\\/g, "/");
      const base = `${rootPath.replace(/\\/g, "/")}/Projects/`;
      if (!norm.startsWith(base)) return false;
      const rest = norm.slice(base.length);
      return rest.length > 0 && !rest.includes("/");
    },
    [rootPath],
  );


  // Auto refresh when window gains focus
  useEffect(() => {
    function onFocus() {
      refresh();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Auto refresh when the native file watcher reports a change
  useEffect(() => {
    if (typeof window === "undefined" || !window.nestbrain?.fs?.onChange) {
      return;
    }
    const off = window.nestbrain.fs.onChange(refresh);
    return off;
  }, [refresh]);

  // Dismiss context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return;
    function onGlobalClick() {
      setContextMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    window.addEventListener("click", onGlobalClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onGlobalClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const openContextMenu = useCallback(
    (e: React.MouseEvent, path: string, name: string, isDir: boolean) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, path, name, isDir });
    },
    [],
  );

  async function handleRename(oldPath: string, newName: string) {
    if (!window.nestbrain?.fs?.rename) return;
    const oldBase = oldPath.slice(oldPath.lastIndexOf("/") + 1);
    // Same name (or blur/esc) → just close the rename input, don't hit IPC
    if (!newName || newName === oldBase) {
      setRenamingPath(null);
      return;
    }
    try {
      await window.nestbrain.fs.rename(oldPath, newName);
      setRenamingPath(null);
      // Clear stale selection (path changed under us)
      if (selectedPath === oldPath) setSelectedPath(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.tree.files.renameFailed);
      setRenamingPath(null);
    }
  }

  async function handleDelete(targetPath: string, name: string, isDir: boolean) {
    if (!window.nestbrain) return;
    const kind = isDir ? t.tree.files.folderWord : t.tree.files.fileWord;
    const extraMsg = isDir ? `\n${t.tree.files.deleteFolderNote}` : "";
    const ok = window.confirm(
      `${t.tree.files.deleteConfirm(kind, name)}${extraMsg}\n\n${t.tree.files.cannotUndo}`,
    );
    if (!ok) return;
    try {
      await window.nestbrain.fs.delete(targetPath);
      if (selectedPath === targetPath) setSelectedPath(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.tree.files.deleteFailed);
    }
  }

  function effectiveParent(): string {
    if (!selectedPath) return rootPath;
    if (selectedIsDir) return selectedPath;
    // File selected → create sibling (in its parent)
    const lastSlash = selectedPath.lastIndexOf("/");
    return lastSlash > 0 ? selectedPath.slice(0, lastSlash) : rootPath;
  }

  function startCreate(kind: CreateKind) {
    const parent = effectiveParent();
    setCreating({ kind, parent });
    setCreateError(null);
    // Ensure the parent directory is expanded so the new item appears
    setExpanded((s) => new Set(s).add(parent));
  }

  async function confirmCreate(name: string) {
    if (!creating || !window.nestbrain?.fs) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setCreating(null);
      return;
    }
    if (trimmed.includes("/") || trimmed === "." || trimmed === "..") {
      setCreateError(t.tree.files.invalidName);
      return;
    }
    const fullPath = `${creating.parent}/${trimmed}`;
    try {
      if (creating.kind === "dir") {
        await window.nestbrain.fs.createDir(fullPath);
      } else {
        await window.nestbrain.fs.writeFile(fullPath, "");
      }
      setCreating(null);
      setCreateError(null);
      // File watcher will auto-refresh. Open the new file in the editor.
      if (creating.kind === "file") {
        router.push(`/editor?path=${encodeURIComponent(fullPath)}`);
      }
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : t.tree.files.createFailed,
      );
    }
  }

  const parentLabel = creating
    ? creating.parent === rootPath
      ? "NestBrain"
      : creating.parent.replace(rootPath + "/", "")
    : "";

  return (
    <div className="flex-shrink-0 border-b border-sidebar-border">
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold text-muted/60 uppercase tracking-wider">
          NestBrain
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => startCreate("file")}
            className="p-1 text-muted/40 hover:text-foreground hover:bg-card rounded transition-colors"
            title={t.tree.files.newFileTitle}
          >
            <FilePlus size={12} />
          </button>
          <button
            onClick={() => startCreate("dir")}
            className="p-1 text-muted/40 hover:text-foreground hover:bg-card rounded transition-colors"
            title={t.tree.files.newFolderTitle}
          >
            <FolderPlus size={12} />
          </button>
        </div>
      </div>

      {creating && (
        <CreateInput
          kind={creating.kind}
          parentLabel={parentLabel}
          error={createError}
          onConfirm={confirmCreate}
          onCancel={() => {
            setCreating(null);
            setCreateError(null);
          }}
        />
      )}

      <div className="max-h-[300px] overflow-y-auto pb-2 pr-1">
        <TreeNode
          path={rootPath}
          name="NestBrain"
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          onOpenFile={openFile}
          onSelect={selectEntry}
          onContextMenu={openContextMenu}
          onRenameConfirm={handleRename}
          renamingPath={renamingPath}
          selectedPath={selectedPath}
          isDir
          isRoot
          refreshKey={refreshKey}
        />
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isDir={contextMenu.isDir}
          onOpen={
            contextMenu.isDir
              ? undefined
              : () => {
                  openFile(contextMenu.path);
                  setContextMenu(null);
                }
          }
          onRename={() => {
            setRenamingPath(contextMenu.path);
            setContextMenu(null);
          }}
          onDelete={() => {
            const { path, name, isDir } = contextMenu;
            setContextMenu(null);
            handleDelete(path, name, isDir);
          }}
          onSessionSave={
            contextMenu.isDir && isProjectDir(contextMenu.path)
              ? () => {
                  const { path, name } = contextMenu;
                  setContextMenu(null);
                  void runSession("save", path, name);
                }
              : undefined
          }
          onSessionResume={
            contextMenu.isDir && isProjectDir(contextMenu.path)
              ? () => {
                  const { path, name } = contextMenu;
                  setContextMenu(null);
                  void runSession("resume", path, name);
                }
              : undefined
          }
        />
      )}
      {session && <SessionDialog session={session} onClose={() => setSession(null)} />}
    </div>
  );
}

function SessionDialog({
  session,
  onClose,
}: {
  session: { mode: "save" | "resume"; project: string; busy: boolean; output: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const title = session.mode === "save" ? "Save session for another machine" : "Resume session here";
  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !session.busy) onClose();
      }}
    >
      <div className="w-[640px] max-w-[92vw] max-h-[82vh] rounded-2xl bg-card border border-border shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
          {session.mode === "save" ? <Share2 size={16} className="text-accent" /> : <Download size={16} className="text-accent" />}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight">{title}</h2>
            <p className="text-[11px] text-muted font-mono truncate">{session.project}</p>
          </div>
          {!session.busy && (
            <button onClick={onClose} className="ml-auto p-1 rounded text-muted hover:text-foreground hover:bg-card-hover">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-auto p-5">
          {session.busy ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" />
              {session.mode === "save" ? "Generating the session summary…" : "Building the resumption briefing…"}
            </div>
          ) : (
            <pre className="text-[12px] leading-relaxed whitespace-pre-wrap font-mono text-foreground/90">{session.output}</pre>
          )}
        </div>
        {!session.busy && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-border">
            {session.mode === "resume" && (
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(session.output).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="flex items-center gap-1.5 text-xs font-semibold text-background bg-accent hover:bg-accent-hover rounded-lg px-3.5 py-2 transition-colors"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy briefing"}
              </button>
            )}
            <button onClick={onClose} className="text-xs font-medium text-muted hover:text-foreground border border-border hover:border-accent/40 rounded-lg px-3.5 py-2 transition-colors">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface ContextMenuProps {
  x: number;
  y: number;
  isDir: boolean;
  onOpen?: () => void;
  onRename: () => void;
  onDelete: () => void;
  onSessionSave?: () => void;
  onSessionResume?: () => void;
}

function ContextMenu({
  x,
  y,
  onOpen,
  onRename,
  onDelete,
  onSessionSave,
  onSessionResume,
}: ContextMenuProps) {
  const { t } = useT();
  // Clamp within viewport so it doesn't clip on the right/bottom
  const MENU_W = 220;
  const MENU_H = 120;
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H - 8);
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[200] w-56 py-1 bg-card border border-border rounded-lg shadow-xl shadow-black/40 text-[12px]"
      style={{ left, top }}
    >
      {onOpen && (
        <>
          <MenuItem
            icon={<ExternalLink size={12} />}
            label={t.tree.files.open}
            onClick={onOpen}
          />
          <div className="my-1 h-px bg-border/60" />
        </>
      )}
      {onSessionSave && (
        <MenuItem
          icon={<Share2 size={12} />}
          label="Save session for another machine"
          onClick={onSessionSave}
        />
      )}
      {onSessionResume && (
        <>
          <MenuItem
            icon={<Download size={12} />}
            label="Resume session here"
            onClick={onSessionResume}
          />
          <div className="my-1 h-px bg-border/60" />
        </>
      )}
      <MenuItem
        icon={<Pencil size={12} />}
        label={t.tree.files.rename}
        onClick={onRename}
      />
      <MenuItem
        icon={<Trash2 size={12} />}
        label={t.tree.files.delete}
        onClick={onDelete}
        danger
      />
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
        danger
          ? "text-red-400/90 hover:bg-red-500/10"
          : "text-foreground hover:bg-accent/10"
      }`}
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

interface RenameInputProps {
  initialValue: string;
  depth: number;
  isDir: boolean;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

function RenameInput({
  initialValue,
  depth,
  isDir,
  onConfirm,
  onCancel,
}: RenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select filename stem (without extension) like most editors
    const dot = initialValue.lastIndexOf(".");
    if (!isDir && dot > 0) {
      input.setSelectionRange(0, dot);
    } else {
      input.select();
    }
  }, [initialValue, isDir]);

  const indent = depth * 10;

  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5"
      style={{ paddingLeft: `${indent + 8}px` }}
    >
      <div className="w-[11px] shrink-0" />
      {isDir ? (
        <Folder size={13} className="shrink-0 text-accent/70" />
      ) : (
        <FileIcon name={value || "file"} size={13} />
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (value.trim() && value.trim() !== initialValue) {
              onConfirm(value.trim());
            } else {
              onCancel();
            }
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        onBlur={() => onCancel()}
        className="flex-1 min-w-0 px-1 py-0 bg-background border border-accent/60 rounded text-[12px] text-foreground focus:outline-none"
      />
    </div>
  );
}

interface CreateInputProps {
  kind: CreateKind;
  parentLabel: string;
  error: string | null;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

function CreateInput({
  kind,
  parentLabel,
  error,
  onConfirm,
  onCancel,
}: CreateInputProps) {
  const { t } = useT();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="px-3 py-2 border-t border-b border-border/50 bg-card/40">
      <div className="text-[10px] text-muted/50 mb-1 truncate">
        {kind === "file" ? t.tree.files.newFileIn : t.tree.files.newFolderIn}{" "}
        <span className="text-muted/80 font-mono">{parentLabel}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {kind === "file" ? (
          <FileIcon name={value || "file"} size={12} />
        ) : (
          <Folder size={12} className="shrink-0 text-muted/40" />
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onConfirm(value);
            } else if (e.key === "Escape") {
              onCancel();
            }
          }}
          onBlur={() => {
            if (!value.trim()) onCancel();
          }}
          placeholder={kind === "file" ? t.tree.files.filePlaceholder : t.tree.files.folderPlaceholder}
          className="flex-1 min-w-0 px-1.5 py-0.5 bg-background border border-accent/40 rounded text-[12px] text-foreground placeholder:text-muted/30 focus:outline-none focus:border-accent/70"
        />
      </div>
      {error && (
        <div className="mt-1 text-[10px] text-red-400/80">{error}</div>
      )}
    </div>
  );
}

interface TreeNodeProps {
  path: string;
  name: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelect: (path: string, isDir: boolean) => void;
  onContextMenu: (
    e: React.MouseEvent,
    path: string,
    name: string,
    isDir: boolean,
  ) => void;
  onRenameConfirm: (oldPath: string, newName: string) => void;
  renamingPath: string | null;
  selectedPath: string | null;
  isDir: boolean;
  isRoot?: boolean;
  /** Bumped to force open folders to re-read their children in place
   *  (without remounting the tree — that caused the visible flash). */
  refreshKey: number;
}

function TreeNode({
  path,
  name,
  depth,
  expanded,
  onToggle,
  onOpenFile,
  onSelect,
  onContextMenu,
  onRenameConfirm,
  renamingPath,
  selectedPath,
  isDir,
  isRoot,
  refreshKey,
}: TreeNodeProps) {
  const { t } = useT();
  const isOpen = expanded.has(path);
  const isSelected = selectedPath === path;
  const isRenaming = renamingPath === path;
  const [children, setChildren] = useState<FsEntry[] | null>(null);

  // Git integration. For every folder rendered in the tree, we ask the
  // main process "is this the top of a git repo?" once. If yes, we both
  // register it in the shared status context (so the file rows under it
  // get per-file markers) AND show a small GitBranch icon that opens a
  // new terminal at the repo + lights up the branch indicator.
  const { repos, registerRepo } = useGitStatus();
  const { openTerminal } = useTerminal();
  const [isRepoTop, setIsRepoTop] = useState(false);
  useEffect(() => {
    if (!isDir) return;
    if (typeof window === "undefined" || !window.nestbrain?.git) return;
    let cancelled = false;
    void window.nestbrain.git.findRepo(path).then((res) => {
      if (cancelled) return;
      if (res && res.repoPath === path) {
        setIsRepoTop(true);
        registerRepo(path);
      } else {
        setIsRepoTop(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // refreshKey: a fresh git init (new project) must light the repo icon on
    // the next tree refresh without remounting the node.
  }, [isDir, path, registerRepo, refreshKey]);

  // Resolve the ancestor repo for marker computation. We pick the LONGEST
  // matching prefix so nested checkouts (a sub-repo inside a project) win
  // over the outer one.
  const ancestor = useMemo(() => {
    let best: { repoPath: string; relPath: string } | null = null;
    for (const repoPath of Object.keys(repos)) {
      if (!repos[repoPath]) continue;
      if (path === repoPath || path.startsWith(repoPath + "/")) {
        const rel = path === repoPath ? "" : path.slice(repoPath.length + 1);
        if (!best || repoPath.length > best.repoPath.length) {
          best = { repoPath, relPath: rel };
        }
      }
    }
    return best;
  }, [path, repos]);

  const marker = useMemo(() => {
    if (!ancestor) return "";
    const status = repos[ancestor.repoPath];
    if (!status) return "";
    return pickMarker(status.files[ancestor.relPath]);
  }, [ancestor, repos]);

  useEffect(() => {
    if (!isDir || !isOpen) return;
    if (typeof window === "undefined" || !window.nestbrain) return;
    let cancelled = false;
    window.nestbrain.fs.list(path).then((list) => {
      // Update children in place — React reconciles by entry.path, so
      // unchanged rows don't remount (no flash) and open folders stay open.
      if (!cancelled) setChildren(list);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, path, isDir, refreshKey]);

  const indent = depth * 10;

  // Rename input replaces the button in place (file or folder)
  if (isRenaming) {
    return (
      <RenameInput
        initialValue={name}
        depth={depth}
        isDir={isDir}
        onConfirm={(newName) => onRenameConfirm(path, newName)}
        onCancel={() => onRenameConfirm(path, name)}
      />
    );
  }

  if (!isDir) {
    return (
      <button
        onClick={() => {
          onSelect(path, false);
          // Surface the ancestor repo to the status bar (debounced
          // implicitly via React's batched updates — see status-bar.tsx).
          if (ancestor) {
            window.dispatchEvent(
              new CustomEvent("nestbrain:focus-project", {
                detail: { repoPath: ancestor.repoPath },
              }),
            );
          }
        }}
        onDoubleClick={() => onOpenFile(path)}
        onContextMenu={(e) => onContextMenu(e, path, name, false)}
        className={`w-full text-left flex items-center gap-1.5 px-2 py-1 text-[13px] rounded transition-colors ${
          isSelected
            ? "bg-accent/15 text-foreground"
            : "text-muted/60 hover:text-foreground hover:bg-card"
        }`}
        style={{ paddingLeft: `${indent + 8}px` }}
        title={t.tree.files.fileRowTitle}
      >
        <div className="w-[11px] shrink-0" />
        <FileIcon name={name} size={14} />
        <span className="truncate flex-1 text-left">{name}</span>
        {marker && (
          <span
            className={`text-[10px] font-mono ${markerClass(marker)} shrink-0`}
            title={`git: ${marker}`}
          >
            {marker}
          </span>
        )}
      </button>
    );
  }

  return (
    <div>
      <div
        className={`group w-full flex items-center gap-1.5 px-2 py-1 text-[13px] rounded transition-colors ${
          isSelected
            ? "bg-accent/15 text-foreground"
            : "text-muted hover:text-foreground hover:bg-card"
        }`}
        style={{ paddingLeft: `${indent + 8}px` }}
      >
        <button
          onClick={() => {
            onSelect(path, true);
            onToggle(path);
          }}
          onContextMenu={(e) => onContextMenu(e, path, name, true)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 transition-transform ${
              isOpen ? "rotate-90" : ""
            } text-muted/50`}
          />
          {isOpen ? (
            <FolderOpen size={14} className="shrink-0 text-accent/70" />
          ) : (
            <Folder size={14} className="shrink-0 text-muted/50" />
          )}
          <span className={`truncate ${isRoot ? "font-semibold" : ""} flex-1 text-left`}>
            {name}
          </span>
        </button>
        {/* Terminal is public core (#18) — repo terminal shortcut is not module-gated */}
        {isRepoTop && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void openTerminal(path, name);
            }}
            className="shrink-0 p-0.5 text-accent/40 hover:text-accent transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            title={t.tree.projects.openTerminalTitle(name)}
          >
            <GitBranch size={12} />
          </button>
        )}
      </div>
      {isOpen && children && (
        <div>
          {children.map((entry) => (
            <TreeNode
              key={entry.path}
              path={entry.path}
              name={entry.name}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onRenameConfirm={onRenameConfirm}
              renamingPath={renamingPath}
              selectedPath={selectedPath}
              isDir={entry.isDirectory}
              refreshKey={refreshKey}
            />
          ))}
          {children.length === 0 && (
            <div
              className="text-[11px] text-muted/30 italic py-0.5"
              style={{ paddingLeft: `${(depth + 1) * 10 + 28}px` }}
            >
              {t.tree.files.empty}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
