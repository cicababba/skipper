// ============================================================
// Skipper — Shared Types
// ============================================================

/** LLM provider configuration */
export type LLMProvider = "claude-cli" | "codex-cli" | "openai" | "ollama";

/** Providers whose agent() can drive the planner and the coder. */
export const AGENTIC_PROVIDERS: readonly LLMProvider[] = ["claude-cli", "codex-cli", "ollama"];

/** Codex has no --max-turns and no config equivalent, so a per-role turn cap
 *  can't be enforced there — only a wall-clock bound can. Settings surfaces
 *  this rather than letting the control silently do nothing. */
export const PROVIDERS_WITHOUT_TURN_CAP: readonly LLMProvider[] = ["codex-cli"];

/** The `llm` block of settings.json — written by the web layer, read by main and the CLI. */
export interface LlmSettings {
  provider: LLMProvider;
  openaiApiKey: string;
  openaiModel: string;
  claudeModel: string;
  codexApiKey: string;
  codexModel: string;
  ollamaModel: string;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: "claude-cli",
  openaiApiKey: "",
  openaiModel: "gpt-4o",
  claudeModel: "sonnet",
  codexApiKey: "",
  // Pinned deliberately: codex resolves its own default from a remote list
  // (cached 300s), so leaving it blank lets OpenAI move the model under us.
  codexModel: "gpt-5.6-sol",
  ollamaModel: "",
};

// ============================================================
// Auth
// ============================================================

export type AuthProviderId = "google" | "github";

/** Provider-neutral identity for a connected account. */
export interface Account {
  provider: AuthProviderId;
  /** Provider-native user id (Google `sub`; GitHub numeric id as string). */
  id: string;
  /** GitHub may not expose one. */
  email?: string;
  name?: string;
  avatarUrl?: string;
}

/** Per-provider sign-in flow status. */
export type ProviderFlowStatus =
  | { status: "idle" }
  | { status: "signing-in" }
  | { status: "error"; error: string }
  /** Source build with placeholder OAuth credentials for this provider —
   *  sign-in can't work; the UI shows a disabled control instead. */
  | { status: "unconfigured" };

/** Auth state pushed from desktop main → renderer. */
export interface AuthState {
  accounts: Account[];
  /** provider → active account id */
  active: Partial<Record<AuthProviderId, string>>;
  flows: Partial<Record<AuthProviderId, ProviderFlowStatus>>;
}

/** Single-provider view derived from AuthState (see auth-view.ts). */
export type ProviderAuthView =
  | { status: "signed-out" }
  | { status: "signing-in" }
  | { status: "signed-in"; account: Account }
  | { status: "error"; error: string }
  | { status: "unconfigured" };
