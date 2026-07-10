"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
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
  BookOpen,
  Network,
  Search as SearchIcon,
  Download,
  Zap,
  X,
  Cloud,
  Laptop,
  Shield,
  Folders,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useSync } from "@/lib/sync-context";
import { useT } from "@/lib/app-i18n";

type Step =
  | "welcome"
  | "explain"
  | "directory"
  | "settings"
  | "sync"
  | "firstIngest"
  | "compileGuide"
  | "celebrate";

const MODAL_STEPS: Step[] = ["welcome", "explain", "directory", "settings", "sync", "celebrate"];
const PROGRESS_STEPS: Step[] = ["welcome", "explain", "directory", "settings", "sync"];

interface OpenAIModel {
  id: string;
}

export function OnboardingFlow({ onFinish }: { onFinish: () => void }) {
  const { t } = useT();
  const to = t.wiki.onboarding;
  const [step, setStep] = useState<Step>("welcome");
  const [transitioning, setTransitioning] = useState(false);
  const router = useRouter();

  // Directory state
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [nestBrainPath, setNestBrainPath] = useState<string | null>(null);
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

  // Tour state (firstIngest + compileGuide)
  const [ingestCount, setIngestCount] = useState(0);
  const initialIngestCount = useRef<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const next = useCallback((to: Step) => {
    setTransitioning(true);
    setTimeout(() => {
      setStep(to);
      setTransitioning(false);
    }, 250);
  }, []);

  // Poll for state transitions during the coach-mode steps
  useEffect(() => {
    function clearPoll() {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }

    if (step === "firstIngest") {
      router.push("/ingest");
      // Snapshot current count and poll for an increase
      (async () => {
        try {
          const res = await fetch("/api/ingest");
          const data = await res.json();
          initialIngestCount.current = (data.sources ?? []).length;
          setIngestCount(initialIngestCount.current ?? 0);
        } catch { /* ignore */ }
      })();
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch("/api/ingest");
          const data = await res.json();
          const count = (data.sources ?? []).length;
          setIngestCount(count);
          if (
            initialIngestCount.current !== null &&
            count > initialIngestCount.current
          ) {
            clearPoll();
            next("compileGuide");
          }
        } catch { /* ignore */ }
      }, 1500);
    } else if (step === "compileGuide") {
      // Poll for either: (a) autoCompile enabled, or (b) a compile started
      pollRef.current = setInterval(async () => {
        try {
          const [sRes, cRes] = await Promise.all([
            fetch("/api/settings"),
            fetch("/api/compile/status"),
          ]);
          const s = await sRes.json();
          const c = await cRes.json();
          if (s.autoCompile === true || c.status === "compiling" || c.status === "success") {
            clearPoll();
            finishOnboarding();
          }
        } catch { /* ignore */ }
      }, 1000);
    }

    return clearPoll;
  }, [step, next, router]);

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
    if (!window.nestbrain) {
      setDirError(to.pickerUnavailable);
      return;
    }
    try {
      const picked = await window.nestbrain.selectDirectory();
      if (picked) setParentPath(picked);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : to.pickerFailed);
    }
  }

  async function handleCreateNestBrain() {
    if (!parentPath || !window.nestbrain) return;
    setCreatingDir(true);
    setDirError(null);
    try {
      const result = await window.nestbrain.setupNestBrain(parentPath);
      setNestBrainPath(result.nestBrainPath);
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
      next("sync");
    } catch {
      /* ignore */
    }
    setSavingSettings(false);
  }

  const canSaveSettings =
    provider === "claude-cli" ||
    (provider === "openai" && openaiApiKey.length > 10);

  const isCoachMode = step === "firstIngest" || step === "compileGuide";
  const isModal = MODAL_STEPS.includes(step);

  // Coach mode: small floating card so the user can interact with the real UI
  if (isCoachMode) {
    return <CoachCard step={step} ingestCount={ingestCount} initialCount={initialIngestCount.current ?? 0} onSkip={finishOnboarding} />;
  }

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
                {to.welcomeTitle} <span className="text-accent">NestBrain</span>
              </h1>
              <p className="text-lg text-muted/80 max-w-lg mx-auto leading-relaxed">
                {to.welcomeDesc}
              </p>
            </div>
            <button
              onClick={() => next("explain")}
              className="inline-flex items-center gap-2 px-8 py-4 bg-accent text-background font-semibold rounded-2xl hover:bg-accent-hover transition-all hover:scale-105 shadow-xl shadow-accent/20"
            >
              {to.getStarted}
              <ArrowRight size={18} />
            </button>
          </div>
        )}

        {step === "explain" && (
          <div className="space-y-8 animate-fade-in">
            <div className="text-center space-y-3">
              <h2 className="text-3xl font-bold tracking-tight">
                {to.explainTitle}
              </h2>
              <p className="text-muted/80 max-w-lg mx-auto">
                {to.explainDesc}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {[
                { icon: BookOpen, label: "Wiki", desc: to.featureWikiDesc },
                { icon: Network, label: "Mind Map", desc: to.featureMapDesc },
                { icon: SearchIcon, label: to.featureQaTitle, desc: to.featureQaDesc },
              ].map(({ icon: Icon, label, desc }) => (
                <div
                  key={label}
                  className="p-5 rounded-2xl bg-card border border-border text-center"
                >
                  <Icon size={22} className="text-accent mx-auto mb-2" />
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-[11px] text-muted/60 mt-0.5">{desc}</p>
                </div>
              ))}
            </div>

            <div className="p-5 rounded-2xl bg-gradient-to-br from-accent/5 to-purple-500/5 border border-accent/20">
              <p className="text-sm text-muted/80 leading-relaxed">
                <span className="text-foreground font-medium">NestBrain</span>
                {to.explainHome}
              </p>
            </div>

            <div className="flex justify-center">
              <button
                onClick={() => next("directory")}
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-accent text-background font-semibold rounded-2xl hover:bg-accent-hover transition-all hover:scale-105 shadow-xl shadow-accent/20"
              >
                {to.continue}
                <ArrowRight size={18} />
              </button>
            </div>
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
                  NestBrain/
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
                    {parentPath}/NestBrain
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
                onClick={() => next("explain")}
                className="text-sm text-muted/60 hover:text-muted transition-colors"
              >
                {to.back}
              </button>
              <button
                onClick={handleCreateNestBrain}
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
                    {to.createNestBrain}
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

        {step === "sync" && (
          <SyncStep
            onContinue={() => next("firstIngest")}
          />
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

// Onboarding step that introduces Sync and offers Google sign-in.
// Login is optional here — the user can always sign in later from Settings —
// but we make clear that Sync is gated on being signed in.
function SyncStep({ onContinue }: { onContinue: () => void }) {
  const { t } = useT();
  const to = t.wiki.onboarding;
  const { state, signIn, signOut, cancelSignIn } = useAuth();
  const { state: sync, setPreferences } = useSync();
  const enabled = sync.prefs.enabled;
  const includeProjects = sync.prefs.includeProjects;
  // When the user lands here freshly signed in, default enabled = true so the
  // first cycle kicks off automatically once they hit Continue. They can flip
  // it off here or later from Settings.
  useEffect(() => {
    if (state.status === "signed-in" && !sync.prefs.enabled) {
      setPreferences({ enabled: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  return (
    <div className="space-y-7 animate-fade-in">
      <div className="text-center space-y-3">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-400 to-accent shadow-xl shadow-accent/30">
          <Cloud size={28} className="text-white" />
        </div>
        <h2 className="text-3xl font-bold tracking-tight">
          {to.syncTitle}
        </h2>
        <p className="text-muted/80 max-w-md mx-auto text-sm leading-relaxed">
          {to.syncDesc}{" "}
          <span className="text-foreground/70">
            {to.syncOptional}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          {
            icon: Laptop,
            title: to.syncDeviceTitle,
            desc: to.syncDeviceDesc,
          },
          {
            icon: Shield,
            title: to.syncUnionTitle,
            desc: to.syncUnionDesc,
          },
          {
            icon: Folders,
            title: to.syncProjectsTitle,
            desc: to.syncProjectsDesc,
          },
        ].map(({ icon: Icon, title, desc }) => (
          <div
            key={title}
            className="p-4 rounded-2xl bg-card border border-border"
          >
            <Icon size={18} className="text-accent mb-2" />
            <p className="text-xs font-semibold mb-1">{title}</p>
            <p className="text-[10px] text-muted/60 leading-relaxed">{desc}</p>
          </div>
        ))}
      </div>

      <div className="p-5 rounded-2xl bg-card border border-border">
        {state.status === "signed-out" && (
          <div className="flex flex-col items-center gap-3 py-2">
            <button
              onClick={signIn}
              className="inline-flex items-center gap-2.5 h-10 px-5 rounded-xl border border-border bg-background hover:bg-card-hover text-sm font-medium transition-colors"
            >
              <GoogleMark />
              {to.signInGoogle}
            </button>
            <p className="text-[11px] text-muted/50 text-center max-w-sm leading-relaxed">
              {to.drivePrivacy1}{" "}
              <code className="text-accent/70 bg-accent/5 px-1 rounded">NestBrain-Sync</code>{" "}
              {to.drivePrivacy2}
            </p>
          </div>
        )}

        {state.status === "signing-in" && (
          <div className="flex items-center justify-center gap-3 py-4 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>{to.waitingSignIn}</span>
            <button
              onClick={cancelSignIn}
              className="ml-2 text-xs text-muted/70 hover:text-foreground underline-offset-2 hover:underline"
            >
              {to.cancel}
            </button>
          </div>
        )}

        {state.status === "error" && (
          <div className="flex items-center gap-3 py-3 text-sm">
            <span className="text-red-400 flex-1">{to.signInFailed(state.error)}</span>
            <button
              onClick={signIn}
              className="text-xs text-foreground underline-offset-2 hover:underline"
            >
              {to.retry}
            </button>
          </div>
        )}

        {state.status === "signed-in" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <SyncAvatar user={state.user} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {to.signedInAs(state.user.name ?? state.user.email)}
                </p>
                {state.user.name && (
                  <p className="text-[11px] text-muted/60 truncate">
                    {state.user.email}
                  </p>
                )}
              </div>
              <button
                onClick={signOut}
                className="text-[11px] text-muted/60 hover:text-foreground underline-offset-2 hover:underline"
              >
                {to.useAnother}
              </button>
            </div>

            <div className="pt-4 border-t border-border space-y-4">
              <SyncToggle
                label={to.enableSyncLabel}
                description={to.enableSyncDesc}
                checked={enabled}
                onChange={(v) => setPreferences({ enabled: v })}
              />
              <SyncToggle
                label={to.includeProjectsLabel}
                description={to.includeProjectsDesc}
                checked={includeProjects}
                onChange={(v) => setPreferences({ includeProjects: v })}
              />
              <p className="text-[10px] text-muted/50 leading-relaxed">
                {to.flipAnytime}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center">
        <button
          onClick={() => onContinue()}
          className="text-sm text-muted/60 hover:text-muted transition-colors"
        >
          {state.status === "signed-in" ? to.setupLater : to.skipForNow}
        </button>
        <button
          onClick={onContinue}
          className="inline-flex items-center gap-2 px-7 py-3.5 bg-accent text-background font-semibold rounded-2xl hover:bg-accent-hover transition-all hover:scale-105 shadow-xl shadow-accent/20"
        >
          {to.continue}
          <ArrowRight size={18} />
        </button>
      </div>
    </div>
  );
}

function SyncToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-muted/60 leading-relaxed mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
          checked ? "bg-accent" : "bg-border"
        }`}
      >
        <span
          className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "left-[22px]" : "left-[3px]"
          }`}
        />
      </button>
    </div>
  );
}

function SyncAvatar({ user }: { user: { email: string; name?: string; picture?: string } }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (user.picture && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external avatar URL
      <img
        src={user.picture}
        alt=""
        onError={() => setImgFailed(true)}
        className="h-9 w-9 rounded-full"
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials = (user.name ?? user.email).slice(0, 2).toUpperCase();
  return (
    <div className="h-9 w-9 rounded-full bg-accent/20 text-accent flex items-center justify-center text-sm font-medium">
      {initials}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.69-1.56 2.66-3.86 2.66-6.63z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.46-.81 5.94-2.18l-2.9-2.26c-.81.55-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A8.99 8.99 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.73a5.42 5.42 0 0 1 0-3.46V4.94H.96a9 9 0 0 0 0 8.13l3.01-2.34z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.34l2.58-2.58A8.99 8.99 0 0 0 9 0 9 9 0 0 0 .96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );
}

// Floating coach card: non-blocking, lets the user interact with the real UI
function CoachCard({
  step,
  ingestCount,
  initialCount,
  onSkip,
}: {
  step: Step;
  ingestCount: number;
  initialCount: number;
  onSkip: () => void;
}) {
  const { t } = useT();
  const to = t.wiki.onboarding;
  const isIngest = step === "firstIngest";
  const isCompile = step === "compileGuide";

  const targetSelector = isIngest
    ? '[data-onboard="ingest-input"]'
    : '[data-onboard="compile-button"]';

  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    function update() {
      const el = document.querySelector(targetSelector);
      if (el) setRect(el.getBoundingClientRect());
      else setRect(null);
    }
    // Initial + retries (target may not be mounted yet after navigation)
    update();
    const retries: ReturnType<typeof setTimeout>[] = [];
    [100, 300, 600, 1000, 1500].forEach((delay) => {
      retries.push(setTimeout(update, delay));
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const iv = setInterval(update, 1000);
    return () => {
      retries.forEach(clearTimeout);
      clearInterval(iv);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [targetSelector]);

  // Arrow positioned relative to the target
  // For ingest: arrow above the input, pointing down
  // For compile: arrow to the right of the sidebar button, pointing left
  const arrowStyle: React.CSSProperties | null = (() => {
    if (!rect) return null;
    if (isIngest) {
      return {
        top: rect.top - 60,
        left: rect.left + rect.width / 2 - 14,
      };
    }
    // compile button — arrow sits immediately to its right
    return {
      top: rect.top + rect.height / 2 - 14,
      left: rect.right + 10,
    };
  })();

  return (
    <>
      {/* Arrow pointing to the relevant UI element */}
      {arrowStyle && isIngest && (
        <div
          className="fixed z-[90] pointer-events-none animate-float"
          style={arrowStyle}
        >
          <div className="flex flex-col items-center">
            <div className="w-0 h-0 border-l-[14px] border-l-transparent border-r-[14px] border-r-transparent border-b-[18px] border-b-accent drop-shadow-[0_0_10px_rgba(108,156,252,0.5)]" />
            <div className="w-1 h-10 bg-accent shadow-[0_0_10px_rgba(108,156,252,0.5)]" />
          </div>
        </div>
      )}
      {arrowStyle && isCompile && (
        <div
          className="fixed z-[90] pointer-events-none animate-compile-arrow"
          style={arrowStyle}
        >
          <div className="flex items-center">
            <div className="w-0 h-0 border-t-[14px] border-t-transparent border-b-[14px] border-b-transparent border-r-[18px] border-r-accent drop-shadow-[0_0_10px_rgba(108,156,252,0.5)]" />
            <div className="w-10 h-1 bg-accent shadow-[0_0_10px_rgba(108,156,252,0.5)]" />
          </div>
        </div>
      )}

      {/* Bottom-center floating card */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[95] animate-toast-in">
        <div className="bg-card border border-accent/30 rounded-2xl shadow-2xl shadow-accent/10 px-6 py-5 max-w-md backdrop-blur-xl">
          <button
            onClick={onSkip}
            className="absolute top-3 right-3 text-muted/40 hover:text-muted"
            title={to.skip}
          >
            <X size={14} />
          </button>

          {isIngest && (
            <div className="flex items-start gap-4">
              <div className="shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-accent to-purple-500 flex items-center justify-center shadow-lg shadow-accent/30">
                <Download size={20} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">
                    {to.stepOf(5, 6)}
                  </span>
                </div>
                <h3 className="text-sm font-semibold mb-1">
                  {to.ingestTitle}
                </h3>
                <p className="text-xs text-muted/70 leading-relaxed">
                  {to.ingestDesc}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Loader2 size={12} className="text-accent animate-spin" />
                  <span className="text-[11px] text-muted/60">
                    {to.waitingIngest}
                  </span>
                </div>
              </div>
            </div>
          )}

          {isCompile && (
            <div className="flex items-start gap-4">
              <div className="shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-amber-400 to-accent flex items-center justify-center shadow-lg shadow-amber-500/20">
                <Zap size={20} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">
                    {to.stepOf(6, 6)}
                  </span>
                </div>
                <h3 className="text-sm font-semibold mb-1">
                  {to.compileTitle}
                </h3>
                <p className="text-xs text-muted/70 leading-relaxed">
                  {to.compileDesc1}
                  <strong className="text-foreground">{to.compileStrong1}</strong>
                  {to.compileDesc2}
                  <strong className="text-accent">{to.compileStrong2}</strong>
                  {to.compileDesc3}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Loader2 size={12} className="text-accent animate-spin" />
                  <span className="text-[11px] text-muted/60">
                    {to.waitingCompile}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
