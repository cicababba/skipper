// ============================================================
// NestBrain — Constants
// ============================================================

export const DEFAULT_LLM_CONFIG = {
  provider: "claude-cli" as const,
  model: "sonnet",
  maxTurns: 5,
} as const;

export const EMBEDDINGS_CONFIG = {
  model: "Xenova/all-MiniLM-L6-v2",
  chunkSize: 512,
  chunkOverlap: 50,
} as const;

// ============================================================
// Google OAuth (Desktop app, PKCE flow)
// ============================================================
//
// The clientId + clientSecret for this OAuth client are NOT stored in this
// repo. They live in `apps/desktop/src/auth/oauth-config.ts`, which is
// gitignored. See `apps/desktop/src/auth/oauth-config.example.ts` for the
// shape, and `README.md` → "Build from Source" for how to create your own
// Google OAuth Desktop client and wire it up.

export const GOOGLE_OAUTH_ENDPOINTS = {
  authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revokeEndpoint: "https://oauth2.googleapis.com/revoke",
  userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  // Identity-only: sign-in proves the email for the supporter entitlement.
  scopes: ["openid", "email", "profile"],
} as const;

// ============================================================
// GitHub OAuth (GitHub App, user-to-server flow)
// ============================================================
//
// GitHub Apps don't support PKCE and don't take a `scope` param (permissions
// live on the App itself). Callback URLs must match exactly, so the loopback
// server binds one of the fixed ports below — all of them must be registered
// on the GitHub App as http://127.0.0.1:<port>/callback.

export const GITHUB_API_BASE_URL = "https://api.github.com";

export const GITHUB_OAUTH_ENDPOINTS = {
  authEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  userEndpoint: "https://api.github.com/user",
  emailsEndpoint: "https://api.github.com/user/emails",
  grantEndpointBase: "https://api.github.com/applications",
  redirectPorts: [8127, 8128, 8129],
} as const;
