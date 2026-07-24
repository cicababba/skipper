"use client";

import { useState } from "react";
import { Loader2, LogOut, Plus } from "lucide-react";
import { deriveProviderView, normalizeBaseUrl } from "@skipper/shared";
import type { Account, AuthProviderMeta } from "@skipper/shared";
import { useAuth } from "@/lib/auth-context";
import { useT } from "@/lib/app-i18n";
import type { ProviderAccountCopy } from "@/lib/i18n/settings";
import { FollowPickerModal } from "@/components/follow-picker-modal";
import { ProjectMappingModal } from "@/components/project-mapping-modal";
import { PROVIDER_ICONS, FALLBACK_PROVIDER_ICON } from "@/components/provider-icons";

type AccountCopy = (typeof import("@/lib/i18n/settings").settings)["en"]["account"];

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

// Settings → one account card per registered auth provider, driven by the
// registry metadata from the desktop. Each connected account gets its own row
// (multi-account, #99); issue-source providers get the repo-picker affordances.
export function ProviderAccountSection({ provider }: { provider: AuthProviderMeta }) {
  const { t } = useT();
  const { accountsFor, signIn, signInWithPat, signOut, cancelSignIn, chooseResource } = useAuth();
  const [pickerAccount, setPickerAccount] = useState<Account | null>(null);
  const [mappingAccount, setMappingAccount] = useState<Account | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(provider.defaultBaseUrl ?? "");
  const [clientId, setClientId] = useState("");
  const [patOpen, setPatOpen] = useState(false);
  const [pat, setPat] = useState("");

  const { accounts, flow } = accountsFor(provider.id);
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

  // OAuth carries the instance URL only for genuinely self-hosted providers;
  // Jira OAuth is fixed-host (its site comes from the picker), but the PAT
  // fallback still needs a Data Center instance URL.
  // OpenProject's OAuth client id is user-supplied (clientIdFromUser) — carry it
  // alongside the instance URL on connect, and gate the OAuth button on it.
  const oauthBaseUrlOptions =
    provider.requiresBaseUrl || provider.clientIdFromUser
      ? {
          ...(provider.requiresBaseUrl ? { baseUrl } : {}),
          ...(provider.clientIdFromUser ? { clientId } : {}),
        }
      : undefined;
  const patNeedsBaseUrl = provider.requiresBaseUrl || !!provider.patRequiresBaseUrl;
  const patBaseUrlOptions = patNeedsBaseUrl ? { baseUrl } : undefined;
  const clientIdMissing = !!provider.clientIdFromUser && clientId.trim() === "";
  const baseUrlMissing =
    (provider.requiresBaseUrl && normalizeBaseUrl(baseUrl) === null) || clientIdMissing;
  const patBaseUrlMissing = patNeedsBaseUrl && normalizeBaseUrl(baseUrl) === null;
  const defaultHost = provider.defaultBaseUrl
    ? hostOf(normalizeBaseUrl(provider.defaultBaseUrl) ?? provider.defaultBaseUrl)
    : undefined;

  const hostSuffix = (a: Account): string | undefined => {
    if (!a.baseUrl) return undefined;
    const host = hostOf(a.baseUrl);
    return host && host !== defaultHost ? host : undefined;
  };

  // The sign-in flow resolves once the account lands; pick the just-added one
  // (most recent) and open its repo picker.
  const openPickerForLatest = async () => {
    if (!provider.isIssueSource || !window.skipper) return;
    const state = await window.skipper.auth.getState();
    const view = deriveProviderView(state, provider.id);
    if (view.status === "signed-in") setPickerAccount(view.account);
  };

  const connect = () =>
    void signIn(provider.id, oauthBaseUrlOptions).then(() => {
      setAddOpen(false);
      void openPickerForLatest();
    });

  const connectWithPat = () =>
    void signInWithPat(provider.id, pat, patBaseUrlOptions).then(() => {
      setPat("");
      setAddOpen(false);
      void openPickerForLatest();
    });

  const onAddClick = () => {
    if (!provider.requiresBaseUrl && !provider.supportsPat) connect();
    else setAddOpen(true);
  };

  const hasAccounts = accounts.length > 0;

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Icon size={13} className="text-muted/60" />
        {copy.title}
      </h2>

      <div className="p-5 rounded-xl bg-card border border-border space-y-5">
        {flow.status === "unconfigured" && (
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

        {flow.status !== "unconfigured" && (
          <>
            {hasAccounts && (
              <ul className="divide-y divide-border">
                {accounts.map((a) => {
                  const secondary = [a.name && a.email ? a.email : undefined, hostSuffix(a)]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li
                      key={a.key}
                      className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                    >
                      <Avatar account={a} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{a.name ?? a.email ?? a.id}</p>
                        {secondary && (
                          <p className="text-[11px] text-muted/60 truncate">{secondary}</p>
                        )}
                      </div>
                      {provider.isIssueSource && !provider.needsProjectMapping && (
                        <button
                          onClick={() => setPickerAccount(a)}
                          className="shrink-0 h-8 px-3 rounded-md text-xs border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
                        >
                          {common.chooseRepos}
                        </button>
                      )}
                      {provider.needsProjectMapping && (
                        <button
                          onClick={() => setMappingAccount(a)}
                          className="shrink-0 h-8 px-3 rounded-md text-xs border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
                        >
                          {common.mapProjects}
                        </button>
                      )}
                      <button
                        onClick={() => void signOut(provider.id, a.key)}
                        className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs text-danger/90 hover:bg-danger/10 transition-colors"
                      >
                        <LogOut size={12} />
                        {copy.signOut}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {flow.status === "signing-in" && (
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

            {flow.status === "choosing-resource" && (
              <div className="space-y-3">
                <p className="text-sm font-medium">{common.chooseSiteTitle}</p>
                <ul className="space-y-2">
                  {flow.candidates.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => void chooseResource(provider.id, c.id)}
                        className="w-full flex items-center gap-3 p-2.5 rounded-lg border border-border bg-background hover:bg-card-hover text-left transition-colors"
                      >
                        <Avatar account={{ name: c.name, avatarUrl: c.avatarUrl }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{c.name}</p>
                          <p className="text-[11px] text-muted/60 truncate">{hostOf(c.url) ?? c.url}</p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => void cancelSignIn(provider.id)}
                  className="text-xs text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
                >
                  {common.cancel}
                </button>
              </div>
            )}

            {flow.status === "error" && (
              <div className="text-sm text-danger flex items-center gap-3">
                <span>{common.signInFailed(flow.error)}</span>
                <button
                  onClick={connect}
                  className="ml-auto text-xs text-foreground underline-offset-2 hover:underline"
                >
                  {common.retry}
                </button>
              </div>
            )}

            {flow.status === "idle" && !hasAccounts && (
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
                <ConnectExtras
                  provider={provider}
                  common={common}
                  baseUrl={baseUrl}
                  setBaseUrl={setBaseUrl}
                  clientId={clientId}
                  setClientId={setClientId}
                  patOpen={patOpen}
                  setPatOpen={setPatOpen}
                  pat={pat}
                  setPat={setPat}
                  patBaseUrlMissing={patBaseUrlMissing}
                  connectWithPat={connectWithPat}
                />
              </div>
            )}

            {flow.status === "idle" && hasAccounts && !addOpen && (
              <button
                onClick={onAddClick}
                className="flex items-center gap-1.5 text-xs text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
              >
                <Plus size={13} />
                {common.addAccount}
              </button>
            )}

            {flow.status === "idle" && hasAccounts && addOpen && (
              <div className="space-y-4 border-t border-border pt-4">
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
                {provider.clientIdFromUser && (
                  <ClientIdField
                    common={common}
                    clientId={clientId}
                    setClientId={setClientId}
                  />
                )}
                <div className="flex items-center gap-3">
                  <button
                    onClick={connect}
                    disabled={baseUrlMissing}
                    className="shrink-0 flex items-center gap-2 h-9 px-4 rounded-lg border border-border bg-background hover:bg-card-hover text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Icon size={14} />
                    {copy.signIn}
                  </button>
                  <button
                    onClick={() => setAddOpen(false)}
                    className="text-xs text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
                  >
                    {common.cancel}
                  </button>
                </div>
                <ConnectExtras
                  provider={provider}
                  common={common}
                  baseUrl={baseUrl}
                  setBaseUrl={setBaseUrl}
                  clientId={clientId}
                  setClientId={setClientId}
                  patOpen={patOpen}
                  setPatOpen={setPatOpen}
                  pat={pat}
                  setPat={setPat}
                  patBaseUrlMissing={patBaseUrlMissing}
                  connectWithPat={connectWithPat}
                  hideBaseUrl
                />
              </div>
            )}
          </>
        )}
      </div>

      {provider.isIssueSource && pickerAccount && (
        <FollowPickerModal
          accountId={pickerAccount.key}
          providerId={provider.id}
          onClose={() => setPickerAccount(null)}
        />
      )}

      {provider.needsProjectMapping && mappingAccount && (
        <ProjectMappingModal account={mappingAccount} onClose={() => setMappingAccount(null)} />
      )}
    </section>
  );
}

// The baseUrl input (signed-out block only) + the PAT fallback link/form —
// shared between the empty-state connect block and the add-account form.
function ConnectExtras({
  provider,
  common,
  baseUrl,
  setBaseUrl,
  clientId,
  setClientId,
  patOpen,
  setPatOpen,
  pat,
  setPat,
  patBaseUrlMissing,
  connectWithPat,
  hideBaseUrl,
}: {
  provider: AuthProviderMeta;
  common: AccountCopy;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  clientId: string;
  setClientId: (v: string) => void;
  patOpen: boolean;
  setPatOpen: (v: boolean) => void;
  pat: string;
  setPat: (v: string) => void;
  patBaseUrlMissing: boolean;
  connectWithPat: () => void;
  hideBaseUrl?: boolean;
}) {
  // Jira OAuth is fixed-host but its PAT (Data Center) needs an instance URL —
  // ask for it inside the PAT form so the OAuth button stays ungated.
  const patNeedsOwnBaseUrl = !!provider.patRequiresBaseUrl && !provider.requiresBaseUrl;
  return (
    <>
      {provider.requiresBaseUrl && !hideBaseUrl && (
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
      {provider.clientIdFromUser && !hideBaseUrl && (
        <ClientIdField common={common} clientId={clientId} setClientId={setClientId} />
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
        <div className="space-y-3">
          {patNeedsOwnBaseUrl && (
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
              disabled={patBaseUrlMissing || !pat.trim()}
              className="shrink-0 h-9 px-4 rounded-lg border border-border bg-background hover:bg-card-hover text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {common.patSignIn}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// User-supplied OAuth Client ID input (clientIdFromUser providers, e.g.
// OpenProject) — the id the user registered on their own instance.
function ClientIdField({
  common,
  clientId,
  setClientId,
}: {
  common: AccountCopy;
  clientId: string;
  setClientId: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted/60">{common.clientIdLabel}</span>
      <input
        type="text"
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        placeholder={common.clientIdPlaceholder}
        className="mt-1 w-full h-9 px-3 rounded-lg border border-border bg-background text-xs"
      />
      <span className="mt-1 block text-[11px] text-muted/50 leading-relaxed">{common.clientIdHelp}</span>
    </label>
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
