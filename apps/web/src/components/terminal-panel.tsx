"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTerminal, type TerminalSession } from "@/lib/terminal-context";
import { useStoredState } from "@/lib/use-stored-state";
import { useTheme } from "@/lib/theme-context";
import { ansiPalette, cssVar, type ThemeName } from "@/lib/theme-colors";
import "@xterm/xterm/css/xterm.css";

// Terminal panel (public core — issue #18). One xterm instance per session,
// kept mounted across tab switches and panel toggles so scrollback and
// running processes stay visible when you come back.

const HEIGHT_KEY = "skipper-terminal-height";
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function readXtermTheme(theme: ThemeName) {
  return {
    background: cssVar("--terminal-bg"),
    foreground: cssVar("--foreground"),
    cursor: cssVar("--foreground"),
    selectionBackground: hexToRgba(cssVar("--accent") || "#6C9CFC", 0.35),
    ...ansiPalette(theme),
  };
}

function safeFit(fit: FitAddon, el: HTMLElement): boolean {
  // Zero-size while hidden — fitting then would corrupt the pty size.
  if (el.clientWidth === 0 || el.clientHeight === 0) return false;
  fit.fit();
  return true;
}

function XtermView({ session, visible }: { session: TerminalSession; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    const el = containerRef.current;
    const api = window.skipper?.terminal;
    if (!el || !api) return;

    const styles = getComputedStyle(el);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: styles.fontFamily || "monospace",
      theme: readXtermTheme(themeRef.current),
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    // Defer open() one frame: xterm 5.5.0's Viewport schedules an uncancelled
    // setTimeout(syncScrollArea) in its constructor, which reads dimensions off
    // the (by-then-disposed) renderer and throws on StrictMode's throwaway mount.
    // Opening only after the container has size skips that mount entirely and
    // avoids mis-measuring while display:none.
    let opened = false;
    const openAndFit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      if (!opened) {
        opened = true;
        term.open(el);
      }
      if (safeFit(fit, el)) api.resize(session.id, term.cols, term.rows);
    };
    const initialFit = requestAnimationFrame(openAndFit);

    const offData = api.onData(session.id, (data) => term.write(data));
    const onInput = term.onData((data) => api.write(session.id, data));

    const observer = new ResizeObserver(openAndFit);
    observer.observe(el);

    return () => {
      cancelAnimationFrame(initialFit);
      observer.disconnect();
      offData();
      onInput.dispose();
      term.dispose();
      termRef.current = null;
    };
    // Session identity is stable for the lifetime of the tab.
  }, [session.id]);

  useEffect(() => {
    const el = containerRef.current;
    if (visible && el && fitRef.current) safeFit(fitRef.current, el);
  }, [visible]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readXtermTheme(theme);
  }, [theme]);

  return <div ref={containerRef} className={`h-full w-full font-mono ${visible ? "" : "hidden"}`} />;
}

function clampHeight(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_HEIGHT;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, parsed));
}

export function TerminalPanel() {
  const { sessions, activeId, panelOpen, setActive, closeTerminal, newTerminal } = useTerminal();
  const [storedHeight, setStoredHeight] = useStoredState(HEIGHT_KEY, String(DEFAULT_HEIGHT));
  // Live value during a drag; storage is only written on mouse-up.
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const height = dragHeight ?? clampHeight(storedHeight);
  const dragging = useRef(false);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startY = e.clientY;
      const startHeight = height;
      let pending = startHeight;
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        pending = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + (startY - ev.clientY)));
        setDragHeight(pending);
      };
      const onUp = () => {
        dragging.current = false;
        setStoredHeight(String(pending));
        setDragHeight(null);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [height, setStoredHeight],
  );

  if (sessions.length === 0) return null;

  return (
    <div
      className={`shrink-0 border-t border-border bg-sidebar flex flex-col ${panelOpen ? "" : "hidden"}`}
      style={{ height }}
    >
      <div
        onMouseDown={handleDragStart}
        className="h-1 shrink-0 cursor-row-resize hover:bg-accent/30 transition-colors"
      />
      <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-border/60">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => setActive(s.id)}
            className={`group flex items-center gap-1.5 px-2.5 h-6 rounded text-[11px] cursor-pointer transition-colors ${
              s.id === activeId
                ? "bg-card text-foreground"
                : "text-muted/60 hover:text-foreground hover:bg-card/50"
            }`}
          >
            <span className="truncate max-w-[140px]">{s.label}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTerminal(s.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-muted/50 hover:text-foreground transition-opacity"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          onClick={() => void newTerminal()}
          className="flex items-center justify-center w-6 h-6 rounded text-muted/60 hover:text-foreground hover:bg-card/50 transition-colors"
          title="New terminal"
        >
          <Plus size={12} />
        </button>
      </div>
      <div className="flex-1 min-h-0 px-2 py-1">
        {sessions.map((s) => (
          <XtermView key={s.id} session={s} visible={s.id === activeId} />
        ))}
      </div>
    </div>
  );
}
