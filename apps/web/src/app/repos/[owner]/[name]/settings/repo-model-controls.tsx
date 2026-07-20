"use client";

import type { RepoIntakeSettings, RepoSettingsRow } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { ModelSelect } from "@/components/model-select";
import { Row, selectClass } from "./settings-row";

/**
 * Per-repo model overrides (#58) — one picker per agent role. Its own section
 * rather than a tail of the intake card: three selects would crowd it.
 * Mutations apply immediately over IPC via `onPatch`.
 */
export function RepoModelControls({
  row,
  busy,
  onPatch,
}: {
  row: RepoSettingsRow;
  busy: boolean;
  onPatch: (patch: Partial<RepoIntakeSettings>) => void;
}) {
  const { t } = useT();
  const rp = t.inbox.repoPage;
  const o = t.settings.orchestration;

  // Binds to row.settings (not row.resolved), so "inherit" and "explicitly set to
  // the resolved value" stay distinguishable — the wipLimit/gate model. When the repo
  // has no override the picker shows row.resolved[key], which now carries the global →
  // llm.claudeModel fallback (#125) and is refetched after every patch.
  const modelRow = (key: "plannerModel" | "coderModel" | "reviewerModel", label: string) => (
    <Row key={key} label={label} busy={false}>
      <div className="flex items-center gap-2">
        <ModelSelect
          value={row.settings[key] ?? row.resolved[key]}
          disabled={busy}
          onChange={(m) => onPatch({ [key]: m })}
          className={selectClass}
        />
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
      <p className="text-[11px] text-muted/60 leading-relaxed">{o.modelsDesc}</p>
      {modelRow("plannerModel", o.plannerModel)}
      {modelRow("coderModel", o.coderModel)}
      {modelRow("reviewerModel", o.reviewerModel)}
    </div>
  );
}
