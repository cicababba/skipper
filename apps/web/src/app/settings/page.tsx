"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Settings as SettingsIcon,
  Check,
  Loader2,
  Eye,
  EyeOff,
  AlertCircle,
  AlertTriangle,
  FolderOpen,
  ArrowRight,
  Cpu,
  RefreshCw,
  X,
} from "lucide-react";
import { SyncAccountSection } from "@/components/sync-account-section";
import { CliInstallSection } from "@/components/cli-install-section";
import { UpdatesSection } from "@/components/updates-section";
import { LanguageSection } from "@/components/language-section";
import { useT } from "@/lib/app-i18n";

interface OpenAIModel {
  id: string;
  owned_by: string;
}

interface OllamaModel {
  name: string;
  size?: number;
}

type Provider = "claude-cli" | "openai" | "ollama";

export default function SettingsPage() {
  const { t } = useT();
  const [provider, setProvider] = useState<Provider>("claude-cli");
  const [claudeModel, setClaudeModel] = useState("sonnet");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("gpt-4o");
  const [models, setModels] = useState<OpenAIModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [autoCompile, setAutoCompile] = useState(false);
  const [autoExtractAtoms, setAutoExtractAtoms] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  // Ollama
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<"idle" | "checking" | "up" | "down">("idle");
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [showOllamaError, setShowOllamaError] = useState(false);

  // Load current settings
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        if (data.llm) {
          setProvider(data.llm.provider);
          setClaudeModel(data.llm.claudeModel ?? "sonnet");
          setOpenaiApiKey(data.llm.openaiApiKey ?? "");
          setOpenaiModel(data.llm.openaiModel ?? "gpt-4o");
          setOllamaModel(data.llm.ollamaModel ?? "");
        }
        setAutoCompile(data.autoCompile ?? false);
        setAutoExtractAtoms(data.autoExtractAtoms ?? true);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Load OpenAI models when provider is openai and key exists
  useEffect(() => {
    if (provider === "openai" && openaiApiKey && !openaiApiKey.startsWith("sk-...")) {
      loadModels(openaiApiKey);
    } else if (provider === "openai" && openaiApiKey.startsWith("sk-...")) {
      // Key is masked, load with saved key
      loadModels();
    }
  }, [provider]);

  // Probe Ollama whenever it becomes the selected provider.
  useEffect(() => {
    if (provider === "ollama") checkOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  async function checkOllama() {
    setOllamaStatus("checking");
    setOllamaError(null);
    try {
      const res = await fetch("/api/ollama/models");
      const data = await res.json();
      if (!data.running) {
        setOllamaStatus("down");
        setOllamaModels([]);
        setOllamaError(data.error ?? t.settings.ollama.notRunning);
        setShowOllamaError(true);
        return;
      }
      setOllamaStatus("up");
      const list: OllamaModel[] = data.models ?? [];
      setOllamaModels(list);
      // Keep the saved model if still installed, else fall back to the first.
      setOllamaModel((cur) => (list.some((m) => m.name === cur) ? cur : list[0]?.name ?? ""));
    } catch {
      setOllamaStatus("down");
      setOllamaModels([]);
      setOllamaError(t.settings.ollama.failedReach);
      setShowOllamaError(true);
    }
  }

  async function loadModels(key?: string) {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const url = key ? `/api/openai/models?key=${encodeURIComponent(key)}` : "/api/openai/models";
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        setModelsError(data.error);
        setModels([]);
      } else {
        setModels(data.models ?? []);
      }
    } catch {
      setModelsError(t.settings.llm.failedLoadModels);
      setModels([]);
    }
    setModelsLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llm: {
            provider,
            claudeModel,
            openaiApiKey,
            openaiModel,
            ollamaModel,
          },
          autoCompile,
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

  async function handleTestKey() {
    if (!openaiApiKey || openaiApiKey.startsWith("sk-...")) return;
    await loadModels(openaiApiKey);
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

        <SyncAccountSection />

        <UpdatesSection />

        {/* LLM Provider */}
        <section className="mb-10">
          <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4">
            {t.settings.llm.title}
          </h2>

          <div className="grid grid-cols-3 gap-3 mb-6">
            {/* Claude option */}
            <button
              onClick={() => setProvider("claude-cli")}
              className={`p-4 rounded-xl border-2 text-left transition-all ${
                provider === "claude-cli"
                  ? "border-accent bg-accent/5"
                  : "border-border hover:border-border hover:bg-card"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Claude</span>
                {provider === "claude-cli" && (
                  <Check size={14} className="text-accent" />
                )}
              </div>
              <p className="text-[11px] text-muted/60 leading-relaxed">
                {t.settings.llm.claudeDesc}
              </p>
            </button>

            {/* OpenAI option */}
            <button
              onClick={() => setProvider("openai")}
              className={`p-4 rounded-xl border-2 text-left transition-all ${
                provider === "openai"
                  ? "border-accent bg-accent/5"
                  : "border-border hover:border-border hover:bg-card"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">OpenAI</span>
                {provider === "openai" && (
                  <Check size={14} className="text-accent" />
                )}
              </div>
              <p className="text-[11px] text-muted/60 leading-relaxed">
                {t.settings.llm.openaiDesc}
              </p>
            </button>

            {/* Ollama option */}
            <button
              onClick={() => setProvider("ollama")}
              className={`p-4 rounded-xl border-2 text-left transition-all ${
                provider === "ollama"
                  ? "border-accent bg-accent/5"
                  : "border-border hover:border-border hover:bg-card"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Ollama</span>
                {provider === "ollama" && <Check size={14} className="text-accent" />}
              </div>
              <p className="text-[11px] text-muted/60 leading-relaxed">
                {t.settings.llm.ollamaDesc}
              </p>
            </button>
          </div>

          {/* Claude settings */}
          {provider === "claude-cli" && (
            <div className="space-y-4 p-5 rounded-xl bg-card border border-border">
              <div>
                <label className="block text-xs text-muted/70 mb-2">{t.settings.llm.model}</label>
                <select
                  value={claudeModel}
                  onChange={(e) => setClaudeModel(e.target.value)}
                  className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                >
                  {/* Aliases — the claude CLI resolves each to the newest
                      release of that tier, so this never needs version bumps. */}
                  <option value="opus">Claude Opus ({t.settings.llm.latest})</option>
                  <option value="sonnet">Claude Sonnet ({t.settings.llm.latest})</option>
                  <option value="haiku">Claude Haiku ({t.settings.llm.latest})</option>
                </select>
              </div>
              <p className="text-[11px] text-muted/40 leading-relaxed">
                {t.settings.llm.claudeAuthBefore}{" "}
                <code className="text-accent/60 bg-accent/5 px-1 rounded">claude auth login</code>{" "}
                {t.settings.llm.claudeAuthAfter}
              </p>
            </div>
          )}

          {/* OpenAI settings */}
          {provider === "openai" && (
            <div className="space-y-4 p-5 rounded-xl bg-card border border-border">
              {/* API Key */}
              <div>
                <label className="block text-xs text-muted/70 mb-2">{t.settings.llm.apiKey}</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showKey ? "text" : "password"}
                      value={openaiApiKey}
                      onChange={(e) => setOpenaiApiKey(e.target.value)}
                      placeholder="sk-..."
                      className="w-full px-3 py-2.5 pr-10 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted/30 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 font-mono"
                    />
                    <button
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted/40 hover:text-muted transition-colors"
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button
                    onClick={handleTestKey}
                    disabled={!openaiApiKey || openaiApiKey.startsWith("sk-...")}
                    className="px-3 py-2.5 bg-background border border-border rounded-lg text-xs text-muted hover:text-foreground hover:border-accent/30 transition-colors disabled:opacity-30"
                  >
                    {t.settings.llm.test}
                  </button>
                </div>
              </div>

              {/* Model selector */}
              <div>
                <label className="block text-xs text-muted/70 mb-2">{t.settings.llm.model}</label>
                {modelsLoading ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted">
                    <Loader2 size={12} className="animate-spin" />
                    {t.settings.llm.loadingModels}
                  </div>
                ) : modelsError ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-red-400">
                    <AlertCircle size={12} />
                    {modelsError}
                  </div>
                ) : models.length > 0 ? (
                  <select
                    value={openaiModel}
                    onChange={(e) => setOpenaiModel(e.target.value)}
                    className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={openaiModel}
                    onChange={(e) => setOpenaiModel(e.target.value)}
                    className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                  >
                    <option value="gpt-4o">gpt-4o</option>
                    <option value="gpt-4o-mini">gpt-4o-mini</option>
                    <option value="gpt-4-turbo">gpt-4-turbo</option>
                    <option value="o4-mini">o4-mini</option>
                  </select>
                )}
                {models.length > 0 && (
                  <p className="text-[10px] text-muted/30 mt-1.5">
                    {t.settings.llm.modelsAvailable(models.length)}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Ollama settings */}
          {provider === "ollama" && (
            <div className="space-y-4 p-5 rounded-xl bg-card border border-border">
              {/* Server status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs">
                  {ollamaStatus === "checking" ? (
                    <>
                      <Loader2 size={13} className="animate-spin text-muted" />
                      <span className="text-muted">{t.settings.ollama.checking}</span>
                    </>
                  ) : ollamaStatus === "up" ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-green-400" />
                      <span className="text-green-400/90">
                        {t.settings.ollama.running(ollamaModels.length)}
                      </span>
                    </>
                  ) : ollamaStatus === "down" ? (
                    <>
                      <AlertCircle size={13} className="text-red-400" />
                      <span className="text-red-400">{t.settings.ollama.notReachable}</span>
                    </>
                  ) : (
                    <span className="text-muted/60">Ollama</span>
                  )}
                </div>
                <button
                  onClick={checkOllama}
                  disabled={ollamaStatus === "checking"}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-background border border-border rounded-lg text-[11px] text-muted hover:text-foreground hover:border-accent/30 transition-colors disabled:opacity-40"
                >
                  <RefreshCw size={11} className={ollamaStatus === "checking" ? "animate-spin" : ""} />
                  {t.settings.ollama.checkAgain}
                </button>
              </div>

              {/* Model selector — enabled only when the server is up */}
              <div>
                <label className="block text-xs text-muted/70 mb-2">{t.settings.llm.model}</label>
                {ollamaStatus === "up" && ollamaModels.length > 0 ? (
                  <select
                    value={ollamaModel}
                    onChange={(e) => setOllamaModel(e.target.value)}
                    className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                  >
                    {ollamaModels.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                ) : ollamaStatus === "up" && ollamaModels.length === 0 ? (
                  <p className="text-[11px] text-muted/60 leading-relaxed px-3 py-2.5 bg-background border border-border rounded-lg">
                    {t.settings.ollama.noModelsBefore}{" "}
                    <code className="text-accent/70 bg-accent/5 px-1 rounded">ollama pull llama3</code>
                    {t.settings.ollama.noModelsAfter}
                  </p>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-background border border-border rounded-lg text-xs text-muted/50">
                    {ollamaStatus === "checking" ? t.settings.ollama.detecting : t.settings.ollama.startServer}
                  </div>
                )}
              </div>

              <p className="text-[11px] text-muted/40 leading-relaxed">
                {t.settings.ollama.localNoteBefore}{" "}
                <code className="text-accent/60 bg-accent/5 px-1 rounded">ollama serve</code>
                {t.settings.ollama.localNoteAfter}
              </p>
            </div>
          )}
        </section>

        {/* Auto-Compile */}
        <section className="mb-10">
          <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4">
            {t.settings.compile.title}
          </h2>
          <div className="p-5 rounded-xl bg-card border border-border space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{t.settings.compile.autoTitle}</p>
                <p className="text-[11px] text-muted/60 leading-relaxed mt-1">
                  {t.settings.compile.autoDesc}
                </p>
              </div>
              <button
                onClick={() => setAutoCompile(!autoCompile)}
                className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
                  autoCompile ? "bg-accent" : "bg-border"
                }`}
              >
                <span
                  className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-transform ${
                    autoCompile ? "left-[22px]" : "left-[3px]"
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-5">
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

        {/* NestBrain Location */}
        <NestBrainLocation />

        {/* Danger Zone */}
        <DangerZone />
      </div>

      {showOllamaError && (
        <OllamaErrorModal
          message={ollamaError ?? t.settings.ollama.notRunning}
          onClose={() => setShowOllamaError(false)}
          onRetry={() => {
            setShowOllamaError(false);
            checkOllama();
          }}
        />
      )}
    </div>
  );
}

function OllamaErrorModal({
  message,
  onClose,
  onRetry,
}: {
  message: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useT();
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center"
      style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh" }}
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl p-6 max-w-md w-[90%] mx-4 animate-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center shadow-lg shadow-red-500/20">
              <AlertTriangle size={18} className="text-white" />
            </div>
            <h3 className="text-base font-semibold">{t.settings.ollama.modalTitle}</h3>
          </div>
          <button onClick={onClose} className="text-muted/40 hover:text-muted transition-colors">
            <X size={16} />
          </button>
        </div>

        <p className="text-sm text-muted/80 leading-relaxed mb-3">{message}</p>
        <div className="text-[12px] text-muted/60 leading-relaxed bg-background border border-border rounded-lg p-3 mb-5">
          <p className="mb-1">{t.settings.ollama.modalSteps}</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>
              {t.settings.ollama.stepInstall}{" "}
              <span className="text-accent/70">ollama.com</span>
            </li>
            <li>
              {t.settings.ollama.stepStart} <code className="text-accent/70 bg-accent/5 px-1 rounded">ollama serve</code>
            </li>
            <li>
              {t.settings.ollama.stepPull} <code className="text-accent/70 bg-accent/5 px-1 rounded">ollama pull llama3</code>
            </li>
          </ol>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-foreground border border-border rounded-lg hover:bg-card-hover transition-colors"
          >
            {t.settings.ollama.dismiss}
          </button>
          <button
            onClick={onRetry}
            className="px-5 py-2 bg-accent text-background text-sm font-medium rounded-lg hover:bg-accent-hover transition-colors flex items-center gap-2"
          >
            <RefreshCw size={14} />
            {t.settings.ollama.retry}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NestBrainLocation() {
  const { t } = useT();
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmParent, setConfirmParent] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.nestbrain) return;
    window.nestbrain.getBootstrap().then((b) => {
      setCurrentPath(b?.nestBrainPath ?? null);
    });
    const off = window.nestbrain.onNestBrainMoved?.((info) => {
      setCurrentPath(info.nestBrainPath);
    });
    return () => {
      if (off) off();
    };
  }, []);

  // Only render in Electron — moving the workspace is a native-only feature
  if (typeof window !== "undefined" && !window.nestbrain) return null;

  async function handlePickLocation() {
    setError(null);
    setNotice(null);
    if (!window.nestbrain) return;
    const parent = await window.nestbrain.selectDirectory();
    if (!parent) return;
    setConfirmParent(parent);
  }

  async function handleConfirm() {
    if (!confirmParent || !window.nestbrain) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.nestbrain.moveOrCreateNestBrain(confirmParent);
      setCurrentPath(result.nestBrainPath);
      setNotice(
        result.moved
          ? t.settings.location.moved
          : result.created
            ? t.settings.location.created
            : t.settings.location.unchanged,
      );
      setConfirmParent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.location.moveFailed);
    }
    setBusy(false);
  }

  return (
    <section className="mt-12 pt-8 border-t border-border">
      <h2 className="text-sm font-medium text-muted/70 uppercase tracking-wider mb-4">
        {t.settings.location.title}
      </h2>

      <div className="p-5 rounded-xl bg-card border border-border">
        <div className="flex items-start gap-3 mb-4">
          <FolderOpen size={16} className="text-muted/60 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-muted/60 uppercase tracking-wider mb-1">
              {t.settings.location.currentPath}
            </p>
            <p className="text-sm font-mono text-foreground truncate" title={currentPath ?? ""}>
              {currentPath ?? t.settings.location.notSet}
            </p>
          </div>
        </div>

        <p className="text-[11px] text-muted/60 leading-relaxed mb-4">
          {t.settings.location.desc}
        </p>

        <button
          onClick={handlePickLocation}
          disabled={busy}
          className="px-4 py-2 bg-background border border-border rounded-lg text-xs text-foreground hover:border-accent/40 hover:bg-accent/5 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          <FolderOpen size={13} />
          {t.settings.location.change}
        </button>

        {notice && (
          <p className="mt-3 text-xs text-green-400/80 flex items-center gap-1.5">
            <Check size={12} />
            {notice}
          </p>
        )}
        {error && (
          <p className="mt-3 text-xs text-red-400/80 flex items-start gap-1.5">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {confirmParent && (
          <div className="mt-4 p-4 rounded-lg bg-accent/5 border border-accent/20">
            <p className="text-xs text-foreground/90 mb-3 leading-relaxed">
              {currentPath ? t.settings.location.confirmMove : t.settings.location.confirmCreate}
            </p>
            <div className="flex items-center gap-2 text-[11px] font-mono text-muted/70 mb-4 overflow-hidden">
              {currentPath && (
                <>
                  <span className="truncate" title={currentPath}>
                    {currentPath}
                  </span>
                  <ArrowRight size={12} className="shrink-0 text-muted/40" />
                </>
              )}
              <span className="truncate text-foreground/80" title={`${confirmParent}/NestBrain`}>
                {confirmParent}/NestBrain
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleConfirm}
                disabled={busy}
                className="px-4 py-2 bg-accent text-background text-xs font-medium rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                {busy ? t.settings.location.working : t.settings.location.confirm}
              </button>
              <button
                onClick={() => setConfirmParent(null)}
                disabled={busy}
                className="px-4 py-2 bg-background border border-border rounded-lg text-xs text-muted hover:text-foreground transition-colors disabled:opacity-50"
              >
                {t.settings.location.cancel}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function DangerZone() {
  const { t } = useT();
  const [wiping, setWiping] = useState(false);
  const [wiped, setWiped] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  async function handleWipe() {
    if (confirmText !== "DELETE") return;
    setWiping(true);
    try {
      const res = await fetch("/api/settings/wipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_EVERYTHING" }),
      });
      const data = await res.json();
      if (data.ok) {
        setWiped(true);
        setConfirmText("");
      }
    } catch { /* */ }
    setWiping(false);
  }

  return (
    <section className="mt-12 pt-8 border-t border-red-500/20">
      <h2 className="text-sm font-medium text-red-400/80 uppercase tracking-wider mb-4">
        {t.settings.danger.title}
      </h2>

      <div className="p-5 rounded-xl bg-red-500/[0.03] border border-red-500/20">
        <h3 className="text-sm font-medium text-red-400 mb-1">{t.settings.danger.wipeTitle}</h3>
        <p className="text-xs text-muted/60 leading-relaxed mb-4">
          {t.settings.danger.descIntro} <strong className="text-red-400/80">{t.settings.danger.sources}</strong>,{" "}
          <strong className="text-red-400/80">{t.settings.danger.articles}</strong>,{" "}
          <strong className="text-red-400/80">{t.settings.danger.qa}</strong>, {t.settings.danger.andThe}{" "}
          <strong className="text-red-400/80">{t.settings.danger.index}</strong>.{" "}
          {t.settings.danger.noUndo}
        </p>

        {wiped ? (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <p className="text-xs text-red-400">{t.settings.danger.wipedMsg}</p>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={t.settings.danger.placeholder}
              className="flex-1 px-3 py-2 bg-background border border-red-500/30 rounded-lg text-sm text-foreground placeholder:text-muted/30 focus:outline-none focus:border-red-500/60 focus:ring-1 focus:ring-red-500/20"
            />
            <button
              onClick={handleWipe}
              disabled={confirmText !== "DELETE" || wiping}
              className="px-4 py-2 bg-red-500/20 text-red-400 text-sm font-medium rounded-lg hover:bg-red-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {wiping && <Loader2 size={14} className="animate-spin" />}
              {t.settings.danger.wipeButton}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
