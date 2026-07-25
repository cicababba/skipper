"use client";

import type { AgentRuntimeId } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

// Agent-runtime picker (#240), shared by the global Orchestration section and the
// per-repo override rows. Unlike ModelSelect this is a closed union — an unknown
// id has no runtime behind it — so there is no Custom… escape hatch.
export function RuntimeSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: AgentRuntimeId;
  onChange: (runtime: AgentRuntimeId) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useT();
  const r = t.settings.orchestration;
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as AgentRuntimeId)}
      className={className}
    >
      <option value="claude-cli">{r.runtimeClaude}</option>
      <option value="codex-cli">{r.runtimeCodex}</option>
    </select>
  );
}
