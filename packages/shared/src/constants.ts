// ============================================================
// NestBrain — Constants
// ============================================================

export const DEFAULT_CONFIG = {
  wiki: {
    name: "My Knowledge Base",
    path: "./data/wiki",
    rawPath: "./data/raw",
  },
  llm: {
    provider: "claude-cli" as const,
    model: "sonnet",
    maxTurns: 5,
  },
  embeddings: {
    model: "Xenova/all-MiniLM-L6-v2",
    chunkSize: 512,
    chunkOverlap: 50,
  },
  search: {
    semanticTopK: 10,
    fulltextEnabled: true,
  },
  server: {
    port: 3000,
    host: "localhost",
  },
} as const;

export const WIKI_DIRS = {
  sources: "sources",
  concepts: "concepts",
  outputs: "outputs",
} as const;

export const INDEX_FILES = {
  master: "_index.md",
  concepts: "_concepts.md",
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
