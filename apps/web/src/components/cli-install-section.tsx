"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Terminal, Trash2 } from "lucide-react";
import { useT } from "@/lib/app-i18n";

interface CliStatus {
  supported: boolean;
  target: string | null;
  source: string;
  installed: boolean;
  stale: boolean;
}

/**
 * Settings section that lets the user install the `skipper` CLI shim on
 * their PATH. Hidden entirely on web (non-Electron) because there's no main
 * process to do the symlink. On macOS the install triggers an admin-password
 * prompt via osascript; on Windows it's user-scoped and silent.
 */
export function CliInstallSection() {
  const { t } = useT();
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined" || !window.skipper?.cli) return;
    try {
      const next = await window.skipper.cli.status();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Not running inside Electron, or platform doesn't support PATH install.
  if (typeof window !== "undefined" && !window.skipper) return null;
  if (status && !status.supported) return null;

  const install = async () => {
    if (!window.skipper?.cli) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.skipper.cli.install();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    if (!window.skipper?.cli) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.skipper.cli.uninstall();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4">
        {t.settings.cli.title}
      </h2>
      <div className="p-5 rounded-xl bg-card border border-border">
        <div className="flex items-start gap-3 mb-4">
          <Terminal size={18} className="text-accent mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {t.settings.cli.installBefore} <code className="px-1 py-0.5 rounded bg-muted/10 font-mono text-[12px]">skipper</code> {t.settings.cli.installAfter}
            </p>
            <p className="text-[11px] text-muted/60 leading-relaxed mt-1">
              {t.settings.cli.descBefore} <code className="font-mono">skipper</code> {t.settings.cli.descAfter}
              {status?.target && (
                <>
                  {" "}{t.settings.cli.installsTo}{" "}
                  <code className="font-mono text-muted/80 break-all">{status.target}</code>.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            {!status ? (
              <span className="text-muted/60">
                <Loader2 size={12} className="inline animate-spin mr-1" />
                {t.settings.cli.checking}
              </span>
            ) : status.installed && !status.stale ? (
              <span className="text-emerald-300 inline-flex items-center gap-1">
                <Check size={13} /> {t.settings.cli.installed}
              </span>
            ) : status.installed && status.stale ? (
              <span className="text-amber-300 inline-flex items-center gap-1">
                <AlertTriangle size={13} /> {t.settings.cli.stale}
              </span>
            ) : (
              <span className="text-muted/60">{t.settings.cli.notInstalled}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {status?.installed && !status.stale && (
              <button
                onClick={uninstall}
                disabled={busy}
                className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
              >
                <Trash2 size={13} /> {t.settings.cli.uninstall}
              </button>
            )}
            <button
              onClick={install}
              disabled={busy || (status?.installed === true && !status.stale)}
              className="px-3 py-1.5 rounded-md text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Terminal size={13} />}
              {status?.installed && status.stale
                ? t.settings.cli.reinstall
                : status?.installed
                  ? t.settings.cli.installed
                  : t.settings.cli.install}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-3 text-[11px] text-red-300 break-words">{error}</p>
        )}
      </div>
    </section>
  );
}
