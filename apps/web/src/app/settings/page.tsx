"use client";

import { useEffect, useState } from "react";
import { Settings as SettingsIcon, Check, Loader2 } from "lucide-react";
import { ProviderAccountSection } from "@/components/provider-account-section";
import { RepositoriesSection } from "@/components/repositories-section";
import { OrchestrationSection } from "@/components/orchestration-section";
import { CliInstallSection } from "@/components/cli-install-section";
import { UpdatesSection } from "@/components/updates-section";
import { LanguageSection } from "@/components/language-section";
import { ModelSelect } from "@/components/model-select";
import { useT } from "@/lib/app-i18n";
import { useAuth } from "@/lib/auth-context";

export default function SettingsPage() {
  const { t } = useT();
  const { providers } = useAuth();
  const [claudeModel, setClaudeModel] = useState("sonnet");
  const [autoExtractAtoms, setAutoExtractAtoms] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load current settings
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        if (data.llm) setClaudeModel(data.llm.claudeModel ?? "sonnet");
        setAutoExtractAtoms(data.autoExtractAtoms ?? true);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // provider is pinned: claude-cli is the only backend that drives the
        // planner and the coder end-to-end. See the LLM section below.
        body: JSON.stringify({
          llm: { provider: "claude-cli", claudeModel },
          autoExtractAtoms,
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      // ignore
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={20} className="text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <SettingsIcon size={20} className="text-muted" />
          <h1 className="text-2xl font-semibold tracking-tight">{t.settings.title}</h1>
        </div>

        <LanguageSection />

        {providers.map((p) => (
          <ProviderAccountSection key={p.id} provider={p} />
        ))}

        <RepositoriesSection />

        {/* Default model — the global default the orchestration roles inherit (#125),
            so it sits above Orchestration where the per-role overrides live. */}
        <section className="mb-10">
          <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4">
            {t.settings.llm.title}
          </h2>

          {/* No provider picker: claude-cli is the only backend whose agent()
              drives the planner, and the coder spawns `claude` regardless of
              this setting. OpenAI parked every planned item in needs-input;
              ollama planned but could never reach a PR. The other providers,
              their API routes and their i18n strings are still in the tree —
              this is a UI-level pin, not a removal. */}

          {/* Claude settings */}
          <div className="space-y-4 p-5 rounded-xl bg-card border border-border">
            <div>
              <label className="block text-xs text-muted/70 mb-2">{t.settings.llm.model}</label>
              <ModelSelect
                value={claudeModel}
                onChange={setClaudeModel}
                className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
              />
            </div>
            <p className="text-[11px] text-muted/40 leading-relaxed">
              {t.settings.llm.claudeAuthBefore}{" "}
              <code className="text-accent/60 bg-accent/5 px-1 rounded">claude auth login</code>{" "}
              {t.settings.llm.claudeAuthAfter}
            </p>
          </div>

        </section>

        <OrchestrationSection defaultModel={claudeModel} />

        <UpdatesSection />

        {/* Knowledge atoms */}
        <section className="mb-10">
          <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4">
            {t.settings.compile.title}
          </h2>
          <div className="p-5 rounded-xl bg-card border border-border space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{t.settings.compile.atomsTitle}</p>
                <p className="text-[11px] text-muted/60 leading-relaxed mt-1">
                  {t.settings.compile.atomsDesc}
                </p>
              </div>
              <button
                onClick={() => setAutoExtractAtoms(!autoExtractAtoms)}
                className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
                  autoExtractAtoms ? "bg-accent" : "bg-border"
                }`}
              >
                <span
                  className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-transform ${
                    autoExtractAtoms ? "left-[22px]" : "left-[3px]"
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        {/* CLI on PATH */}
        <CliInstallSection />

        {/* Save button */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2.5 bg-accent text-background text-sm font-medium rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : saved ? (
              <Check size={14} />
            ) : null}
            {saved ? t.settings.save.saved : t.settings.save.button}
          </button>
          {saved && (
            <span className="text-xs text-green-400/70">
              {t.settings.save.success}
            </span>
          )}
        </div>

      </div>
    </div>
  );
}
