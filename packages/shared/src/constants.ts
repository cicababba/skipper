// ============================================================
// Skipper — Constants
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

// ============================================================
// GitLab OAuth (public client, PKCE flow)
// ============================================================
//
// First provider whose endpoints are functions of the instance base URL:
// the shipped client targets gitlab.com, self-managed instances sign in with
// a PAT. GitLab matches redirect URIs *exactly*, port included (no RFC 8252
// loopback port flexibility — gitlab-org/gitlab#435764), so all three fixed
// ports must be registered on the application as
// http://127.0.0.1:<port>/callback. The application is a public client
// ("Confidential" OFF): no client secret exists, so none is ever sent — PKCE
// secures the exchange. The `api` scope is used from the start: read_api +
// write_repository can't create merge requests (write_repository is
// git-over-HTTP only; MR creation needs `api`), and full `api` avoids a
// future re-auth when MR creation lands. Refresh tokens rotate and are
// single-use; access tokens expire (~2h). Minimum supported GitLab: 15.0
// (expiring + rotating tokens are the default there and PKCE is available).

export const GITLAB_BASE_URL = "https://gitlab.com";

export const GITLAB_OAUTH_ENDPOINTS = {
  authEndpoint: (base: string = GITLAB_BASE_URL) => `${base}/oauth/authorize`,
  tokenEndpoint: (base: string = GITLAB_BASE_URL) => `${base}/oauth/token`,
  revokeEndpoint: (base: string = GITLAB_BASE_URL) => `${base}/oauth/revoke`,
  userEndpoint: (base: string = GITLAB_BASE_URL) => `${base}/api/v4/user`,
  scopes: ["api"],
  redirectPorts: [8130, 8131, 8132],
} as const;

// ============================================================
// Jira OAuth (Atlassian 3LO — Jira Cloud)
// ============================================================
//
// Jira Cloud 3LO runs against auth.atlassian.com, NOT the site. The exchanged
// token is unusable until GET api.atlassian.com/oauth/token/accessible-resources
// resolves a cloudId; every API call then routes via
// api.atlassian.com/ex/jira/<cloudId>/rest/api/3/... The chosen site URL
// (https://<site>.atlassian.net) becomes Account.baseUrl, so two sites reached
// by one token become two host-scoped accounts. 3LO does not support PKCE — a
// (non-confidential desktop) client secret is required — and the token endpoint
// wants a JSON body on both grants. Refresh tokens rotate (single-use, 90-day
// inactivity) and need the offline_access scope. Only one callback URL per app,
// so a single fixed loopback port. Jira Data Center (self-hosted) is a separate
// product: it signs in with a PAT + instance URL via the v2 REST API.

export const JIRA_OAUTH_ENDPOINTS = {
  authEndpoint: "https://auth.atlassian.com/authorize",
  tokenEndpoint: "https://auth.atlassian.com/oauth/token",
  accessibleResourcesEndpoint: "https://api.atlassian.com/oauth/token/accessible-resources",
  apiBase: (cloudId: string) => `https://api.atlassian.com/ex/jira/${cloudId}`,
  myselfEndpoint: (cloudId: string) =>
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`,
  dcMyselfEndpoint: (base: string) => `${base}/rest/api/2/myself`,
  scopes: ["read:jira-work", "read:jira-user", "offline_access"],
  redirectPorts: [8133],
} as const;
