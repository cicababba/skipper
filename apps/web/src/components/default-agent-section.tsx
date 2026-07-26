"use client";

import { DEFAULT_AGENT_RUNTIME, type AgentSelection } from "@skipper/shared";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { updateAppSettings } from "@/lib/app-settings";
import { AgentPairSelect } from "@/components/agent-pair-select";

/**
 * Settings → Default agent: the pair every orchestration role inherits, so it
 * sits above Orchestration where the per-role pairs live. Patches land instantly
 * over IPC — it is not part of the page's Save-button flow.
 */
export function DefaultAgentSection({
  claudeFloor,
  onClaudeModelChange,
}: {
  /** llm.claudeModel — the model a claude pair with none of its own falls back to. */
  claudeFloor: string;
  onClaudeModelChange: (model: string) => void;
}) {
  const { t } = useT();
  const { state, updateSettings } = useOrchestrator();
  const r = t.settings.orchestration;

  const stored = state?.settings.defaultAgent;
  const pair: AgentSelection = stored ?? { runtime: DEFAULT_AGENT_RUNTIME, model: claudeFloor };

  function apply(next: AgentSelection) {
    void updateSettings({ defaultAgent: next });
    // Mirror an explicit Claude model onto llm.claudeModel: it stays the floor for
    // every claude pair without a model of its own, and the CLI's knowledge tools
    // read it straight out of settings.json.
    if (next.runtime === "claude-cli" && next.model) {
      onClaudeModelChange(next.model);
      void updateAppSettings({ llm: { claudeModel: next.model } });
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4">
        {t.settings.llm.title}
      </h2>

      {/* No provider picker: the claude-cli runtime is the only completions backend
          the roles fall back to for repair rounds. The OpenAI provider, its API
          routes and its i18n strings are still in the tree — this is a UI-level
          pin, not a removal. */}
      <div className="space-y-4 p-5 rounded-xl bg-card border border-border">
        <div>
          <p className="text-sm font-medium mb-1">{r.agentDefault}</p>
          <p className="text-[11px] text-muted/60 leading-relaxed mb-2">{r.agentDefaultDesc}</p>
          {state && (
            <AgentPairSelect
              value={pair}
              inherited={stored === undefined}
              inheritedLabel={r.agentDefault}
              claudeFloor={claudeFloor}
              selectClass="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent focus:outline-none disabled:opacity-50"
              onChange={apply}
              onClear={() => void updateSettings({ defaultAgent: undefined })}
            />
          )}
        </div>
        <p className="text-[11px] text-muted/40 leading-relaxed">
          {t.settings.llm.claudeAuthBefore}{" "}
          <code className="text-accent/60 bg-accent/5 px-1 rounded">claude auth login</code>{" "}
          {t.settings.llm.claudeAuthAfter}
        </p>
      </div>
    </section>
  );
}
