// ============================================================
// Skipper — Shared Types
// ============================================================

/** LLM provider configuration */
export type LLMProvider = "claude-cli" | "openai" | "ollama";

/** The `llm` block of settings.json — written by the web layer, read by main and the CLI. */
export interface LlmSettings {
  provider: LLMProvider;
  openaiApiKey: string;
  openaiModel: string;
  claudeModel: string;
  ollamaModel: string;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: "claude-cli",
  openaiApiKey: "",
  openaiModel: "gpt-4o",
  claudeModel: "sonnet",
  ollamaModel: "",
};

// ============================================================
// Auth
// ============================================================

export const AUTH_PROVIDER_IDS = ["google", "github", "gitlab"] as const;
export type AuthProviderId = (typeof AUTH_PROVIDER_IDS)[number];

/** Renderer-facing provider row (skipper:auth:getProviders), derived in main
 *  from the provider registry + the core issue-source registry. */
export interface AuthProviderMeta {
  id: AuthProviderId;
  displayName: string;
  /** An issue source polls this provider's accounts → Settings shows repo-picker affordances. */
  isIssueSource: boolean;
  /** Connect flow must collect an instance URL before auth (self-hosted providers). */
  requiresBaseUrl: boolean;
  /** Prefill for the instance-URL field (the provider's public host). */
  defaultBaseUrl?: string;
  /** Provider accepts a personal access token as a sign-in fallback. */
  supportsPat: boolean;
}

/** Provider-neutral identity for a connected account. */
export interface Account {
  provider: AuthProviderId;
  /** Provider-native user id (Google `sub`; GitHub numeric id as string). */
  id: string;
  /** GitHub may not expose one. */
  email?: string;
  name?: string;
  avatarUrl?: string;
  /** Normalized instance origin for self-hosted providers. Absent = the provider's fixed host. */
  baseUrl?: string;
  /** Absent = "oauth" (pre-#73 accounts). */
  authMethod?: "oauth" | "pat";
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
