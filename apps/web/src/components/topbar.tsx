"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LogOut, Settings as SettingsIcon, Loader2, Pause, Play, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";

// Slim top bar that sits above the main content area. The whole strip is a
// macOS window-drag region; interactive elements opt out via `-webkit-app-region: no-drag`.
export function Topbar() {
  return (
    <div
      className="topbar h-10 shrink-0 border-b border-border bg-sidebar/60 backdrop-blur flex items-center justify-end gap-3 px-3"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <AutoPlanChip />
      <OrchestratorChip />
      <AccountWidget />
    </div>
  );
}

// Always-visible pause + queue state (#15): one click pauses/resumes intake.
function OrchestratorChip() {
  const { t } = useT();
  const { state, setIntakePaused } = useOrchestrator();
  const [busy, setBusy] = useState(false);
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  if (!state || Object.keys(state.accounts).length === 0) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      await setIntakePaused(!state.intakePaused);
    } finally {
      setBusy(false);
    }
  };

  if (state.intakePaused) {
    return (
      <button
        onClick={toggle}
        disabled={busy}
        style={noDrag}
        title={t.inbox.intake.resumeTooltip}
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-amber-500/20 bg-amber-500/10 text-amber-300 text-[11px] font-medium hover:bg-amber-500/20 transition-colors"
      >
        <Pause size={11} />
        {t.inbox.intake.paused}
        {state.parkedCount > 0 && ` · ${state.parkedCount} ${t.inbox.intake.queued}`}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      style={noDrag}
      title={t.inbox.intake.pauseTooltip}
      className="flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border bg-card text-muted text-[11px] font-medium hover:bg-card-hover hover:text-foreground transition-colors"
    >
      <Play size={11} />
      {`${state.queue.coding} ${t.inbox.intake.coding} · ${state.queue.queued} ${t.inbox.intake.inQueue}`}
    </button>
  );
}

// Auto-plan master switch (#62), the symmetric twin of the intake chip: intakePaused
// means issues don't enter, autoPlanPaused means they enter but don't get planned.
function AutoPlanChip() {
  const { t } = useT();
  const { state, updateSettings } = useOrchestrator();
  const [busy, setBusy] = useState(false);
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  if (!state || Object.keys(state.accounts).length === 0) return null;

  const paused = state.settings.autoPlanPaused;
  const toggle = async () => {
    setBusy(true);
    try {
      await updateSettings({ autoPlanPaused: !paused });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={busy}
      style={noDrag}
      title={paused ? t.inbox.autoPlan.resumeTooltip : t.inbox.autoPlan.pauseTooltip}
      className={
        paused
          ? "flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-amber-500/20 bg-amber-500/10 text-amber-300 text-[11px] font-medium hover:bg-amber-500/20 transition-colors"
          : "flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border bg-card text-muted text-[11px] font-medium hover:bg-card-hover hover:text-foreground transition-colors"
      }
    >
      <Sparkles size={11} />
      {paused ? t.inbox.autoPlan.paused : t.inbox.autoPlan.on}
    </button>
  );
}

function AccountWidget() {
  const { t } = useT();
  // Google-pinned by design: this widget is the supporter-license surface.
  const { viewFor, signIn, signOut, cancelSignIn } = useAuth();
  const state = viewFor("google");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  if (state.status === "unconfigured") {
    // Source build: sync sign-in would only fail at Google. Disabled + honest.
    return (
      <button
        disabled
        style={noDrag}
        title={t.tree.topbar.syncUnavailableTitle}
        className="flex items-center gap-2 h-7 px-3 rounded-md border border-border bg-card text-xs font-medium opacity-50 cursor-not-allowed"
      >
        <GoogleMark />
        {t.tree.topbar.syncUnavailable}
      </button>
    );
  }

  if (state.status === "signed-out") {
    return (
      <button
        onClick={() => void signIn("google")}
        style={noDrag}
        className="flex items-center gap-2 h-7 px-3 rounded-md border border-border bg-card hover:bg-card-hover text-xs font-medium transition-colors"
      >
        <GoogleMark />
        {t.tree.topbar.signInGoogle}
      </button>
    );
  }

  if (state.status === "signing-in") {
    return (
      <div style={noDrag} className="flex items-center gap-2 h-7 px-3 text-xs text-muted">
        <Loader2 size={13} className="animate-spin" />
        <span>{t.tree.topbar.waitingBrowser}</span>
        <button
          onClick={() => void cancelSignIn("google")}
          className="ml-2 text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
        >
          {t.tree.topbar.cancel}
        </button>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div style={noDrag} className="flex items-center gap-2 h-7 px-3 text-xs text-red-400">
        <span title={state.error}>{t.tree.topbar.signInFailed}</span>
        <button
          onClick={() => void signIn("google")}
          className="ml-1 text-foreground underline-offset-2 hover:underline"
        >
          {t.tree.topbar.retry}
        </button>
      </div>
    );
  }

  // signed-in
  const { account } = state;
  return (
    <div ref={menuRef} className="relative" style={noDrag}>
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-2 h-7 pl-1 pr-2 rounded-md hover:bg-card transition-colors text-xs"
      >
        <Avatar account={account} />
        <span className="text-muted/90 max-w-[180px] truncate">{account.email ?? account.name}</span>
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-9 w-60 rounded-lg border border-border bg-card shadow-lg overflow-hidden z-50">
          <div className="px-3 py-2.5 border-b border-border">
            <div className="text-xs font-medium truncate">{account.name ?? account.email}</div>
            {account.name && account.email && (
              <div className="text-[11px] text-muted/70 truncate">{account.email}</div>
            )}
          </div>
          <Link
            href="/settings"
            onClick={() => setMenuOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-card-hover transition-colors"
          >
            <SettingsIcon size={13} />
            {t.tree.topbar.accountSettings}
          </Link>
          <button
            onClick={async () => { setMenuOpen(false); await signOut("google"); }}
            className="flex items-center gap-2 px-3 py-2 text-xs w-full text-left hover:bg-card-hover transition-colors text-red-400/90"
          >
            <LogOut size={13} />
            {t.tree.topbar.signOut}
          </button>
        </div>
      )}
    </div>
  );
}

function Avatar({ account }: { account: { email?: string; name?: string; avatarUrl?: string } }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (account.avatarUrl && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external avatar; not worth wiring next/image
      <img
        src={account.avatarUrl}
        alt=""
        onError={() => setImgFailed(true)}
        className="h-5 w-5 rounded-full"
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials = (account.name ?? account.email ?? "?").slice(0, 2).toUpperCase();
  return (
    <div className="h-5 w-5 rounded-full bg-accent/20 text-accent flex items-center justify-center text-[10px] font-medium">
      {initials}
    </div>
  );
}

function GoogleMark() {
  // The four-color G, simplified.
  return (
    <svg width="13" height="13" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.69-1.56 2.66-3.86 2.66-6.63z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.46-.81 5.94-2.18l-2.9-2.26c-.81.55-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A8.99 8.99 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.73a5.42 5.42 0 0 1 0-3.46V4.94H.96a9 9 0 0 0 0 8.13l3.01-2.34z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.34l2.58-2.58A8.99 8.99 0 0 0 9 0 9 9 0 0 0 .96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );
}
