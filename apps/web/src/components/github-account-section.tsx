"use client";

import { useState } from "react";
import { Github, Loader2, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useT } from "@/lib/app-i18n";
import { FollowPickerModal } from "@/components/follow-picker-modal";

// Settings → GitHub section (#15). Feeds the orchestrator: assigned issues on
// the connected account's repos flow into the inbox. After a fresh connect the
// follow-repos picker opens so the user can trim the intake before it fills.
export function GithubAccountSection() {
  const { t } = useT();
  const { github: auth, signInProvider, signOutProvider, cancelSignInProvider } = useAuth();
  const [pickerOpen, setPickerOpen] = useState(false);

  const connect = async () => {
    await signInProvider("github");
  };

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Github size={13} className="text-muted/60" />
        {t.settings.githubAccount.title}
      </h2>

      <div className="p-5 rounded-xl bg-card border border-border space-y-5">
        {auth.status === "unconfigured" && (
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">{t.settings.githubAccount.freeTitle}</p>
              <p className="text-[11px] text-muted/60 leading-relaxed">
                {t.settings.githubAccount.freeDesc}
              </p>
            </div>
            <button
              disabled
              className="shrink-0 flex items-center gap-2 h-9 px-4 rounded-lg border border-border bg-background text-xs font-medium opacity-50 cursor-not-allowed"
            >
              <Github size={14} />
              {t.settings.githubAccount.signIn}
            </button>
          </div>
        )}

        {auth.status === "signed-out" && (
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">{t.settings.githubAccount.signedOutTitle}</p>
              <p className="text-[11px] text-muted/60 leading-relaxed">
                {t.settings.githubAccount.signedOutDesc}
              </p>
            </div>
            <button
              onClick={() => void connect().then(() => setPickerOpen(true))}
              className="shrink-0 flex items-center gap-2 h-9 px-4 rounded-lg border border-border bg-background hover:bg-card-hover text-xs font-medium transition-colors"
            >
              <Github size={14} />
              {t.settings.githubAccount.signIn}
            </button>
          </div>
        )}

        {auth.status === "signing-in" && (
          <div className="flex items-center gap-3 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>{t.settings.githubAccount.waitingBrowser}</span>
            <button
              onClick={() => void cancelSignInProvider("github")}
              className="ml-auto text-xs text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
            >
              {t.settings.githubAccount.cancel}
            </button>
          </div>
        )}

        {auth.status === "error" && (
          <div className="text-sm text-red-400 flex items-center gap-3">
            <span>{t.settings.githubAccount.signInFailed(auth.error)}</span>
            <button
              onClick={() => void connect()}
              className="ml-auto text-xs text-foreground underline-offset-2 hover:underline"
            >
              {t.settings.githubAccount.retry}
            </button>
          </div>
        )}

        {auth.status === "signed-in" && (
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-accent/20 text-accent flex items-center justify-center">
              <Github size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {auth.account.name ?? auth.account.email}
              </p>
              {auth.account.name && auth.account.email && (
                <p className="text-[11px] text-muted/60 truncate">{auth.account.email}</p>
              )}
            </div>
            <button
              onClick={() => setPickerOpen(true)}
              className="shrink-0 h-8 px-3 rounded-md text-xs border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
            >
              {t.settings.githubAccount.chooseRepos}
            </button>
            <button
              onClick={() => void signOutProvider("github")}
              className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs text-red-400/90 hover:bg-red-500/10 transition-colors"
            >
              <LogOut size={12} />
              {t.settings.githubAccount.signOut}
            </button>
          </div>
        )}
      </div>

      {pickerOpen && auth.status === "signed-in" && (
        <FollowPickerModal onClose={() => setPickerOpen(false)} />
      )}
    </section>
  );
}
