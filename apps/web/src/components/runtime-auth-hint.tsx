"use client";

import { useEffect, useState } from "react";
import type { AgentRuntimeId, RuntimeAvailability } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { getRuntimeAvailability } from "@/lib/runtime-availability";
import { authHintFor } from "@/lib/agents/auth-hints";
import { missingRuntimes } from "@/lib/agents/runtime-options";

// The two lines under an agent picker, shared by Settings → Default agent and
// onboarding: how to authenticate the selected CLI, and — since the picker only
// lists installed CLIs — which other ones Skipper supports. The second line goes
// away once all four are installed.
export function RuntimeAuthHint({ runtime }: { runtime: AgentRuntimeId }) {
  const { t } = useT();
  const r = t.settings.orchestration;
  const [availability, setAvailability] = useState<RuntimeAvailability | null>(null);

  useEffect(() => {
    void getRuntimeAvailability().then(setAvailability);
  }, []);

  const hint = authHintFor(runtime);
  const missing = missingRuntimes(availability);

  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted/40 leading-relaxed">
        {t.settings.llm.authHintBefore(r[hint.runtimeLabelKey])}{" "}
        <code className="text-accent/60 bg-accent/5 px-1 rounded">{hint.command}</code>{" "}
        {t.settings.llm[hint.afterKey]}
      </p>
      {missing.length > 0 && (
        <p className="text-[11px] text-muted/40 leading-relaxed">
          {t.settings.llm.alsoSupports(missing.map((m) => r[m.labelKey]).join(", "))}
        </p>
      )}
    </div>
  );
}
