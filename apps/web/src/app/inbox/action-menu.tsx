"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, MoreHorizontal } from "lucide-react";
import type { ItemAction } from "@/lib/inbox/actions";
import { actionLabel } from "@/lib/inbox/action-label";
import { useT } from "@/lib/app-i18n";

const MENU_WIDTH = 200;
// Layout constants mirror the rendered classes below (py-1.5 + text-[12px] ≈ 29px per
// entry, my-1 + h-px separator ≈ 9px, py-1 container ≈ 8px). Same trick as the
// file-tree context menu's MENU_H: we need the height *before* the menu is mounted so
// the first paint is already on-screen, rather than measuring and visibly jumping.
const ITEM_HEIGHT = 29;
const SEPARATOR_HEIGHT = 9;
const MENU_PADDING = 8;
const GAP = 6;
const VIEWPORT_MARGIN = 8;

function menuHeight(entryCount: number, hasSeparator: boolean): number {
  return entryCount * ITEM_HEIGHT + (hasSeparator ? SEPARATOR_HEIGHT : 0) + MENU_PADDING;
}

type Entry = { action: ItemAction; danger: boolean };

// Kebab dropdown for every row action (#133, all-in since #193). The busy spinner lives on the
// trigger, not on the entries: selecting one closes the menu in the same commit that
// sets busyId, so a per-item spinner would never be rendered.
export function ActionMenu({
  actions,
  destructive,
  busyId,
  busyInMenu,
  onSelect,
}: {
  actions: ItemAction[];
  destructive: ItemAction[];
  busyId: string | null;
  busyInMenu: boolean;
  onSelect: (action: ItemAction) => void;
}) {
  const { t } = useT();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const entries: Entry[] = [
    ...actions.map((action) => ({ action, danger: false })),
    ...destructive.map((action) => ({ action, danger: true })),
  ];
  const showSeparator = destructive.length > 0 && actions.length > 0;

  // Restore focus to the trigger so keyboard users are not dumped at the top of the
  // document when the portal unmounts.
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // The menu is position:fixed from a rect measured at open time, so any scroll or
    // resize would leave it floating beside an unrelated row while still wired to this
    // item's actions. Closing is safer than repositioning.
    const onDismiss = () => close(false);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [open, close]);

  // Move focus into the portal on open: appended to document.body, its buttons would
  // otherwise sit at the very end of the tab order.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  if (entries.length === 0) return null;

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = menuHeight(entries.length, showSeparator);
    const below = rect.bottom + GAP;
    const fitsBelow = below + height <= window.innerHeight - VIEWPORT_MARGIN;
    const above = rect.top - GAP - height;
    // Flip above the trigger for rows near the bottom of the viewport; a fixed-position
    // menu clipped below the fold cannot be scrolled back into view.
    const top = fitsBelow
      ? below
      : above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    setPosition({
      top,
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
      ),
    });
    setActiveIndex(0);
    setOpen(true);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => (i + delta + entries.length) % entries.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(entries.length - 1);
    } else if (e.key === "Tab") {
      // Nothing after the menu is meaningful; keep focus trapped until dismissal.
      e.preventDefault();
    }
  };

  const select = (action: ItemAction) => {
    close(false);
    // run() may reach the synchronously-blocking window.confirm. A bare setTimeout is a
    // macrotask that browsers routinely run *before* the next paint, so the menu could
    // still be on screen behind the dialog; rAF-then-timeout is the real post-paint hook.
    requestAnimationFrame(() => setTimeout(() => onSelect(action), 0));
  };

  const renderItem = ({ action, danger }: Entry, index: number) => (
    <button
      key={action.id}
      ref={(el) => {
        itemRefs.current[index] = el;
      }}
      role="menuitem"
      tabIndex={index === activeIndex ? 0 : -1}
      disabled={busyId !== null}
      onClick={(e) => {
        e.stopPropagation();
        select(action);
      }}
      onMouseEnter={() => setActiveIndex(index)}
      className={`w-full flex items-center px-3 py-1.5 text-left transition-colors disabled:opacity-50 ${
        danger ? "text-danger/90 hover:bg-danger/10" : "text-foreground hover:bg-accent/10"
      }`}
    >
      {actionLabel(action, t)}
    </button>
  );

  return (
    <>
      <button
        ref={triggerRef}
        aria-label={t.inbox.actions.more}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={busyInMenu}
        disabled={busyId !== null}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else openMenu();
        }}
        className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors disabled:opacity-50 border-border text-muted hover:text-foreground hover:bg-card-hover"
      >
        {busyInMenu ? <Loader2 size={11} className="animate-spin" /> : <MoreHorizontal size={13} />}
      </button>
      {open &&
        position &&
        createPortal(
          <>
            {/* Backdrop swallows the dismissing pointer event. Without it the click that
                closes the menu lands on the row underneath and navigates into the item. */}
            <div
              data-testid="action-menu-backdrop"
              className="fixed inset-0 z-40"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                close(false);
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onMenuKeyDown}
              style={{ top: position.top, left: position.left, width: MENU_WIDTH }}
              className="fixed z-50 rounded-lg border border-border bg-card shadow-xl shadow-black/40 py-1 text-[12px]"
            >
              {entries.slice(0, actions.length).map(renderItem)}
              {showSeparator && <div className="my-1 h-px bg-border/60" />}
              {entries
                .slice(actions.length)
                .map((entry, i) => renderItem(entry, actions.length + i))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
