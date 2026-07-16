"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ExternalLink, Loader2, X } from "lucide-react";
import type { AuthProviderId, FollowCandidatesResult } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { PROVIDER_ICONS, FALLBACK_PROVIDER_ICON } from "@/components/provider-icons";

// Follow-repos picker (#15): shown after an issue-source connect and from the
// Repositories section, scoped to the connecting account. GitHub lists App
// installation repos, GitLab lists membership projects; both merge repos the
// account's poller already saw. Unchecked repos get followed:false (admission
// filter). GitHub also detects the valid-token-but-no-installations case and
// links to the App installation page instead of an inexplicably empty inbox.
export function FollowPickerModal({
  accountId,
  providerId,
  onClose,
}: {
  accountId?: string;
  providerId?: AuthProviderId;
  onClose: () => void;
}) {
  const { t } = useT();
  const [result, setResult] = useState<FollowCandidatesResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setResult(null);
    if (!window.skipper) return;
    const res = await window.skipper.orchestrator.listFollowCandidates(accountId);
    setResult(res);
    if (res.ok) {
      setSelected(
        new Set(
          res.repos
            .filter((r) => r.followed)
            .map((r) => `${r.repo.owner.toLowerCase()}/${r.repo.name.toLowerCase()}`),
        ),
      );
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const keyOf = (r: { repo: { owner: string; name: string } }) =>
    `${r.repo.owner.toLowerCase()}/${r.repo.name.toLowerCase()}`;

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const save = async () => {
    if (!window.skipper || !result?.ok) return;
    setSaving(true);
    try {
      for (const candidate of result.repos) {
        const key = keyOf(candidate);
        const wanted = selected.has(key);
        if (wanted !== candidate.followed) {
          await window.skipper.orchestrator.setRepoSettings(
            candidate.repo.owner,
            candidate.repo.name,
            { followed: wanted ? undefined : false },
          );
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const p = t.settings.repositories.picker;
  const Icon = (providerId && PROVIDER_ICONS[providerId]) || FALLBACK_PROVIDER_ICON;

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] max-w-[90vw] rounded-xl border border-border bg-card shadow-2xl animate-pop-in overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
          <Icon size={15} className="text-accent shrink-0" />
          <h2 className="text-sm font-medium flex-1">{p.title}</h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-muted hover:text-foreground transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-4 py-3 text-xs text-muted max-h-[60vh] overflow-y-auto">
          {result === null && (
            <div className="flex items-center gap-2 py-4">
              <Loader2 size={13} className="animate-spin" />
              {t.settings.repositories.loading}
            </div>
          )}

          {result?.ok === false && (
            <div className="flex items-center gap-3 py-2 text-red-400">
              <span className="flex-1">{p.loadFailed} {result.error}</span>
              <button
                onClick={() => void load()}
                className="shrink-0 text-foreground underline-offset-2 hover:underline"
              >
                {p.recheck}
              </button>
            </div>
          )}

          {result?.ok && (
            <>
              <p>{p.desc}</p>

              {result.installationCount === 0 && (
                <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
                  <p className="flex items-center gap-1.5 font-medium text-amber-300">
                    <AlertTriangle size={12} />
                    {p.noInstallationsTitle}
                  </p>
                  <p className="mt-1 text-amber-200/70">{p.noInstallationsBody}</p>
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={() => result.installUrl && window.skipper?.openExternal(result.installUrl)}
                      className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 transition-colors font-medium"
                    >
                      <ExternalLink size={11} />
                      {p.installApp}
                    </button>
                    <button
                      onClick={() => void load()}
                      className="text-amber-200/70 hover:text-amber-200 underline-offset-2 hover:underline"
                    >
                      {p.recheck}
                    </button>
                  </div>
                </div>
              )}

              {result.repos.length > 0 && (
                <ul className="mt-3 rounded-md border border-border divide-y divide-border">
                  {result.repos.map((candidate) => {
                    const key = keyOf(candidate);
                    return (
                      <li key={key}>
                        <label className="flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-card-hover">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggle(key)}
                            className="accent-[var(--accent)]"
                          />
                          <span className="text-foreground truncate">
                            {candidate.repo.owner}/{candidate.repo.name}
                          </span>
                          {candidate.private && (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border border-border text-muted/70">
                              {p.private}
                            </span>
                          )}
                          {candidate.linked && (
                            <span className="ml-auto shrink-0 text-[10px] text-muted/70">
                              {t.settings.repositories.linked}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          {saving && <Loader2 size={13} className="animate-spin text-muted" />}
          <button
            onClick={onClose}
            disabled={saving}
            className="h-7 px-3 rounded-md text-xs text-muted hover:text-foreground hover:bg-card-hover transition-colors"
          >
            {p.cancel}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || !result?.ok}
            className="h-7 px-3 rounded-md text-xs font-medium bg-accent text-background hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {p.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
