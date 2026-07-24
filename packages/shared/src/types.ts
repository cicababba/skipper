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

export const AUTH_PROVIDER_IDS = ["google", "github", "gitlab", "jira", "bitbucket"] as const;
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
  /** OAuth is fixed-host, but the PAT fallback still needs an instance URL
   *  (Jira Data Center). Independent from requiresBaseUrl. */
  patRequiresBaseUrl?: boolean;
  /** Tracker whose projects have no inherent repo — Settings shows the
   *  project→repo mapping editor for its accounts (#79). */
  needsProjectMapping?: boolean;
}

/** A site/resource the OAuth token can reach — the user picks one per account
 *  when the token spans several (Jira Cloud accessible-resources). */
export interface ResourceCandidate {
  /** Provider-native resource id (Jira cloudId). */
  id: string;
  name: string;
  /** The site origin (e.g. https://acme.atlassian.net) — becomes Account.baseUrl. */
  url: string;
  avatarUrl?: string;
}

/** Provider-neutral identity for a connected account. */
export interface Account {
  provider: AuthProviderId;
  /** Globally unique account identity: `provider:id`, or `provider:host:id` for
   *  a self-hosted instance. THE identity everywhere downstream (accountKey). */
  key: string;
  /** Provider-native user id (Google `sub`; GitHub numeric id as string).
   *  Only unique per instance — never an identity across hosts; use `key`. */
  id: string;
  /** GitHub may not expose one. */
  email?: string;
  name?: string;
  avatarUrl?: string;
  /** Normalized instance origin for self-hosted providers. Absent = the provider's fixed host. */
  baseUrl?: string;
  /** Atlassian cloudId — the API routes through api.atlassian.com/ex/jira/<cloudId>. */
  cloudId?: string;
  /** Absent = "oauth" (pre-#73 accounts). */
  authMethod?: "oauth" | "pat";
  /** Epoch ms of the last sign-in — row ordering + most-recent pick. */
  signedInAt?: number;
}

/** Per-provider sign-in flow status. */
export type ProviderFlowStatus =
  | { status: "idle" }
  | { status: "signing-in" }
  /** Token reaches several sites — the user must pick one before the account lands. */
  | { status: "choosing-resource"; candidates: ResourceCandidate[] }
  | { status: "error"; error: string }
  /** Source build with placeholder OAuth credentials for this provider —
   *  sign-in can't work; the UI shows a disabled control instead. */
  | { status: "unconfigured" };

/** Auth state pushed from desktop main → renderer. */
export interface AuthState {
  accounts: Account[];
  flows: Partial<Record<AuthProviderId, ProviderFlowStatus>>;
}

/** Single-provider view derived from AuthState (see auth-view.ts). */
export type ProviderAuthView =
  | { status: "signed-out" }
  | { status: "signing-in" }
  | { status: "signed-in"; account: Account }
  | { status: "error"; error: string }
  | { status: "unconfigured" };

/** All of a provider's accounts plus its flow — the multi-account settings view. */
export interface ProviderAccountsView {
  /** This provider's accounts in connection order (signedInAt ascending). */
  accounts: Account[];
  /** { status: "idle" } when the provider has no active flow. */
  flow: ProviderFlowStatus;
}
