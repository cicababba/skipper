// OAuth client credentials, one pair per provider.
//
// THIS FILE IS A TEMPLATE. Copy it to `oauth-config.ts` (next to this file)
// and fill in your own values. The real `oauth-config.ts` is gitignored.
// A provider left on its `YOUR_...` placeholder shows up as "unconfigured"
// in the app; the others keep working.
//
// Google (identity sign-in for the supporter entitlement):
//   1. https://console.cloud.google.com/apis/credentials → Create credentials
//      → OAuth client ID → Application type: "Desktop app". Name it anything.
//   2. Copy the Client ID (ends with `.apps.googleusercontent.com`) and the
//      Client secret (starts with `GOCSPX-`) into the constants below.
//   3. On the OAuth consent screen, add the scopes used by Skipper:
//        openid, email, profile
//      and (while in Testing mode) add your Google account as a test user.
//
// GitHub (issue/PR orchestration — GitHub App, user-to-server flow):
//   1. https://github.com/settings/apps → New GitHub App.
//   2. Callback URLs (add all three): http://127.0.0.1:8127/callback,
//      http://127.0.0.1:8128/callback, http://127.0.0.1:8129/callback.
//   3. Enable "Expire user authorization tokens"; webhook not required.
//   4. Permissions: Repository → Issues (Read), Pull requests (Read & write),
//      Metadata (Read); Account → Email addresses (Read).
//   5. Generate a client secret; copy Client ID (starts with `Iv`) + secret below.
//
// GitLab (issue/MR orchestration — public client, PKCE flow; gitlab.com):
//   1. https://gitlab.com → User Settings → Applications → Add new application.
//   2. Redirect URIs (add all three, matched exactly incl. port):
//      http://127.0.0.1:8130/callback, http://127.0.0.1:8131/callback,
//      http://127.0.0.1:8132/callback.
//   3. Leave "Confidential" UNCHECKED — this is a public client with no secret.
//   4. Scopes: api. Copy the Application ID into the const below (no secret).
//      Self-managed instances sign in with a personal access token instead.
//
// Jira (issue orchestration — Atlassian 3LO; Jira Cloud):
//   1. https://developer.atlassian.com/console/myapps → Create → OAuth 2.0
//      integration. Add the "Jira API" permission with the classic scopes
//      read:jira-work, read:jira-user (offline_access is added automatically
//      for rotating refresh tokens).
//   2. Authorization → OAuth 2.0 (3LO): set the callback URL to
//      http://127.0.0.1:8133/callback (only ONE callback URL is allowed).
//   3. Copy the Client ID and Client secret from Settings into the consts
//      below. 3LO does not use PKCE, so the (non-confidential desktop) secret
//      is required. Jira Data Center (self-hosted) signs in with a personal
//      access token + instance URL instead.
//
// Bitbucket (PR orchestration — Atlassian-managed OAuth client):
//   1. bitbucket.org → workspace → Settings → OAuth clients (Atlassian's new
//      client system; secrets are ATOA-prefixed, same infra as Jira) → Create.
//   2. Authorization: grant types "Authorization code" + "Refresh token".
//   3. Callback URL: exactly http://127.0.0.1:8134/callback — these clients
//      enforce an exact match (the classic consumer's prefix-match/any-port
//      behavior is gone), so the app pins redirect port 8134.
//   4. Scopes: Account → Email + Read (`account`, covers /user/emails),
//      Repositories → Read + Write (`repository`), Pull requests → Read +
//      Write (`pullrequest:write`).
//   5. Copy client Key/Secret below. No PKCE support, so the
//      (non-confidential desktop) secret is required; token endpoint takes it
//      via HTTP Basic. Bitbucket Data Center (self-hosted) is not covered.
//
// OpenProject (issue orchestration — self-hosted; Doorkeeper OAuth or API key):
//   No entry below — OpenProject is self-hosted, so there is no shipped OAuth
//   client. You register one on your own instance and paste its Client ID into
//   the app at connect time:
//   1. Administration → Authentication → OAuth applications → Add.
//   2. Redirect URIs (add all three): http://127.0.0.1:8135/callback,
//      http://127.0.0.1:8136/callback, http://127.0.0.1:8137/callback.
//   3. Enable "Confidential" OFF (public client — PKCE secures the flow) and the
//      `api_v3` scope. Copy the Client ID and paste it in Settings → OpenProject.
//   As a simpler alternative, sign in with an API key (My account → Access
//      tokens → API) — Skipper sends it via HTTP Basic as username `apikey`.
//
// For Google's "Desktop app" client type the secret is *non-confidential* —
// it ships in the distributed binary, and security is provided by PKCE, not
// by the secret. GitHub Apps don't support PKCE, but the same reasoning
// applies to a desktop distribution: the secret gates nothing sensitive by
// itself (tokens still require the user's browser consent). We keep both out
// of the public repo only so every fork uses its own OAuth clients (GitHub's
// secret scanner also blocks pushes if it sees a `GOCSPX-...` literal).

export const GOOGLE_OAUTH_CLIENT_ID = "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com";
export const GOOGLE_OAUTH_CLIENT_SECRET = "GOCSPX-YOUR_SECRET_HERE";

export const GITHUB_OAUTH_CLIENT_ID = "YOUR_GITHUB_APP_CLIENT_ID";
export const GITHUB_OAUTH_CLIENT_SECRET = "YOUR_GITHUB_APP_CLIENT_SECRET";

// GitLab is a public client — no secret.
export const GITLAB_OAUTH_CLIENT_ID = "YOUR_GITLAB_APPLICATION_ID";

export const JIRA_OAUTH_CLIENT_ID = "YOUR_JIRA_OAUTH_CLIENT_ID";
export const JIRA_OAUTH_CLIENT_SECRET = "YOUR_JIRA_OAUTH_CLIENT_SECRET";

export const BITBUCKET_OAUTH_CLIENT_ID = "YOUR_BITBUCKET_OAUTH_CLIENT_ID";
export const BITBUCKET_OAUTH_CLIENT_SECRET = "YOUR_BITBUCKET_OAUTH_CLIENT_SECRET";
