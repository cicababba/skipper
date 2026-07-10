// ============================================================
// NestBrain — Shared Types
// ============================================================

/** LLM provider configuration */
export type LLMProvider = "claude-cli" | "openai" | "ollama";

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
