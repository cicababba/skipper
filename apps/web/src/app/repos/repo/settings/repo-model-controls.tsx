"use client";

import type { AgentSelection, RepoIntakeSettings, RepoSettingsRow } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { AgentPairSelect } from "@/components/agent-pair-select";
import { Row, selectClass } from "./settings-row";

/**
 * Per-repo agent overrides (#58) — one (runtime, model) pair per agent role. Its
 * own section rather than a tail of the intake card: three pairs would crowd it.
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
  // has no override the pair shows the resolved global, which is refetched after
  // every patch, so changing just the model stays a one-gesture edit.
  const agentRow = (
    key: "plannerAgent" | "coderAgent" | "reviewerAgent" | "composerAgent",
    resolvedPair: AgentSelection,
    label: string,
  ) => (
    <Row key={key} label={label} busy={false}>
      <AgentPairSelect
        value={row.settings[key] ?? resolvedPair}
        inherited={row.settings[key] === undefined}
        inheritedLabel={rp.wipGlobal}
        claudeFloor={resolvedPair.model ?? ""}
        disabled={busy}
        selectClass={selectClass}
        onChange={(pair) => onPatch({ [key]: pair })}
        onClear={() => onPatch({ [key]: undefined })}
      />
    </Row>
  );

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted/60 leading-relaxed">{o.agentsDesc}</p>
      {agentRow(
        "plannerAgent",
        { runtime: row.resolved.plannerRuntime, model: row.resolved.plannerModel },
        o.planner,
      )}
      {agentRow(
        "coderAgent",
        { runtime: row.resolved.coderRuntime, model: row.resolved.coderModel },
        o.coder,
      )}
      {agentRow(
        "reviewerAgent",
        { runtime: row.resolved.reviewerRuntime, model: row.resolved.reviewerModel },
        o.reviewer,
      )}
      {agentRow(
        "composerAgent",
        { runtime: row.resolved.composerRuntime, model: row.resolved.composerModel },
        o.composer,
      )}
    </div>
  );
}
