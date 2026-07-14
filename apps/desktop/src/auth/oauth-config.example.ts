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
