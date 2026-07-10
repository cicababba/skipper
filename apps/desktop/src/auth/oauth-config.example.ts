// Google OAuth client credentials.
//
// THIS FILE IS A TEMPLATE. Copy it to `oauth-config.ts` (next to this file)
// and fill in your own values. The real `oauth-config.ts` is gitignored.
//
// Steps to get your own credentials:
//   1. https://console.cloud.google.com/apis/credentials → Create credentials
//      → OAuth client ID → Application type: "Desktop app". Name it anything.
//   2. Copy the Client ID (ends with `.apps.googleusercontent.com`) and the
//      Client secret (starts with `GOCSPX-`) into the constants below.
//   3. On the OAuth consent screen, add the scopes used by NestBrain:
//        openid, email, profile
//      and (while in Testing mode) add your Google account as a test user.
//
// For OAuth client type "Desktop app", Google considers the secret
// *non-confidential* — it ships in the distributed binary, and security is
// provided by PKCE, not by the secret. We keep it out of the public repo
// only so every fork uses its own OAuth client (GitHub's secret scanner
// also doesn't know the Desktop-app exception, and blocks pushes if it sees
// a `GOCSPX-...` literal).

export const OAUTH_CLIENT_ID = "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com";
export const OAUTH_CLIENT_SECRET = "GOCSPX-YOUR_SECRET_HERE";
