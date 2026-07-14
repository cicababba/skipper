"use client";

import { useEffect, useState } from "react";
import { Brain, Github, Globe, X } from "lucide-react";
import { useT } from "@/lib/app-i18n";

// Custom About dialog — opened by the macOS "About NestBrain" menu item via
// the nestbrain:show-about IPC. Replaces the cramped native panel.

export function AboutModal() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

  useEffect(() => {
    const mn = typeof window !== "undefined" ? window.nestbrain : undefined;
    if (!mn?.onShowAbout) return;
    return mn.onShowAbout(() => setOpen(true));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const ext = (url: string) => () => void window.nestbrain?.openExternal(url);

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div className="relative w-[min(420px,calc(100vw-32px))] animate-pop-in">
        <div aria-hidden className="absolute -inset-8 rounded-[32px] bg-accent/20 blur-3xl pointer-events-none" />

        <div className="relative rounded-3xl p-[1px] bg-gradient-to-b from-accent/60 via-accent/20 to-transparent">
          <div className="rounded-3xl bg-background border border-border/50 px-8 pt-9 pb-7 text-center overflow-hidden">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-24 h-44 bg-accent/12 blur-3xl" />

            <button
              onClick={() => setOpen(false)}
              className="absolute top-3.5 right-3.5 p-1.5 rounded-lg text-muted/50 hover:text-foreground hover:bg-card transition-colors"
              aria-label={t.about.close}
            >
              <X size={15} />
            </button>

            <div className="relative mx-auto w-16 h-16 rounded-2xl bg-accent/15 border border-accent/30 flex items-center justify-center mb-5">
              <Brain size={30} className="text-accent" />
            </div>

            <h2 className="text-2xl font-bold tracking-tight mb-1">
              <span className="text-accent">Nest</span>Brain
            </h2>
            <p className="text-[13px] text-muted mb-3">{t.about.tagline}</p>

            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] font-mono text-muted mb-6">
              v{version}
            </span>

            <div className="flex items-center justify-center gap-2.5 mb-7">
              <button
                onClick={ext("https://nestbrain.app")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card hover:bg-card-hover px-3 py-1.5 text-[12px] font-medium transition-colors"
              >
                <Globe size={13} className="text-accent" />
                nestbrain.app
              </button>
              <button
                onClick={ext("https://github.com/mikegazzaruso/NestBrain")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card hover:bg-card-hover px-3 py-1.5 text-[12px] font-medium transition-colors"
              >
                <Github size={13} className="text-accent" />
                GitHub
              </button>
            </div>

            <div className="pt-4 border-t border-border/60">
              <p className="text-[11px] text-muted/60 leading-relaxed">
                {t.about.createdBy}
                <br />{t.about.rights}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
