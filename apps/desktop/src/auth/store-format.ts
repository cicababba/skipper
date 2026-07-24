// Auth store schema + (de)serialization. Pure — no electron imports — so the
// format and the legacy migration stay unit-testable.

import { accountKey, type Account } from "@skipper/shared";
import type { ProviderTokens } from "./provider";

// Re-exported so existing desktop-auth imports keep resolving here; the canonical
// definition lives in @skipper/shared so core/renderer can derive keys too (#101).
export { accountKey };

export interface StoredAccount {
  account: Account;
  tokens: ProviderTokens;
  signedInAt: number;
}

export interface AuthStoreFile {
  version: 2;
  /** Keyed by `${provider}:${account.id}`, or `${provider}:${host}:${account.id}`
   *  when the account is host-scoped (self-hosted instance). */
  accounts: Record<string, StoredAccount>;
}

export function emptyStore(): AuthStoreFile {
  return { version: 2, accounts: {} };
}

// Pre-multi-account format: one Google session in the whole file.
interface LegacyStoredSession {
  tokens: {
    accessToken: string;
    refreshToken: string;
    idToken: string;
    expiresAt: number;
    scope: string;
    tokenType: string;
  };
  user: { sub: string; email: string; name?: string; picture?: string };
  signedInAt: number;
}

/** Parse a decrypted store file; migrates the legacy single-session shape. Null = unrecognized. */
export function parseStoreFile(json: string): { store: AuthStoreFile; migrated: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  if (obj.version === 2 && typeof obj.accounts === "object" && obj.accounts !== null) {
    // Rebuild explicitly so a legacy `active` key is dropped on read.
    return {
      store: { version: 2, accounts: obj.accounts as Record<string, StoredAccount> },
      migrated: false,
    };
  }
  if (obj.version === undefined && typeof obj.tokens === "object" && obj.tokens !== null) {
    const legacy = parsed as LegacyStoredSession;
    if (typeof legacy.user?.sub !== "string") return null;
    const account: Account = {
      provider: "google",
      key: accountKey("google", legacy.user.sub),
      id: legacy.user.sub,
      email: legacy.user.email,
      name: legacy.user.name,
      avatarUrl: legacy.user.picture,
    };
    return {
      store: {
        version: 2,
        accounts: {
          [accountKey("google", account.id)]: {
            account,
            tokens: legacy.tokens,
            signedInAt: legacy.signedInAt,
          },
        },
      },
      migrated: true,
    };
  }
  return null;
}
