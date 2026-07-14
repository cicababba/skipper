"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTerminal, type TerminalSession } from "@/lib/terminal-context";
import { useStoredState } from "@/lib/use-stored-state";
import "@xterm/xterm/css/xterm.css";

// Terminal panel (public core — issue #18). One xterm instance per session,
// kept mounted across tab switches and panel toggles so scrollback and
// running processes stay visible when you come back.

const HEIGHT_KEY = "nestbrain-terminal-height";
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

function XtermView({ session, visible }: { session: TerminalSession; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    const api = window.nestbrain?.terminal;
    if (!el || !api) return;

    const styles = getComputedStyle(el);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: styles.fontFamily || "monospace",
      theme: {
        background: "#0a0c10",
        foreground: "#d4d8de",
        cursor: "#d4d8de",
        selectionBackground: "#2d4f67",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    api.resize(session.id, term.cols, term.rows);

    const offData = api.onData(session.id, (data) => term.write(data));
    const onInput = term.onData((data) => api.write(session.id, data));

    const observer = new ResizeObserver(() => {
      // Zero-size while hidden — fitting then would corrupt the pty size.
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      api.resize(session.id, term.cols, term.rows);
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      offData();
      onInput.dispose();
      term.dispose();
    };
    // Session identity is stable for the lifetime of the tab.
  }, [session.id]);

  useEffect(() => {
    if (visible) fitRef.current?.fit();
  }, [visible]);

  return <div ref={containerRef} className={`h-full w-full ${visible ? "" : "hidden"}`} />;
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
      className={`shrink-0 border-t border-border bg-[#0a0c10] flex flex-col ${panelOpen ? "" : "hidden"}`}
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
