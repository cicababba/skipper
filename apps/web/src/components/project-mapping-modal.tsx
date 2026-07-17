"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { projectMappingKey } from "@skipper/shared";
import type { Account, RepoSettingsRow, TrackerProjectsResult } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { PROVIDER_ICONS, FALLBACK_PROVIDER_ICON } from "@/components/provider-icons";

// Project→repo mapping editor (#79): per Jira account, list its live projects and
// map each to a repo so its issues can enter the loop. Modeled on
// follow-picker-modal.tsx. "" = not mapped; a change writes via setProjectMapping.
export function ProjectMappingModal({
  account,
  onClose,
}: {
  account: Account;
  onClose: () => void;
}) {
  const { t } = useT();
  const { state } = useOrchestrator();
  const [result, setResult] = useState<TrackerProjectsResult | null>(null);
  const [repos, setRepos] = useState<RepoSettingsRow[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // The orchestrator context replaces its whole state object on every broadcast
  // (each poll tick, each mutation — including our own setProjectMapping saves).
  // Read the current mappings through a ref so load()/save() don't re-run or shift
  // their baseline mid-edit and wipe the user's unsaved selections.
  const mappingsRef = useRef(state?.projectMappings);
  mappingsRef.current = state?.projectMappings;

  const load = useCallback(async () => {
    setResult(null);
    if (!window.skipper) return;
    const [projects, rows] = await Promise.all([
      window.skipper.orchestrator.listTrackerProjects(account.key),
      window.skipper.orchestrator.listRepoSettings(),
    ]);
    setRepos(rows);
    setResult(projects);
    if (projects.ok) {
      const seeded: Record<string, string> = {};
      for (const project of projects.projects) {
        const key = projectMappingKey(projects.source, projects.host, project.key);
        seeded[key] = mappingsRef.current?.[key] ?? "";
      }
      setDraft(seeded);
    }
  }, [account.key]);

  useEffect(() => {
    void load();
  }, [load]);

  // Linked repos first, then alphabetical — the likely targets sit at the top.
  const repoOptions = useMemo(
    () =>
      [...repos].sort((a, b) => {
        if (a.linked !== b.linked) return a.linked ? -1 : 1;
        return a.key.localeCompare(b.key);
      }),
    [repos],
  );

  const unmappedForHost = result?.ok
    ? (state?.unmappedProjects ?? []).filter((u) => u.host === result.host)
    : [];

  const save = async () => {
    if (!window.skipper || !result?.ok) return;
    setSaving(true);
    // Snapshot the baseline once: each setProjectMapping below broadcasts a new
    // state, so reading mappingsRef inside the loop would move the target.
    const baseline = mappingsRef.current ?? {};
    try {
      for (const project of result.projects) {
        const key = projectMappingKey(result.source, result.host, project.key);
        const next = draft[key] ?? "";
        const before = baseline[key] ?? "";
        if (next !== before) {
          await window.skipper.orchestrator.setProjectMapping(key, next || null);
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const m = t.settings.repositories.mapping;
  const Icon = PROVIDER_ICONS[account.provider] || FALLBACK_PROVIDER_ICON;

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] max-w-[90vw] rounded-xl border border-border bg-card shadow-2xl animate-pop-in overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
          <Icon size={15} className="text-accent shrink-0" />
          <h2 className="text-sm font-medium flex-1">{m.title}</h2>
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
              {m.loading}
            </div>
          )}

          {result?.ok === false && (
            <div className="flex items-center gap-3 py-2 text-red-400">
              <span className="flex-1">
                {m.loadFailed} {result.error}
              </span>
              <button
                onClick={() => void load()}
                className="shrink-0 text-foreground underline-offset-2 hover:underline"
              >
                {t.settings.repositories.picker.recheck}
              </button>
            </div>
          )}

          {result?.ok && (
            <>
              <p>{m.desc}</p>

              {unmappedForHost.length > 0 && (
                <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-amber-200/80">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-300" />
                  <span>{m.unmapped(unmappedForHost.length)}</span>
                </div>
              )}

              {result.projects.length === 0 ? (
                <p className="py-3">{m.empty}</p>
              ) : (
                <ul className="mt-3 rounded-md border border-border divide-y divide-border">
                  {result.projects.map((project) => {
                    const key = projectMappingKey(result.source, result.host, project.key);
                    return (
                      <li
                        key={key}
                        className="flex items-center gap-2 px-2.5 py-2"
                      >
                        <span className="text-foreground truncate flex-1 min-w-0">
                          <span className="font-medium">{project.key}</span>
                          <span className="text-muted/70"> — {project.name}</span>
                        </span>
                        <select
                          value={draft[key] ?? ""}
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          className="shrink-0 bg-background border border-border rounded-md px-1.5 py-1 text-[11px] text-foreground focus:outline-none focus:border-accent/60 max-w-[55%]"
                        >
                          <option value="">{m.notMapped}</option>
                          {repoOptions.map((row) => (
                            <option key={row.key} value={row.key}>
                              {row.key}
                            </option>
                          ))}
                        </select>
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
            {m.cancel}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || !result?.ok}
            className="h-7 px-3 rounded-md text-xs font-medium bg-accent text-background hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {m.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
