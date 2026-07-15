"use client";

import { useState } from "react";
import { Loader2, Minus, Plus } from "lucide-react";
import type {
  AutoPlanMode,
  GateMode,
  OrchestratorSettings,
  RepoIntakeSettings,
  RepoPriority,
  RepoSettingsRow,
} from "@skipper/shared";
import { DEFAULT_AUTO_PLAN_LABEL } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

/**
 * Per-repo intake controls (#47) — follow / priority / auto-plan / auto-plan
 * label, plus the WIP-limit override. Lifted out of the Settings monolith so
 * the repo detail page owns per-repo config; Settings keeps only global defaults.
 * Mutations apply immediately over IPC via `onPatch`.
 */
export function RepoIntakeControls({
  row,
  global,
  busy,
  onPatch,
}: {
  row: RepoSettingsRow;
  global: OrchestratorSettings;
  busy: boolean;
  onPatch: (patch: Partial<RepoIntakeSettings>) => void;
}) {
  const { t } = useT();
  const r = t.settings.repositories;
  const rp = t.inbox.repoPage;
  const o = t.settings.orchestration;
  const { resolved } = row;
  const [label, setLabel] = useState(row.settings.autoPlanLabel ?? "");

  const selectClass =
    "bg-background border border-border rounded-md px-2 py-1.5 text-sm focus:border-accent focus:outline-none disabled:opacity-50";

  const override = row.settings.wipLimit;
  const effectiveWip = override ?? global.codingWipPerRepo;
  const effectiveRounds = row.settings.reviewMaxRounds ?? global.reviewMaxRounds;
  const high = global.confidence.high.toFixed(2);

  // The gate overrides bind to row.settings (not row.resolved), so "inherit" and
  // "explicitly set to the global value" stay distinguishable — the wipLimit model.
  const gateRow = (
    key: "autoCoding" | "review",
    label: string,
    hint: string,
    autoLabel: string,
  ) => (
    <Row label={label} busy={false} hint={hint}>
      <div className="flex items-center gap-2">
        <select
          value={row.settings[key] ?? resolved[key]}
          disabled={busy}
          onChange={(e) => onPatch({ [key]: e.target.value as GateMode })}
          className={selectClass}
        >
          <option value="auto">{autoLabel}</option>
          <option value="on">{o.on}</option>
          <option value="off">{o.off}</option>
        </select>
        {row.settings[key] === undefined ? (
          <span className="text-[11px] text-muted/50">{rp.wipGlobal}</span>
        ) : (
          <button
            onClick={() => onPatch({ [key]: undefined })}
            disabled={busy}
            className="text-[11px] text-accent hover:underline disabled:opacity-40"
          >
            {rp.wipClear}
          </button>
        )}
      </div>
    </Row>
  );

  return (
    <div className="space-y-4">
      <Row label={r.follow} busy={busy}>
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
      </Row>

      <Row label={r.priority} busy={false}>
        <select
          value={resolved.priority}
          disabled={busy}
          onChange={(e) =>
            onPatch({
              priority: e.target.value === "normal" ? undefined : (e.target.value as RepoPriority),
            })
          }
          className={selectClass}
        >
          <option value="high">{r.priorityHigh}</option>
          <option value="normal">{r.priorityNormal}</option>
          <option value="low">{r.priorityLow}</option>
        </select>
      </Row>

      <Row label={r.autoPlan} busy={false}>
        <div className="flex items-center gap-2">
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
          {resolved.autoPlan === "label" && (
            <input
              type="text"
              value={label}
              placeholder={DEFAULT_AUTO_PLAN_LABEL}
              disabled={busy}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => onPatch({ autoPlanLabel: label.trim() || undefined })}
              className="w-28 bg-background border border-border rounded-md px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
            />
          )}
        </div>
      </Row>

      {/* WIP override (#47): resolved = override ?? global default. */}
      <Row label={rp.wip} busy={false} hint={rp.wipDesc}>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPatch({ wipLimit: Math.max(1, effectiveWip - 1) })}
              disabled={busy || effectiveWip <= 1}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Minus size={12} />
            </button>
            <span className="w-8 text-center text-sm font-medium tabular-nums">{effectiveWip}</span>
            <button
              onClick={() => onPatch({ wipLimit: Math.min(10, effectiveWip + 1) })}
              disabled={busy || effectiveWip >= 10}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Plus size={12} />
            </button>
          </div>
          {override === undefined ? (
            <span className="text-[11px] text-muted/50">{rp.wipGlobal}</span>
          ) : (
            <button
              onClick={() => onPatch({ wipLimit: undefined })}
              disabled={busy}
              className="text-[11px] text-accent hover:underline disabled:opacity-40"
            >
              {rp.wipClear}
            </button>
          )}
        </div>
      </Row>

      {/* Gate overrides (#62): undefined = inherit the global default. */}
      {gateRow("autoCoding", rp.autoCoding, rp.autoCodingDesc, o.autoCodingAuto(high))}
      {gateRow("review", rp.review, rp.reviewDesc, o.reviewAuto(high))}

      <Row label={rp.reviewMaxRounds} busy={false} hint={rp.reviewMaxRoundsDesc}>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPatch({ reviewMaxRounds: Math.max(1, effectiveRounds - 1) })}
              disabled={busy || resolved.review === "off" || effectiveRounds <= 1}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Minus size={12} />
            </button>
            <span className="w-8 text-center text-sm font-medium tabular-nums">
              {effectiveRounds}
            </span>
            <button
              onClick={() => onPatch({ reviewMaxRounds: Math.min(5, effectiveRounds + 1) })}
              disabled={busy || resolved.review === "off" || effectiveRounds >= 5}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Plus size={12} />
            </button>
          </div>
          {row.settings.reviewMaxRounds === undefined ? (
            <span className="text-[11px] text-muted/50">{rp.wipGlobal}</span>
          ) : (
            <button
              onClick={() => onPatch({ reviewMaxRounds: undefined })}
              disabled={busy}
              className="text-[11px] text-accent hover:underline disabled:opacity-40"
            >
              {rp.wipClear}
            </button>
          )}
        </div>
      </Row>
    </div>
  );
}

function Row({
  label,
  hint,
  busy,
  children,
}: {
  label: string;
  hint?: string;
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium flex items-center gap-2">
          {label}
          {busy && <Loader2 size={12} className="animate-spin text-muted" />}
        </p>
        {hint && <p className="text-[11px] text-muted/60 leading-relaxed mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
