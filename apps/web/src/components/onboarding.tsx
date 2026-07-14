"use client";

import { useState, useCallback } from "react";
import {
  Sparkles,
  FolderPlus,
  Cpu,
  Trophy,
  ArrowRight,
  Check,
  Loader2,
  FolderOpen,
  Key,
  Eye,
  EyeOff,
} from "lucide-react";
import { useT } from "@/lib/app-i18n";

type Step =
  | "welcome"
  | "directory"
  | "settings"
  | "celebrate";

const MODAL_STEPS: Step[] = ["welcome", "directory", "settings", "celebrate"];
const PROGRESS_STEPS: Step[] = ["welcome", "directory", "settings"];

interface OpenAIModel {
  id: string;
}

export function OnboardingFlow({ onFinish }: { onFinish: () => void }) {
  const { t } = useT();
  const to = t.wiki.onboarding;
  const [step, setStep] = useState<Step>("welcome");
  const [transitioning, setTransitioning] = useState(false);

  // Directory state
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [creatingDir, setCreatingDir] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  // Settings state
  const [provider, setProvider] = useState<"claude-cli" | "openai">("claude-cli");
  const [claudeModel, setClaudeModel] = useState("sonnet");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("gpt-4o");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<OpenAIModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

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
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingCompleted: true }),
      });
    } catch { /* ignore */ }
    next("celebrate");
    setTimeout(() => onFinish(), 3200);
  }

  async function handlePickDirectory() {
    setDirError(null);
    if (!window.skipper) {
      setDirError(to.pickerUnavailable);
      return;
    }
    try {
      const picked = await window.skipper.selectDirectory();
      if (picked) setParentPath(picked);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : to.pickerFailed);
    }
  }

  async function handleCreateSkipper() {
    if (!parentPath || !window.skipper) return;
    setCreatingDir(true);
    setDirError(null);
    try {
      await window.skipper.setupSkipper(parentPath);
      // Give the restarted Next server a moment before moving on
      await new Promise((r) => setTimeout(r, 600));
      next("settings");
    } catch (err) {
      setDirError(err instanceof Error ? err.message : to.createFailed);
    }
    setCreatingDir(false);
  }

  async function loadOpenAIModels() {
    if (!openaiApiKey || openaiApiKey.startsWith("sk-...")) return;
    setModelsLoading(true);
    try {
      const res = await fetch(
        `/api/openai/models?key=${encodeURIComponent(openaiApiKey)}`,
      );
      const data = await res.json();
      if (!data.error && Array.isArray(data.models)) {
        setModels(data.models);
      }
    } catch {
      /* ignore */
    }
    setModelsLoading(false);
  }

  async function handleSaveSettings() {
    setSavingSettings(true);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llm: { provider, claudeModel, openaiApiKey, openaiModel },
        }),
      });
      void finishOnboarding();
    } catch {
      /* ignore */
    }
    setSavingSettings(false);
  }

  const canSaveSettings =
    provider === "claude-cli" ||
    (provider === "openai" && openaiApiKey.length > 10);

  const isModal = MODAL_STEPS.includes(step);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-xl">
      {/* Animated ambient background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-accent/10 blur-3xl animate-pulse-slow" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-purple-500/10 blur-3xl animate-pulse-slow" />
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
            <div className="inline-flex items-center justify-center w-24 h-24 rounded-3xl bg-gradient-to-br from-accent to-purple-500 shadow-2xl shadow-accent/30 animate-float">
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
              onClick={() => next("directory")}
              className="inline-flex items-center gap-2 px-8 py-4 bg-accent text-background font-semibold rounded-2xl hover:bg-accent-hover transition-all hover:scale-105 shadow-xl shadow-accent/20"
            >
              {to.getStarted}
              <ArrowRight size={18} />
            </button>
          </div>
        )}

        {step === "directory" && (
          <div className="space-y-7 animate-fade-in">
            <div className="text-center space-y-3">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-accent to-purple-500 shadow-xl shadow-accent/30">
                <FolderPlus size={28} className="text-white" />
              </div>
              <h2 className="text-3xl font-bold tracking-tight">
                {to.dirTitle}
              </h2>
              <p className="text-muted/80 max-w-md mx-auto">
                {to.dirDescBefore}{" "}
                <code className="text-accent/90 bg-accent/5 px-1.5 py-0.5 rounded text-xs">
                  Skipper/
                </code>{" "}
                {to.dirDescAfter}
              </p>
            </div>

            <div className="p-6 rounded-2xl bg-card border border-border space-y-4">
              <button
                onClick={handlePickDirectory}
                className="w-full p-5 rounded-xl border-2 border-dashed border-border hover:border-accent/50 hover:bg-accent/5 transition-all flex items-center justify-center gap-3 group"
              >
                <FolderOpen
                  size={20}
                  className="text-muted/60 group-hover:text-accent transition-colors"
                />
                <span className="text-sm text-muted/80 group-hover:text-foreground transition-colors">
                  {parentPath ? parentPath : to.browse}
                </span>
              </button>

              {parentPath && (
                <div className="p-4 rounded-xl bg-background/50 border border-border">
                  <p className="text-[11px] text-muted/50 uppercase tracking-wider mb-2">
                    {to.willBeCreated}
                  </p>
                  <p className="text-xs font-mono text-accent break-all">
                    {parentPath}/Skipper
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {["Business", "Context", "Daily", "Library", "Projects", "Skills"].map(
                      (d) => (
                        <span
                          key={d}
                          className="text-[10px] px-2 py-0.5 rounded-md bg-accent/10 text-accent/80 font-mono"
                        >
                          {d}/
                        </span>
                      ),
                    )}
                  </div>
                </div>
              )}

              {dirError && (
                <p className="text-xs text-red-400">{dirError}</p>
              )}
            </div>

            <div className="flex justify-between items-center">
              <button
                onClick={() => next("directory")}
                className="text-sm text-muted/60 hover:text-muted transition-colors"
              >
                {to.back}
              </button>
              <button
                onClick={handleCreateSkipper}
                disabled={!parentPath || creatingDir}
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-accent text-background font-semibold rounded-2xl hover:bg-accent-hover transition-all hover:scale-105 shadow-xl shadow-accent/20 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                {creatingDir ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    {to.creating}
                  </>
                ) : (
                  <>
                    {to.createSkipper}
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {step === "settings" && (
          <div className="space-y-6 animate-fade-in">
            <div className="text-center space-y-3">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-accent to-purple-500 shadow-xl shadow-accent/30">
                <Cpu size={28} className="text-white" />
              </div>
              <h2 className="text-3xl font-bold tracking-tight">
                {to.providerTitle}
              </h2>
              <p className="text-muted/80 max-w-md mx-auto text-sm">
                {to.providerDesc}
              </p>
            </div>

            {/* Provider cards */}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setProvider("claude-cli")}
                className={`p-5 rounded-2xl border-2 text-left transition-all ${
                  provider === "claude-cli"
                    ? "border-accent bg-accent/5 shadow-lg shadow-accent/10"
                    : "border-border hover:border-border hover:bg-card"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold">Claude Pro / Max</span>
                  {provider === "claude-cli" && (
                    <Check size={14} className="text-accent" />
                  )}
                </div>
                <p className="text-[11px] text-muted/60 leading-relaxed">
                  {to.claudeDesc1}<code className="text-accent/70">claude -p</code>{to.claudeDesc2}
                </p>
              </button>

              <button
                onClick={() => setProvider("openai")}
                className={`p-5 rounded-2xl border-2 text-left transition-all ${
                  provider === "openai"
                    ? "border-accent bg-accent/5 shadow-lg shadow-accent/10"
                    : "border-border hover:border-border hover:bg-card"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold">OpenAI</span>
                  {provider === "openai" && (
                    <Check size={14} className="text-accent" />
                  )}
                </div>
                <p className="text-[11px] text-muted/60 leading-relaxed">
                  {to.openaiDesc}
                </p>
              </button>
            </div>

            {/* Model config */}
            <div className="p-5 rounded-2xl bg-card border border-border space-y-4">
              {provider === "claude-cli" ? (
                <div>
                  <label className="block text-[11px] text-muted/70 uppercase tracking-wider mb-2">
                    {to.model}
                  </label>
                  <select
                    value={claudeModel}
                    onChange={(e) => setClaudeModel(e.target.value)}
                    className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                  >
                    <option value="sonnet">Claude Sonnet 4.6</option>
                    <option value="opus">Claude Opus 4.6</option>
                    <option value="haiku">Claude Haiku 4.5</option>
                  </select>
                  <p className="text-[10px] text-muted/40 mt-2">
                    {to.claudeAuth1}{" "}
                    <code className="text-accent/60">claude auth login</code>{" "}
                    {to.claudeAuth2}
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-[11px] text-muted/70 uppercase tracking-wider mb-2">
                      {to.apiKey}
                    </label>
                    <div className="relative">
                      <Key
                        size={14}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted/40"
                      />
                      <input
                        type={showKey ? "text" : "password"}
                        value={openaiApiKey}
                        onChange={(e) => {
                          setOpenaiApiKey(e.target.value);
                          setModels([]);
                        }}
                        onBlur={loadOpenAIModels}
                        placeholder="sk-..."
                        className="w-full pl-9 pr-10 py-2.5 bg-background border border-border rounded-lg text-sm placeholder:text-muted/30 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 font-mono"
                      />
                      <button
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted/40 hover:text-muted"
                      >
                        {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] text-muted/70 uppercase tracking-wider mb-2">
                      {to.model}
                    </label>
                    {modelsLoading ? (
                      <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted">
                        <Loader2 size={12} className="animate-spin" />
                        {to.loading}
                      </div>
                    ) : (
                      <select
                        value={openaiModel}
                        onChange={(e) => setOpenaiModel(e.target.value)}
                        className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                      >
                        {models.length > 0 ? (
                          models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.id}
                            </option>
                          ))
                        ) : (
                          <>
                            <option value="gpt-4o">gpt-4o</option>
                            <option value="gpt-4o-mini">gpt-4o-mini</option>
                            <option value="o4-mini">o4-mini</option>
                          </>
                        )}
                      </select>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-between items-center">
              <button
                onClick={() => next("directory")}
                className="text-sm text-muted/60 hover:text-muted transition-colors"
              >
                {to.back}
              </button>
              <button
                onClick={handleSaveSettings}
                disabled={!canSaveSettings || savingSettings}
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
              <div className="relative inline-flex items-center justify-center w-28 h-28 rounded-full bg-gradient-to-br from-amber-400 via-accent to-purple-500 shadow-2xl shadow-accent/40 animate-trophy">
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
