"use client";

import { useState } from "react";
import {
  Loader2,
  LogOut,
  Cloud,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useSync } from "@/lib/sync-context";
import { useT, type AppDict } from "@/lib/app-i18n";

// Settings → Sync & Account section.
// Drives the auth flow + the real sync preferences (Phase 2 onward).
export function SyncAccountSection() {
  const { t } = useT();
  const { state: auth, signIn, signOut, cancelSignIn } = useAuth();
  const { state: sync, setPreferences, syncNow, available: syncAvailable } = useSync();

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Cloud size={13} className="text-muted/60" />
        {t.settings.syncAccount.title}
      </h2>

      <div className="p-5 rounded-xl bg-card border border-border space-y-4">
        <div className="space-y-5">
        {auth.status === "unconfigured" && (
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">{t.settings.syncAccount.freeTitle}</p>
              <p className="text-[11px] text-muted/60 leading-relaxed">
                {t.settings.syncAccount.freeDescBefore}{" "}
                <span className="text-accent/80">nestbrain.app</span>
                {t.settings.syncAccount.freeDescMid} <b>{t.settings.syncAccount.freeDescGuide}</b>{" "}
                {t.settings.syncAccount.freeDescAfter}
              </p>
            </div>
            <button
              disabled
              className="shrink-0 flex items-center gap-2 h-9 px-4 rounded-lg border border-border bg-background text-xs font-medium opacity-50 cursor-not-allowed"
            >
              <GoogleMark />
              {t.settings.syncAccount.signInGoogle}
            </button>
          </div>
        )}

        {auth.status === "signed-out" && (
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">{t.settings.syncAccount.signedOutTitle}</p>
              <p className="text-[11px] text-muted/60 leading-relaxed">
                {t.settings.syncAccount.signedOutBefore}{" "}
                <code className="text-accent/70 bg-accent/5 px-1 rounded">NestBrain-Sync</code>{" "}
                {t.settings.syncAccount.signedOutAfter}
              </p>
            </div>
            <button
              onClick={signIn}
              className="shrink-0 flex items-center gap-2 h-9 px-4 rounded-lg border border-border bg-background hover:bg-card-hover text-xs font-medium transition-colors"
            >
              <GoogleMark />
              {t.settings.syncAccount.signInGoogle}
            </button>
          </div>
        )}

        {auth.status === "signing-in" && (
          <div className="flex items-center gap-3 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>{t.settings.syncAccount.waitingBrowser}</span>
            <button
              onClick={cancelSignIn}
              className="ml-auto text-xs text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
            >
              {t.settings.syncAccount.cancel}
            </button>
          </div>
        )}

        {auth.status === "error" && (
          <div className="text-sm text-red-400 flex items-center gap-3">
            <span>{t.settings.syncAccount.signInFailed(auth.error)}</span>
            <button
              onClick={signIn}
              className="ml-auto text-xs text-foreground underline-offset-2 hover:underline"
            >
              {t.settings.syncAccount.retry}
            </button>
          </div>
        )}

        {auth.status === "signed-in" && (
          <>
            <div className="flex items-center gap-3">
              <Avatar user={auth.user} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {auth.user.name ?? auth.user.email}
                </p>
                {auth.user.name && (
                  <p className="text-[11px] text-muted/60 truncate">{auth.user.email}</p>
                )}
              </div>
              <button
                onClick={signOut}
                className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs text-red-400/90 hover:bg-red-500/10 transition-colors"
              >
                <LogOut size={12} />
                {t.settings.syncAccount.signOut}
              </button>
            </div>

            <div className="pt-4 border-t border-border space-y-4">
              <PreferenceToggle
                label={t.settings.syncAccount.enableLabel}
                description={t.settings.syncAccount.enableDesc}
                checked={sync.prefs.enabled}
                onChange={(v) => setPreferences({ enabled: v })}
                disabled={!syncAvailable}
              />
              <PreferenceToggle
                label={t.settings.syncAccount.projectsLabel}
                description={t.settings.syncAccount.projectsDesc}
                checked={sync.prefs.includeProjects}
                onChange={(v) => setPreferences({ includeProjects: v })}
                disabled={!syncAvailable || !sync.prefs.enabled}
              />
              <SyncStatusLine
                status={sync.status}
                lastSyncAt={sync.lastSyncAt}
                error={sync.error}
                currentFile={sync.progress?.currentFile}
                done={sync.progress?.done ?? 0}
                total={sync.progress?.total ?? 0}
                onSyncNow={syncNow}
                disabled={!sync.prefs.enabled}
              />
            </div>
          </>
        )}
        </div>
      </div>
    </section>
  );
}

function SyncStatusLine(props: {
  status: import("@nestbrain/shared").SyncStatus;
  lastSyncAt?: number;
  error?: string;
  currentFile?: string;
  done: number;
  total: number;
  onSyncNow: () => void;
  disabled: boolean;
}) {
  const { t } = useT();
  const { status, lastSyncAt, error, currentFile, done, total, onSyncNow, disabled } = props;

  let body: React.ReactNode;
  if (status === "scanning") {
    body = (
      <span className="flex items-center gap-2">
        <Loader2 size={12} className="animate-spin text-accent" />
        {t.settings.syncAccount.scanning}
      </span>
    );
  } else if (status === "syncing") {
    body = (
      <span className="flex items-center gap-2">
        <Loader2 size={12} className="animate-spin text-accent" />
        {t.settings.syncAccount.syncing(done, total)}<span className="font-mono truncate max-w-[280px]">{currentFile ?? ""}</span>
      </span>
    );
  } else if (status === "error") {
    body = (
      <span className="flex items-center gap-2 text-red-400">
        <AlertCircle size={12} />
        {error ?? t.settings.syncAccount.syncFailed}
      </span>
    );
  } else if (status === "disabled") {
    body = <span className="text-muted/60">{t.settings.syncAccount.syncOff}</span>;
  } else {
    body = lastSyncAt ? (
      <span className="flex items-center gap-2 text-muted/70">
        <CheckCircle2 size={12} className="text-green-500/80" />
        {t.settings.syncAccount.lastSynced(formatRelative(lastSyncAt, t.settings.syncAccount))}
      </span>
    ) : (
      <span className="text-muted/60">{t.settings.syncAccount.idle}</span>
    );
  }

  const busy = status === "scanning" || status === "syncing";
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] pt-2 border-t border-border/50">
      <div className="flex-1 min-w-0">{body}</div>
      <button
        onClick={onSyncNow}
        disabled={disabled || busy}
        className="shrink-0 flex items-center gap-1.5 h-7 px-3 rounded-md border border-border bg-background hover:bg-card-hover text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
        {t.settings.syncAccount.syncNow}
      </button>
    </div>
  );
}

function formatRelative(ms: number, dict: AppDict["settings"]["syncAccount"]): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return dict.justNow;
  if (diff < 3_600_000) return dict.minAgo(Math.floor(diff / 60_000));
  if (diff < 86_400_000) return dict.hoursAgo(Math.floor(diff / 3_600_000));
  return new Date(ms).toLocaleString();
}

function PreferenceToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-muted/60 leading-relaxed mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
          checked ? "bg-accent" : "bg-border"
        } ${disabled ? "cursor-not-allowed" : ""}`}
      >
        <span
          className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "left-[22px]" : "left-[3px]"
          }`}
        />
      </button>
    </div>
  );
}

function Avatar({ user }: { user: { email: string; name?: string; picture?: string } }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (user.picture && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external avatar URL
      <img
        src={user.picture}
        alt=""
        onError={() => setImgFailed(true)}
        className="h-9 w-9 rounded-full"
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials = (user.name ?? user.email).slice(0, 2).toUpperCase();
  return (
    <div className="h-9 w-9 rounded-full bg-accent/20 text-accent flex items-center justify-center text-sm font-medium">
      {initials}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.69-1.56 2.66-3.86 2.66-6.63z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.46-.81 5.94-2.18l-2.9-2.26c-.81.55-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A8.99 8.99 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.73a5.42 5.42 0 0 1 0-3.46V4.94H.96a9 9 0 0 0 0 8.13l3.01-2.34z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.34l2.58-2.58A8.99 8.99 0 0 0 9 0 9 9 0 0 0 .96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );
}
