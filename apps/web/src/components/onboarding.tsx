"use client";

import { useState, useCallback, useEffect } from "react";
import { Sparkles, Cpu, Trophy, ArrowRight, Loader2 } from "lucide-react";
import {
  AGENT_RUNTIME_IDS,
  DEFAULT_AGENT_RUNTIME,
  type AgentRuntimeId,
  type AgentSelection,
} from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { ModelSelect } from "@/components/model-select";
import { RuntimeSelect } from "@/components/runtime-select";
import { RuntimeAuthHint } from "@/components/runtime-auth-hint";
import { claudeModelMirror, resetModel } from "@/lib/agents/model-options";
import { getRuntimeAvailability } from "@/lib/runtime-availability";
import { updateAppSettings } from "@/lib/app-settings";

type Step =
  | "welcome"
  | "settings"
  | "celebrate";

const MODAL_STEPS: Step[] = ["welcome", "settings", "celebrate"];
const PROGRESS_STEPS: Step[] = ["welcome", "settings"];

const CLAUDE_DEFAULT_MODEL = "sonnet";

export function OnboardingFlow({ onFinish }: { onFinish: () => void }) {
  const { t } = useT();
  const to = t.wiki.onboarding;
  const [step, setStep] = useState<Step>("welcome");
  const [transitioning, setTransitioning] = useState(false);

  // Settings state
  const [pair, setPair] = useState<AgentSelection>({
    runtime: DEFAULT_AGENT_RUNTIME,
    model: CLAUDE_DEFAULT_MODEL,
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Preselect a CLI the user actually has. Claude stays the default when it is
  // installed, when nothing could be probed, and when nothing at all is
  // installed — in that last case RuntimeSelect says so and the step still
  // saves, because onboarding must never dead-end on a missing CLI.
  useEffect(() => {
    void getRuntimeAvailability().then((availability) => {
      if (!availability || availability[DEFAULT_AGENT_RUNTIME]) return;
      const installed = AGENT_RUNTIME_IDS.find((id) => availability[id]);
      if (installed) setPair({ runtime: installed, model: resetModel() });
    });
  }, []);

  const next = useCallback((to: Step) => {
    setTransitioning(true);
    setTimeout(() => {
      setStep(to);
      setTransitioning(false);
    }, 250);
  }, []);

  async function finishOnboarding() {
    // Mark onboardingCompleted in settings
    try {
      await updateAppSettings({ onboardingCompleted: true });
    } catch { /* ignore */ }
    next("celebrate");
    setTimeout(() => onFinish(), 3200);
  }

  async function handleSaveSettings() {
    setSavingSettings(true);
    // llm.provider stays pinned to claude-cli: it is the completions backend the
    // roles fall back to for structured/repair rounds, not the agent that runs
    // them — that one is the pair written to defaultAgent below.
    const mirror = claudeModelMirror(pair);
    try {
      await updateAppSettings({
        llm: { provider: "claude-cli", ...(mirror ? { claudeModel: mirror } : {}) },
      });
      try {
        await window.skipper?.orchestrator.updateSettings({ defaultAgent: pair });
      } catch {
        /* ignore */
      }
      void finishOnboarding();
    } catch {
      /* ignore */
    }
    setSavingSettings(false);
  }

  const isModal = MODAL_STEPS.includes(step);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-xl">
      {/* Animated ambient background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-accent/10 blur-3xl animate-pulse-slow" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-merged/10 blur-3xl animate-pulse-slow" />
      </div>

      <div
        className={`relative w-full max-w-2xl px-8 transition-all duration-300 ${
          transitioning ? "opacity-0 scale-95" : "opacity-100 scale-100"
        }`}
      >
        {/* Progress indicator */}
        {step !== "celebrate" && isModal && (
          <div className="flex items-center justify-center gap-2 mb-10">
            {PROGRESS_STEPS.map((s, i) => {
              const current = PROGRESS_STEPS.indexOf(step);
              const active = i <= current;
              return (
                <div
                  key={s}
                  className={`h-1 rounded-full transition-all duration-500 ${
                    active ? "bg-accent w-10" : "bg-muted/20 w-5"
                  }`}
                />
              );
            })}
          </div>
        )}

        {/* Step content */}
        {step === "welcome" && (
          <div className="text-center space-y-8 animate-fade-in">
            <div className="inline-flex items-center justify-center w-24 h-24 rounded-3xl bg-gradient-to-br from-accent to-merged shadow-2xl shadow-accent/30 animate-float">
              <Sparkles size={44} className="text-white" />
            </div>
            <div className="space-y-3">
              <h1 className="text-5xl font-bold tracking-tight">
                {to.welcomeTitle} <span className="text-accent">Skipper</span>
              </h1>
              <p className="text-lg text-muted/80 max-w-lg mx-auto leading-relaxed">
                {to.welcomeDesc}
              </p>
            </div>
            <button
              onClick={() => next("settings")}
              className="inline-flex items-center gap-2 px-8 py-4 bg-accent text-background font-semibold rounded-2xl hover:bg-accent-hover transition-all hover:scale-105 shadow-xl shadow-accent/20"
            >
              {to.getStarted}
              <ArrowRight size={18} />
            </button>
          </div>
        )}

        {step === "settings" && (
          <div className="space-y-6 animate-fade-in">
            <div className="text-center space-y-3">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-accent to-merged shadow-xl shadow-accent/30">
                <Cpu size={28} className="text-white" />
              </div>
              <h2 className="text-3xl font-bold tracking-tight">
                {to.providerTitle}
              </h2>
              <p className="text-muted/80 max-w-md mx-auto text-sm">
                {to.providerDesc}
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-card border border-border space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-muted/70 uppercase tracking-wider mb-2">
                    {to.runtime}
                  </label>
                  <RuntimeSelect
                    value={pair.runtime}
                    onChange={(runtime: AgentRuntimeId) =>
                      // Claude lists aliases only — no empty option — so it lands
                      // back on the initial default instead of the Custom… input.
                      setPair({
                        runtime,
                        model: runtime === "claude-cli" ? CLAUDE_DEFAULT_MODEL : resetModel(),
                      })
                    }
                    className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-muted/70 uppercase tracking-wider mb-2">
                    {to.model}
                  </label>
                  <ModelSelect
                    value={pair.model ?? ""}
                    runtime={pair.runtime}
                    onChange={(model) => setPair({ runtime: pair.runtime, model: model || undefined })}
                    className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                  />
                </div>
              </div>
              <RuntimeAuthHint runtime={pair.runtime} />
            </div>

            <div className="flex justify-between items-center">
              <button
                onClick={() => next("welcome")}
                className="text-sm text-muted/60 hover:text-muted transition-colors"
              >
                {to.back}
              </button>
              <button
                onClick={handleSaveSettings}
                disabled={savingSettings}
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-accent text-background font-semibold rounded-2xl hover:bg-accent-hover transition-all hover:scale-105 shadow-xl shadow-accent/20 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                {savingSettings ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    {to.saving}
                  </>
                ) : (
                  <>
                    {to.saveContinue}
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {step === "celebrate" && (
          <div className="text-center space-y-8 animate-fade-in">
            {/* Burst animation */}
            <div className="relative inline-flex items-center justify-center">
              <div className="absolute inset-0 animate-burst">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div
                    key={i}
                    className="absolute top-1/2 left-1/2 w-1.5 h-1.5 rounded-full bg-accent"
                    style={{
                      transform: `rotate(${i * 30}deg) translateX(80px)`,
                    }}
                  />
                ))}
              </div>
              <div className="relative inline-flex items-center justify-center w-28 h-28 rounded-full bg-gradient-to-br from-warning via-accent to-merged shadow-2xl shadow-accent/40 animate-trophy">
                <Trophy size={50} className="text-white" />
              </div>
            </div>

            <div className="space-y-3">
              <h1 className="text-4xl font-bold tracking-tight">
                {to.celebrateTitle}
              </h1>
              <p className="text-lg text-muted/80 max-w-md mx-auto leading-relaxed">
                {to.celebrateDesc}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
