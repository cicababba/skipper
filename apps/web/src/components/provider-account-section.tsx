"use client";

import { useState } from "react";
import { Loader2, LogOut } from "lucide-react";
import { normalizeBaseUrl } from "@skipper/shared";
import type { AuthProviderMeta } from "@skipper/shared";
import { useAuth } from "@/lib/auth-context";
import { useT } from "@/lib/app-i18n";
import type { ProviderAccountCopy } from "@/lib/i18n/settings";
import { FollowPickerModal } from "@/components/follow-picker-modal";
import { PROVIDER_ICONS, FALLBACK_PROVIDER_ICON } from "@/components/provider-icons";

// Settings → one account card per registered auth provider, driven by the
// registry metadata from the desktop. Issue-source providers get the
// repo-picker affordances (the intake feeds the orchestrator inbox).
export function ProviderAccountSection({ provider }: { provider: AuthProviderMeta }) {
  const { t } = useT();
  const { viewFor, signIn, signInWithPat, signOut, cancelSignIn } = useAuth();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(provider.defaultBaseUrl ?? "");
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
  const Icon = PROVIDER_ICONS[provider.id] ?? FALLBACK_PROVIDER_ICON;

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
        <FollowPickerModal
          accountId={view.account.id}
          providerId={provider.id}
          onClose={() => setPickerOpen(false)}
        />
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
