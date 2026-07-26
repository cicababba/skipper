"use client";

import type { AgentRuntimeId, AgentSelection } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { ModelSelect } from "@/components/model-select";
import { RuntimeSelect } from "@/components/runtime-select";
import { resetModel } from "@/lib/agents/model-options";

/**
 * The (runtime, model) pair as one control: runtime first, model filtered by it.
 * Switching runtime drops the model, so a Claude alias can never end up attached
 * to a Gemini role. The pair is written whole on every change; `inherited` shows
 * the level it comes from instead of a clear affordance.
 */
export function AgentPairSelect({
  value,
  inherited,
  inheritedLabel,
  claudeFloor,
  disabled,
  selectClass,
  onChange,
  onClear,
}: {
  /** The resolved pair — the level's own when set, the inherited one otherwise. */
  value: AgentSelection;
  /** true = this level has no pair of its own and displays the inherited one. */
  inherited: boolean;
  inheritedLabel: string;
  /** The model a claude pair without one of its own resolves to (llm.claudeModel).
   *  Display-only: a pair stored without a model stays without one. */
  claudeFloor: string;
  disabled?: boolean;
  selectClass: string;
  onChange: (next: AgentSelection) => void;
  onClear: () => void;
}) {
  const { t } = useT();
  const r = t.settings.orchestration;
  const runtime = value.runtime;
  const model = value.model ?? (runtime === "claude-cli" ? claudeFloor : "");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <RuntimeSelect
        value={runtime}
        disabled={disabled}
        onChange={(next: AgentRuntimeId) => onChange({ runtime: next, model: resetModel() })}
        className={selectClass}
      />
      <ModelSelect
        value={model}
        runtime={runtime}
        disabled={disabled}
        onChange={(m) => onChange({ runtime, model: m || undefined })}
        className={selectClass}
      />
      {inherited ? (
        <span className="text-[11px] text-muted/50">{inheritedLabel}</span>
      ) : (
        <button
          onClick={onClear}
          disabled={disabled}
          className="text-[11px] text-accent hover:underline disabled:opacity-40"
        >
          {r.agentUseDefault}
        </button>
      )}
    </div>
  );
}
