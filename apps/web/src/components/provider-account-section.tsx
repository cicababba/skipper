"use client";

import { useState } from "react";
import { Github, KeyRound, Loader2, LogOut } from "lucide-react";
import { normalizeBaseUrl } from "@skipper/shared";
import type { AuthProviderId, AuthProviderMeta } from "@skipper/shared";
import { useAuth } from "@/lib/auth-context";
import { useT } from "@/lib/app-i18n";
import type { ProviderAccountCopy } from "@/lib/i18n/settings";
import { FollowPickerModal } from "@/components/follow-picker-modal";

type ProviderIcon = (props: { size?: number; className?: string }) => React.ReactNode;

const ICONS: Partial<Record<AuthProviderId, ProviderIcon>> = {
  google: GoogleMark,
  github: Github,
};

// Settings → one account card per registered auth provider, driven by the
// registry metadata from the desktop. Issue-source providers get the
// repo-picker affordances (the intake feeds the orchestrator inbox).
export function ProviderAccountSection({ provider }: { provider: AuthProviderMeta }) {
  const { t } = useT();
  const { viewFor, signIn, signInWithPat, signOut, cancelSignIn } = useAuth();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [patOpen, setPatOpen] = useState(false);
  const [pat, setPat] = useState("");

  const view = viewFor(provider.id);
  const common = t.settings.account;
  const g = common.generic;
  const copy: ProviderAccountCopy = common.byProvider[provider.id] ?? {
    title: provider.displayName,
    freeTitle: g.freeTitle(provider.displayName),
    freeDesc: g.freeDesc(provider.displayName),
    signIn: g.signIn(provider.displayName),
    signedOutTitle: g.signedOutTitle(provider.displayName),
    signedOutDesc: g.signedOutDesc(provider.displayName),
    signOut: g.signOut,
  };
  const Icon = ICONS[provider.id] ?? KeyRound;

  const baseUrlOptions = provider.requiresBaseUrl ? { baseUrl } : undefined;
  const baseUrlMissing = provider.requiresBaseUrl && normalizeBaseUrl(baseUrl) === null;

  const connect = () =>
    void signIn(provider.id, baseUrlOptions).then(() => {
      if (provider.isIssueSource) setPickerOpen(true);
    });

  const connectWithPat = () =>
    void signInWithPat(provider.id, pat, baseUrlOptions).then(() => {
      setPat("");
      if (provider.isIssueSource) setPickerOpen(true);
    });

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Icon size={13} className="text-muted/60" />
        {copy.title}
      </h2>

      <div className="p-5 rounded-xl bg-card border border-border space-y-5">
        {view.status === "unconfigured" && (
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">{copy.freeTitle}</p>
              <p className="text-[11px] text-muted/60 leading-relaxed">{copy.freeDesc}</p>
            </div>
            <button
              disabled
              className="shrink-0 flex items-center gap-2 h-9 px-4 rounded-lg border border-border bg-background text-xs font-medium opacity-50 cursor-not-allowed"
            >
              <Icon size={14} />
              {copy.signIn}
            </button>
          </div>
        )}

        {view.status === "signed-out" && (
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium mb-1">{copy.signedOutTitle}</p>
                <p className="text-[11px] text-muted/60 leading-relaxed">{copy.signedOutDesc}</p>
              </div>
              <button
                onClick={connect}
                disabled={baseUrlMissing}
                className="shrink-0 flex items-center gap-2 h-9 px-4 rounded-lg border border-border bg-background hover:bg-card-hover text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Icon size={14} />
                {copy.signIn}
              </button>
            </div>
            {provider.requiresBaseUrl && (
              <label className="block">
                <span className="text-[11px] text-muted/60">{common.instanceUrlLabel}</span>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={common.instanceUrlPlaceholder}
                  className="mt-1 w-full h-9 px-3 rounded-lg border border-border bg-background text-xs"
                />
              </label>
            )}
            {provider.supportsPat && !patOpen && (
              <button
                onClick={() => setPatOpen(true)}
                className="text-xs text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
              >
                {common.usePat}
              </button>
            )}
            {provider.supportsPat && patOpen && (
              <div className="flex items-end gap-3">
                <label className="block flex-1 min-w-0">
                  <span className="text-[11px] text-muted/60">{common.patLabel}</span>
                  <input
                    type="password"
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                    className="mt-1 w-full h-9 px-3 rounded-lg border border-border bg-background text-xs"
                  />
                </label>
                <button
                  onClick={connectWithPat}
                  disabled={baseUrlMissing || !pat.trim()}
                  className="shrink-0 h-9 px-4 rounded-lg border border-border bg-background hover:bg-card-hover text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {common.patSignIn}
                </button>
              </div>
            )}
          </div>
        )}

        {view.status === "signing-in" && (
          <div className="flex items-center gap-3 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>{common.waitingBrowser}</span>
            <button
              onClick={() => void cancelSignIn(provider.id)}
              className="ml-auto text-xs text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
            >
              {common.cancel}
            </button>
          </div>
        )}

        {view.status === "error" && (
          <div className="text-sm text-red-400 flex items-center gap-3">
            <span>{common.signInFailed(view.error)}</span>
            <button
              onClick={connect}
              className="ml-auto text-xs text-foreground underline-offset-2 hover:underline"
            >
              {common.retry}
            </button>
          </div>
        )}

        {view.status === "signed-in" && (
          <div className="flex items-center gap-3">
            <Avatar account={view.account} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {view.account.name ?? view.account.email}
              </p>
              {view.account.name && view.account.email && (
                <p className="text-[11px] text-muted/60 truncate">{view.account.email}</p>
              )}
            </div>
            {provider.isIssueSource && (
              <button
                onClick={() => setPickerOpen(true)}
                className="shrink-0 h-8 px-3 rounded-md text-xs border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
              >
                {common.chooseRepos}
              </button>
            )}
            <button
              onClick={() => void signOut(provider.id)}
              className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs text-red-400/90 hover:bg-red-500/10 transition-colors"
            >
              <LogOut size={12} />
              {copy.signOut}
            </button>
          </div>
        )}
      </div>

      {provider.isIssueSource && pickerOpen && view.status === "signed-in" && (
        <FollowPickerModal onClose={() => setPickerOpen(false)} />
      )}
    </section>
  );
}

function Avatar({ account }: { account: { email?: string; name?: string; avatarUrl?: string } }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (account.avatarUrl && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external avatar URL
      <img
        src={account.avatarUrl}
        alt=""
        onError={() => setImgFailed(true)}
        className="h-9 w-9 rounded-full"
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials = (account.name ?? account.email ?? "?").slice(0, 2).toUpperCase();
  return (
    <div className="h-9 w-9 rounded-full bg-accent/20 text-accent flex items-center justify-center text-sm font-medium">
      {initials}
    </div>
  );
}

function GoogleMark({ size = 14 }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.69-1.56 2.66-3.86 2.66-6.63z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.46-.81 5.94-2.18l-2.9-2.26c-.81.55-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A8.99 8.99 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.73a5.42 5.42 0 0 1 0-3.46V4.94H.96a9 9 0 0 0 0 8.13l3.01-2.34z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.34l2.58-2.58A8.99 8.99 0 0 0 9 0 9 9 0 0 0 .96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );
}
