"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderGit2, Loader2, X } from "lucide-react";
import type { ListReposResult } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

export function RepoManagerModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useT();
  const [repos, setRepos] = useState<ListReposResult | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!window.skipper) return;
    try {
      setRepos(await window.skipper.orchestrator.listRepos());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setRepos(null);
    setError(null);
    void load();
  }, [isOpen, load]);

  if (!isOpen) return null;

  const splitKey = (key: string): [string, string] => {
    const slash = key.indexOf("/");
    return [key.slice(0, slash), key.slice(slash + 1)];
  };

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusyKey(key);
    setError(null);
    try {
      const result = await fn();
      if (!result.ok && result.error) setError(result.error);
      await load();
    } finally {
      setBusyKey(null);
    }
  };

  const link = (key: string) =>
    run(key, async () => {
      const localPath = await window.skipper!.selectDirectory();
      if (!localPath) return { ok: true };
      const [owner, name] = splitKey(key);
      return window.skipper!.orchestrator.linkRepo(owner, name, localPath);
    });

  const clone = (key: string) =>
    run(key, async () => {
      const destParent = await window.skipper!.selectDirectory();
      if (!destParent) return { ok: true };
      const [owner, name] = splitKey(key);
      return window.skipper!.orchestrator.cloneRepo(owner, name, destParent);
    });

  const unlink = (key: string) =>
    run(key, () => {
      const [owner, name] = splitKey(key);
      return window.skipper!.orchestrator.unlinkRepo(owner, name);
    });

  const actionButton = (label: string, key: string, onClick: () => void, primary = false) => (
    <button
      onClick={onClick}
      disabled={busyKey !== null}
      className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors disabled:opacity-50 whitespace-nowrap ${
        primary
          ? "border-accent/30 bg-accent/10 text-accent hover:bg-accent/20"
          : "border-border text-muted hover:text-foreground hover:bg-card-hover"
      }`}
    >
      {busyKey === key && <Loader2 size={11} className="animate-spin" />}
      {label}
    </button>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && busyKey === null) onClose();
      }}
    >
      <div className="w-[560px] max-w-[92vw] max-h-[82vh] rounded-2xl bg-card border border-border shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
          <FolderGit2 size={16} className="text-accent" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight">{t.inbox.repos.manage}</h2>
            <p className="text-[11px] text-muted">{t.inbox.repos.hint}</p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-muted hover:text-foreground hover:bg-card-hover"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {error && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2 text-[12px] break-all">
              {error}
            </p>
          )}
          {!repos ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : repos.linked.length === 0 && repos.unlinked.length === 0 ? (
            <p className="text-sm text-muted">{t.inbox.repos.none}</p>
          ) : (
            <>
              {repos.unlinked.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-[10px] font-medium uppercase tracking-wide text-amber-300">
                    {t.inbox.repos.unlinked}
                  </h3>
                  <div className="rounded-lg border border-border divide-y divide-border">
                    {repos.unlinked.map(({ key }) => (
                      <div key={key} className="flex items-center gap-2 px-3 py-2">
                        <span className="flex-1 min-w-0 truncate text-sm">{key}</span>
                        {actionButton(t.inbox.repos.link, key, () => void link(key), true)}
                        {actionButton(t.inbox.repos.clone, key, () => void clone(key))}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {repos.linked.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted/70">
                    {t.inbox.repos.linked}
                  </h3>
                  <div className="rounded-lg border border-border divide-y divide-border">
                    {repos.linked.map(({ key, localPath }) => (
                      <div key={key} className="flex items-center gap-2 px-3 py-2">
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm">{key}</p>
                          <p className="truncate text-[11px] text-muted font-mono" title={localPath}>
                            {localPath}
                          </p>
                        </div>
                        {actionButton(t.inbox.repos.unlink, key, () => void unlink(key))}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
