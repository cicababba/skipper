"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Lightbulb,
  Settings,
  Sun,
  Moon,
  Inbox,
  ChevronDown,
  Plus,
} from "lucide-react";
import { FileTree } from "./file-tree";
import { RepoManagerModal } from "./repo-manager-modal";
import { BranchIndicator } from "./branch-indicator";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { attentionCounts, repoKey, reposOf } from "@/lib/inbox/model";
import { useT } from "@/lib/app-i18n";
import { useTheme } from "@/lib/theme-context";
import { useStoredState } from "@/lib/use-stored-state";

const navItems = [
  { href: "/knowledge", icon: Lightbulb, key: "knowledge" as const },
  { href: "/settings", icon: Settings, key: "settings" as const },
];

const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const DEFAULT_WIDTH = 256;
const STORAGE_KEY = "nestbrain-sidebar-width";

function clampWidth(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
}

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useT();
  const [storedWidth, setStoredWidth] = useStoredState(STORAGE_KEY, String(DEFAULT_WIDTH));
  // Live value during a drag; storage is only written on mouse-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? clampWidth(storedWidth);
  const isDragging = useRef(false);
  const [nestBrainPath, setNestBrainPath] = useState<string | null>(null);

  // Load NestBrain path (Electron only). Subscribes to onNestBrainMoved
  // so the file tree appears as soon as onboarding completes (and updates
  // when the user moves the workspace from Settings).
  useEffect(() => {
    if (typeof window === "undefined" || !window.nestbrain) return;
    function refetch() {
      window.nestbrain!
        .getBootstrap()
        .then((b) => {
          if (b.nestBrainPath) setNestBrainPath(b.nestBrainPath);
        })
        .catch(() => { /* ignore */ });
    }
    refetch();
    const off = window.nestbrain.onNestBrainMoved?.(() => refetch());
    return off;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    // Coalesce mousemove → one setState per animation frame instead of one
    // per pixel. Without this, fast drags fire 10–20 setState/frame and the
    // sidebar (which feeds three contexts and re-renders the file tree) can
    // visibly judder mid-drag. The pendingWidth ref also persists the last
    // value we computed so the rAF callback always picks up the freshest.
    let pendingWidth = width;
    let rafId: number | null = null;

    function flush() {
      rafId = null;
      setDragWidth(pendingWidth);
    }

    function onMouseMove(e: MouseEvent) {
      if (!isDragging.current) return;
      pendingWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
      if (rafId === null) rafId = requestAnimationFrame(flush);
    }

    function onMouseUp() {
      isDragging.current = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Persist the final width once on mouse-up — saving on every frame
      // wastes a localStorage write per pixel of drag.
      setStoredWidth(String(pendingWidth));
      setDragWidth(null);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [width, setStoredWidth]);

  // Poll knowledge counts so the sidebar shows a badge with the atoms
  // awaiting review (hidden when zero).
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchCounts = async () => {
      try {
        const res = await fetch("/api/knowledge/counts", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setPendingCount(data.pending ?? 0);
      } catch {
        /* ignore — endpoint may not be wired yet */
      }
    };
    void fetchCounts();
    // Long cadence: a 10s poll caused a visible flash whenever the badge
    // re-rendered into existence. The /knowledge page already refreshes
    // its own list when it's mounted; the sidebar badge is just an
    // ambient notification.
    const id = setInterval(fetchCounts, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="relative shrink-0 flex" style={{ width }}>
      <aside className="w-full h-full border-r border-sidebar-border bg-sidebar flex flex-col overflow-hidden">
        {/* Logo — the wrapper is the macOS window-drag region (leaves room for
            the traffic lights); the inner Link opts back into no-drag (see
            globals.css) so clicking it actually navigates Home. */}
        <div className="sidebar-header border-b border-sidebar-border">
          <Link
            href="/"
            title="Home"
            className="block px-5 py-4 hover:bg-card/40 transition-colors cursor-pointer"
          >
            <div className="flex items-baseline gap-2">
              <h1 className="text-lg font-semibold tracking-tight">
                <span className="text-accent">Nest</span>Brain
              </h1>
            </div>
            <p className="text-[11px] text-muted/60 mt-0.5">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>
          </Link>
        </div>

        {/* Inbox (issue #12) — the orchestrator's aggregated queue. Needs
            Suspense because useSearchParams and the sidebar renders on
            every route. */}
        <Suspense fallback={null}>
          <InboxNav />
        </Suspense>

        {/* NestBrain file tree (Electron only, after onboarding) */}
        {nestBrainPath && <FileTree rootPath={nestBrainPath} />}

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-auto">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            const isKnowledge = item.href === "/knowledge";
            const label = t.common.nav[item.key];
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-card-hover text-foreground"
                    : "text-muted hover:text-foreground hover:bg-card"
                }`}
              >
                <Icon size={16} />
                <span className="flex-1">{label}</span>
                {isKnowledge && pendingCount > 0 && (
                  <span
                    className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/15 text-accent"
                    title={`${pendingCount} atom${pendingCount === 1 ? "" : "s"} awaiting review`}
                  >
                    {pendingCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer — the BranchIndicator slot is height-reserved so the
            footer doesn't bob whenever the chip appears or disappears */}
        <div className="h-9 px-4 border-t border-sidebar-border flex items-center gap-2">
          <p className="text-[10px] text-muted/30 shrink-0">NestBrain</p>
          <div className="flex-1 min-w-0 flex justify-center">
            <BranchIndicator />
          </div>
          <ThemeToggle />
        </div>
      </aside>

      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-50 hover:bg-accent/20 active:bg-accent/30 transition-colors"
      />
    </div>
  );
}

const INBOX_COLLAPSE_KEY = "nestbrain-inbox-nav-collapsed";

function AttentionBadge({ count, title }: { count: number; title?: string }) {
  if (count === 0) return null;
  return (
    <span
      className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/15 text-accent"
      title={title}
    >
      {count}
    </span>
  );
}

function InboxNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { state } = useOrchestrator();
  const { t } = useT();
  const [storedCollapsed, setStoredCollapsed] = useStoredState(INBOX_COLLAPSE_KEY, "0");
  const collapsed = storedCollapsed === "1";
  const [reposOpen, setReposOpen] = useState(false);

  if (!state) return null;

  const counts = attentionCounts(state.items);
  const repos = reposOf(state.items);
  const onInbox = pathname === "/inbox" || pathname.startsWith("/inbox/");
  const activeRepo = onInbox ? searchParams.get("repo") : null;

  const toggleCollapsed = () => setStoredCollapsed((cur) => (cur === "1" ? "0" : "1"));

  return (
    <div className="shrink-0 border-b border-sidebar-border p-3 space-y-0.5">
      <div className="flex items-center">
        <Link
          href="/inbox"
          className={`flex-1 min-w-0 flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
            onInbox && !activeRepo
              ? "bg-card-hover text-foreground"
              : "text-muted hover:text-foreground hover:bg-card"
          }`}
        >
          <Inbox size={16} />
          <span className="flex-1 truncate">{t.inbox.all}</span>
          <AttentionBadge count={counts.total} />
        </Link>
        {repos.length > 0 && (
          <button
            onClick={toggleCollapsed}
            className="shrink-0 p-1.5 rounded-md text-muted/40 hover:text-muted hover:bg-card transition-colors"
            aria-expanded={!collapsed}
          >
            <ChevronDown
              size={13}
              className={`transition-transform ${collapsed ? "-rotate-90" : ""}`}
            />
          </button>
        )}
      </div>
      {!collapsed &&
        repos.map((repo) => {
          const key = repoKey(repo);
          const isActive = onInbox && activeRepo === key;
          return (
            <Link
              key={key}
              href={`/inbox?repo=${encodeURIComponent(key)}`}
              title={key}
              className={`w-full flex items-center gap-2 pl-9 pr-3 py-1.5 rounded-lg text-[13px] transition-colors ${
                isActive
                  ? "bg-card-hover text-foreground"
                  : "text-muted hover:text-foreground hover:bg-card"
              }`}
            >
              <span className="flex-1 truncate">{key}</span>
              <AttentionBadge count={counts.byRepo.get(key) ?? 0} />
            </Link>
          );
        })}
      {!collapsed && (
        <button
          onClick={() => setReposOpen(true)}
          className="w-full flex items-center gap-2 pl-9 pr-3 py-1.5 rounded-lg text-[13px] text-muted/60 hover:text-foreground hover:bg-card transition-colors"
        >
          <Plus size={12} className="shrink-0" />
          <span className="flex-1 truncate text-left">{t.inbox.repos.manage}</span>
        </button>
      )}
      <RepoManagerModal isOpen={reposOpen} onClose={() => setReposOpen(false)} />
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const { t } = useT();
  return (
    <button
      onClick={toggle}
      className="p-1.5 rounded-md text-muted/40 hover:text-muted hover:bg-card transition-colors"
      title={theme === "dark" ? t.common.theme.switchToLight : t.common.theme.switchToDark}
    >
      {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
    </button>
  );
}
