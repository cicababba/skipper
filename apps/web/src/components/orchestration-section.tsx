"use client";

import { Minus, Plus, Workflow } from "lucide-react";
import { DEFAULT_AGENT_RUNTIME, type AgentRuntimeId, type GateMode } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { ModelSelect } from "@/components/model-select";
import { RuntimeSelect } from "@/components/runtime-select";

// Settings → Orchestration (#62): the global defaults for the two gate axes.
// Confidence thresholds stay hand-edit-only, but "auto" on both axes is decided by
// confidence.high — so the copy reads the number out of settings rather than hiding it.
export function OrchestrationSection({ defaultModel }: { defaultModel: string }) {
  const { t } = useT();
  const { state, updateSettings } = useOrchestrator();

  const isElectron = typeof window !== "undefined" && !!window.skipper;
  if (!isElectron || !state) return null;

  const r = t.settings.orchestration;
  const s = state.settings;
  // #125: the per-role globals inherit llm.claudeModel when absent; the picker shows the
  // inherited value for display and a "Use default" clear appears once a role overrides it.
  const inheritModel = defaultModel.trim() || "sonnet";
  const high = s.confidence.high.toFixed(2);
  const selectClass =
    "bg-background border border-border rounded-md px-2 py-1.5 text-sm focus:border-accent focus:outline-none disabled:opacity-50";

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Workflow size={13} className="text-muted/60" />
        {r.title}
      </h2>

      <div className="p-5 rounded-xl bg-card border border-border space-y-5">
        <p className="text-[11px] text-muted/60 leading-relaxed">{r.desc}</p>

        <Row label={r.autoPlanPaused} hint={r.autoPlanPausedDesc}>
          <button
            role="switch"
            aria-checked={s.autoPlanPaused}
            onClick={() => void updateSettings({ autoPlanPaused: !s.autoPlanPaused })}
            className={`relative w-10 h-[22px] rounded-full transition-colors ${
              s.autoPlanPaused ? "bg-accent" : "bg-border"
            }`}
          >
            <span
              className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-transform ${
                s.autoPlanPaused ? "left-[22px]" : "left-[3px]"
              }`}
            />
          </button>
        </Row>

        {/* Stacked: the "auto" labels carry the confidence threshold, so the select
            needs the full card width — inline it would starve the label column. */}
        <Row label={r.autoCoding} hint={r.autoCodingDesc} stack>
          <select
            value={s.autoCoding}
            onChange={(e) => void updateSettings({ autoCoding: e.target.value as GateMode })}
            className={`${selectClass} w-full`}
          >
            <option value="auto">{r.autoCodingAuto(high)}</option>
            <option value="on">{r.on}</option>
            <option value="off">{r.off}</option>
          </select>
        </Row>

        <Row label={r.review} hint={r.reviewDesc} stack>
          <select
            value={s.review}
            onChange={(e) => void updateSettings({ review: e.target.value as GateMode })}
            className={`${selectClass} w-full`}
          >
            <option value="auto">{r.reviewAuto(high)}</option>
            <option value="on">{r.on}</option>
            <option value="off">{r.off}</option>
          </select>
        </Row>

        <Row label={r.ciReentry} hint={r.ciReentryDesc} stack>
          <select
            value={s.ciReentry}
            onChange={(e) =>
              void updateSettings({ ciReentry: e.target.value as "off" | "auto" })
            }
            className={`${selectClass} w-full`}
          >
            <option value="off">{r.off}</option>
            <option value="auto">{r.ciReentryAuto}</option>
          </select>
        </Row>

        <Row
          label={r.reviewMaxRounds}
          hint={s.review === "off" ? r.reviewOffNote : r.reviewMaxRoundsDesc}
        >
          <div className="flex items-center gap-1">
            <button
              onClick={() => void updateSettings({ reviewMaxRounds: s.reviewMaxRounds - 1 })}
              disabled={s.review === "off" || s.reviewMaxRounds <= 1}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Minus size={12} />
            </button>
            <span className="w-8 text-center text-sm font-medium tabular-nums">
              {s.reviewMaxRounds}
            </span>
            <button
              onClick={() => void updateSettings({ reviewMaxRounds: s.reviewMaxRounds + 1 })}
              disabled={s.review === "off" || s.reviewMaxRounds >= 5}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Plus size={12} />
            </button>
          </div>
        </Row>

        <Row label={r.coderTimeBudget} hint={r.coderTimeBudgetDesc}>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void updateSettings({ coderTimeBudgetMin: s.coderTimeBudgetMin - 5 })}
              disabled={s.coderTimeBudgetMin <= 10}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Minus size={12} />
            </button>
            <span className="w-14 text-center text-sm font-medium tabular-nums">
              {r.minutes(s.coderTimeBudgetMin)}
            </span>
            <button
              onClick={() => void updateSettings({ coderTimeBudgetMin: s.coderTimeBudgetMin + 5 })}
              disabled={s.coderTimeBudgetMin >= 240}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Plus size={12} />
            </button>
          </div>
        </Row>

        <Row label={r.plannerTimeBudget} hint={r.plannerTimeBudgetDesc}>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void updateSettings({ plannerTimeBudgetMin: s.plannerTimeBudgetMin - 5 })}
              disabled={s.plannerTimeBudgetMin <= 5}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Minus size={12} />
            </button>
            <span className="w-14 text-center text-sm font-medium tabular-nums">
              {r.minutes(s.plannerTimeBudgetMin)}
            </span>
            <button
              onClick={() => void updateSettings({ plannerTimeBudgetMin: s.plannerTimeBudgetMin + 5 })}
              disabled={s.plannerTimeBudgetMin >= 60}
              className="h-7 w-7 rounded-md border border-border text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-40 flex items-center justify-center"
            >
              <Plus size={12} />
            </button>
          </div>
        </Row>

        <div className="border-t border-border pt-5 space-y-5">
          <div>
            <p className="text-sm font-medium mb-1">{r.models}</p>
            <p className="text-[11px] text-muted/60 leading-relaxed">{r.modelsDesc}</p>
          </div>

          <ModelRow
            label={r.plannerModel}
            hint={r.plannerModelDesc}
            model={s.plannerModel}
            inheritModel={inheritModel}
            selectClass={selectClass}
            defaultLabel={r.modelDefault}
            useDefaultLabel={r.modelUseDefault}
            onChange={(m) => void updateSettings({ plannerModel: m })}
            onClear={() => void updateSettings({ plannerModel: undefined })}
          />
          <ModelRow
            label={r.coderModel}
            hint={r.coderModelDesc}
            model={s.coderModel}
            inheritModel={inheritModel}
            selectClass={selectClass}
            defaultLabel={r.modelDefault}
            useDefaultLabel={r.modelUseDefault}
            onChange={(m) => void updateSettings({ coderModel: m })}
            onClear={() => void updateSettings({ coderModel: undefined })}
          />
          <ModelRow
            label={r.reviewerModel}
            hint={r.reviewerModelDesc}
            model={s.reviewerModel}
            inheritModel={inheritModel}
            selectClass={selectClass}
            defaultLabel={r.modelDefault}
            useDefaultLabel={r.modelUseDefault}
            onChange={(m) => void updateSettings({ reviewerModel: m })}
            onClear={() => void updateSettings({ reviewerModel: undefined })}
          />
        </div>

        <div className="border-t border-border pt-5 space-y-5">
          <div>
            <p className="text-sm font-medium mb-1">{r.runtimes}</p>
            <p className="text-[11px] text-muted/60 leading-relaxed">{r.runtimesDesc}</p>
          </div>

          <RuntimeRow
            label={r.plannerRuntime}
            hint={r.plannerRuntimeDesc}
            runtime={s.plannerRuntime}
            selectClass={selectClass}
            defaultLabel={r.runtimeDefault}
            useDefaultLabel={r.modelUseDefault}
            onChange={(rt) => void updateSettings({ plannerRuntime: rt })}
            onClear={() => void updateSettings({ plannerRuntime: undefined })}
          />
          <RuntimeRow
            label={r.coderRuntime}
            hint={r.coderRuntimeDesc}
            runtime={s.coderRuntime}
            selectClass={selectClass}
            defaultLabel={r.runtimeDefault}
            useDefaultLabel={r.modelUseDefault}
            onChange={(rt) => void updateSettings({ coderRuntime: rt })}
            onClear={() => void updateSettings({ coderRuntime: undefined })}
          />
          <RuntimeRow
            label={r.reviewerRuntime}
            hint={r.reviewerRuntimeDesc}
            runtime={s.reviewerRuntime}
            selectClass={selectClass}
            defaultLabel={r.runtimeDefault}
            useDefaultLabel={r.modelUseDefault}
            onChange={(rt) => void updateSettings({ reviewerRuntime: rt })}
            onClear={() => void updateSettings({ reviewerRuntime: undefined })}
          />
        </div>

        <p className="text-[11px] text-muted/50 leading-relaxed border-t border-border pt-4">
          {r.floorNote(s.confidence.low.toFixed(2))}
        </p>
      </div>
    </section>
  );
}

// One per-role model row: the picker reads the inherited value when the role has no
// override, with a muted "Default model" label; an override swaps it for a "Use default"
// clear. Mirrors the per-repo → global inherit pattern in repo-model-controls.tsx (#125).
function ModelRow({
  label,
  hint,
  model,
  inheritModel,
  selectClass,
  defaultLabel,
  useDefaultLabel,
  onChange,
  onClear,
}: {
  label: string;
  hint: string;
  model: string | undefined;
  inheritModel: string;
  selectClass: string;
  defaultLabel: string;
  useDefaultLabel: string;
  onChange: (model: string) => void;
  onClear: () => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <ModelSelect value={model ?? inheritModel} onChange={onChange} className={selectClass} />
        {model === undefined ? (
          <span className="text-[11px] text-muted/50">{defaultLabel}</span>
        ) : (
          <button onClick={onClear} className="text-[11px] text-accent hover:underline">
            {useDefaultLabel}
          </button>
        )}
      </div>
    </Row>
  );
}

// Per-role runtime row (#240), the ModelRow twin. The inherited value is the
// constant floor, not a setting, so there is no defaultRuntime prop to pass in.
function RuntimeRow({
  label,
  hint,
  runtime,
  selectClass,
  defaultLabel,
  useDefaultLabel,
  onChange,
  onClear,
}: {
  label: string;
  hint: string;
  runtime: AgentRuntimeId | undefined;
  selectClass: string;
  defaultLabel: string;
  useDefaultLabel: string;
  onChange: (runtime: AgentRuntimeId) => void;
  onClear: () => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <RuntimeSelect
          value={runtime ?? DEFAULT_AGENT_RUNTIME}
          onChange={onChange}
          className={selectClass}
        />
        {runtime === undefined ? (
          <span className="text-[11px] text-muted/50">{defaultLabel}</span>
        ) : (
          <button onClick={onClear} className="text-[11px] text-accent hover:underline">
            {useDefaultLabel}
          </button>
        )}
      </div>
    </Row>
  );
}

function Row({
  label,
  hint,
  stack,
  children,
}: {
  label: string;
  hint: string;
  /** Control on its own full-width line — for selects with long option text. */
  stack?: boolean;
  children: React.ReactNode;
}) {
  const text = (
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium mb-1">{label}</p>
      <p className="text-[11px] text-muted/60 leading-relaxed">{hint}</p>
    </div>
  );
  if (stack) {
    return (
      <div>
        {text}
        <div className="mt-2">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-4">
      {text}
      <div className="shrink-0">{children}</div>
    </div>
  );
}
