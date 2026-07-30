"use client";

import { useEffect, useState } from "react";
import type { AgentRuntimeId, RuntimeAvailability } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { getRuntimeAvailability } from "@/lib/runtime-availability";
import { noneInstalled, runtimeOptionsFor } from "@/lib/agents/runtime-options";

// Agent-runtime picker (#240), shared by the global Orchestration section and the
// per-repo override rows. Unlike ModelSelect this is a closed union — an unknown
// id has no runtime behind it — so there is no Custom… escape hatch. The list is
// narrowed to the CLIs actually installed (#287); a saved-but-absent runtime is
// kept and marked rather than dropped.
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
  const [availability, setAvailability] = useState<RuntimeAvailability | null>(null);

  useEffect(() => {
    void getRuntimeAvailability().then(setAvailability);
  }, []);

  const options = runtimeOptionsFor(availability, value);
  const empty = noneInstalled(availability);

  return (
    <>
      <select
        value={value}
        disabled={disabled || empty}
        onChange={(e) => onChange(e.target.value as AgentRuntimeId)}
        className={className}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.installed ? r[opt.labelKey] : r.runtimeNotInstalled(r[opt.labelKey])}
          </option>
        ))}
      </select>
      {empty && <span className="text-[11px] text-muted/50">{r.noRuntimesInstalled}</span>}
    </>
  );
}
