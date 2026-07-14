"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderGit2, Loader2, Minus, Plus } from "lucide-react";
import type { AutoPlanMode, RepoIntakeSettings, RepoPriority, RepoSettingsRow } from "@skipper/shared";
import { DEFAULT_AUTO_PLAN_LABEL } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { FollowPickerModal } from "@/components/follow-picker-modal";

// Settings → Repositories section (#15): the global coding WIP limit plus
// per-repo intake config (follow, priority, auto-plan). Mutations apply
// immediately over IPC — the page's Save button only covers app settings.
export function RepositoriesSection() {
  const { t } = useT();
  const { state } = useOrchestrator();
  const [rows, setRows] = useState<RepoSettingsRow[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const isElectron = typeof window !== "undefined" && !!window.skipper;

  const load = useCallback(async () => {
    if (!window.skipper) return;
    setRows(await window.skipper.orchestrator.listRepoSettings());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchRepo = async (row: RepoSettingsRow, patch: Partial<RepoIntakeSettings>) => {
    if (!window.skipper) return;
    setBusyKey(row.key);
    try {
      await window.skipper.orchestrator.setRepoSettings(row.repo.owner, row.repo.name, patch);
      await load();
    } finally {
      setBusyKey(null);
    }
  };

  const setWipLimit = async (value: number) => {
    if (!window.skipper) return;
    await window.skipper.orchestrator.updateSettings({ codingWipPerRepo: value });
  };

  if (!isElectron) return null;

  const r = t.settings.repositories;
  const wipLimit = state?.queue.wipLimitPerRepo ?? 1;

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4 flex items-center gap-2">
        <FolderGit2 size={13} className="text-muted/60" />
        {r.title}
      </h2>

      <div className="p-5 rounded-xl bg-card border border-border space-y-5">
        <p className="text-[11px] text-muted/60 leading-relaxed">{r.desc}</p>

        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium mb-1">{r.wipLimit}</p>
            <p className="text-[11px] text-muted/60 leading-relaxed">{r.wipLimitDesc}</p>
          </div>
          <div className="shrink-0 flex items-center gap-1">
            <button
              onClick={() => void setWipLimit(wipLimit - 1)}
              disabled={wipLimit <= 1}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Minus size={12} />
            </button>
            <span className="w-8 text-center text-sm font-medium tabular-nums">{wipLimit}</span>
            <button
              onClick={() => void setWipLimit(wipLimit + 1)}
              disabled={wipLimit >= 10}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          {rows === null && (
            <div className="flex items-center gap-2 text-xs text-muted py-2">
              <Loader2 size={13} className="animate-spin" />
              {r.loading}
            </div>
          )}

          {rows !== null && rows.length === 0 && (
            <p className="text-xs text-muted py-2">{r.empty}</p>
          )}

          {rows !== null && rows.length > 0 && (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <RepoRow
                  key={row.key}
                  row={row}
                  busy={busyKey === row.key}
                  onPatch={(patch) => void patchRepo(row, patch)}
                />
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted/60">{r.followNote}</p>
            <button
              onClick={() => setPickerOpen(true)}
              className="shrink-0 h-7 px-3 rounded-md text-xs border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors"
            >
              {r.fetchFromGitHub}
            </button>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <FollowPickerModal
          onClose={() => {
            setPickerOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

function RepoRow({
  row,
  busy,
  onPatch,
}: {
  row: RepoSettingsRow;
  busy: boolean;
  onPatch: (patch: Partial<RepoIntakeSettings>) => void;
}) {
  const { t } = useT();
  const r = t.settings.repositories;
  const { resolved } = row;
  const [label, setLabel] = useState(row.settings.autoPlanLabel ?? "");

  const selectClass =
    "bg-background border border-border rounded-md px-1.5 py-1 text-xs focus:border-accent focus:outline-none disabled:opacity-50";

  return (
    <li className="py-2.5 flex items-center gap-3 flex-wrap">
      <div className="flex-1 min-w-[160px]">
        <p className="text-xs font-medium truncate" title={row.localPath}>
          {row.repo.owner}/{row.repo.name}
        </p>
        <p className="text-[10px] text-muted/60">{row.linked ? r.linked : r.notLinked}</p>
      </div>

      {busy && <Loader2 size={12} className="animate-spin text-muted shrink-0" />}

      <label className="flex items-center gap-2 text-[11px] text-muted shrink-0">
        {r.follow}
        <button
          onClick={() => onPatch({ followed: resolved.followed ? false : undefined })}
          disabled={busy}
          className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
            resolved.followed ? "bg-accent" : "bg-border"
          }`}
        >
          <span
            className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-transform ${
              resolved.followed ? "left-[22px]" : "left-[3px]"
            }`}
          />
        </button>
      </label>

      <label className="flex items-center gap-1.5 text-[11px] text-muted shrink-0">
        {r.priority}
        <select
          value={resolved.priority}
          disabled={busy}
          onChange={(e) =>
            onPatch({
              priority:
                e.target.value === "normal" ? undefined : (e.target.value as RepoPriority),
            })
          }
          className={selectClass}
        >
          <option value="high">{r.priorityHigh}</option>
          <option value="normal">{r.priorityNormal}</option>
          <option value="low">{r.priorityLow}</option>
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-[11px] text-muted shrink-0">
        {r.autoPlan}
        <select
          value={resolved.autoPlan}
          disabled={busy}
          onChange={(e) =>
            onPatch({
              autoPlan: e.target.value === "on" ? undefined : (e.target.value as AutoPlanMode),
            })
          }
          className={selectClass}
        >
          <option value="on">{r.autoPlanOn}</option>
          <option value="off">{r.autoPlanOff}</option>
          <option value="label">{r.autoPlanLabel}</option>
        </select>
      </label>

      {resolved.autoPlan === "label" && (
        <input
          type="text"
          value={label}
          placeholder={DEFAULT_AUTO_PLAN_LABEL}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => onPatch({ autoPlanLabel: label.trim() || undefined })}
          className="w-24 bg-background border border-border rounded-md px-1.5 py-1 text-xs focus:border-accent focus:outline-none shrink-0"
        />
      )}
    </li>
  );
}
