// ============================================================
// NestBrain — Shared Types
// ============================================================

/** LLM provider configuration */
export type LLMProvider = "claude-cli" | "openai" | "ollama";

// ============================================================
// Auth
// ============================================================

/** Identity returned by Google's userinfo endpoint. */
export interface GoogleUser {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

/** Auth state pushed from desktop main → renderer. */
export type AuthState =
  | { status: "signed-out" }
  | { status: "signing-in" }
  | { status: "signed-in"; user: GoogleUser }
  | { status: "error"; error: string }
  /** Source build with placeholder OAuth credentials — sign-in can't work;
   *  the UI shows a disabled control instead of a sign-in that would fail. */
  | { status: "unconfigured" };
