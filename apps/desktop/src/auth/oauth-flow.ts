// Generic OAuth 2.0 desktop flow (loopback redirect), parameterized by
// ProviderConfig.
//
// Flow:
//   1. Generate a CSRF state (+ PKCE pair when the provider supports it).
//   2. Start a local HTTP server on a loopback port — a free one, or the
//      provider's fixed port list when callback URLs must match exactly.
//   3. Open the system browser to the provider's auth endpoint with
//      redirect_uri = http://127.0.0.1:<port>/callback.
//   4. The provider redirects back with ?code=...&state=...
//   5. Exchange code for tokens, then map the user via config.mapUser.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { shell } from "electron";
import type { Account } from "@nestbrain/shared";
import { OAuthError, type ProviderConfig, type ProviderTokens, type RefreshedTokens } from "./provider";
import { SUCCESS_HTML, errorHtml } from "./callback-pages";

export interface OAuthSuccess {
  tokens: ProviderTokens;
  account: Account;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Run the full OAuth flow for a provider. Opens the system browser, waits for
 * the loopback callback, exchanges the code, and returns tokens + account.
 *
 * Throws OAuthError on any failure (user cancel, network, token exchange).
 */
export async function runOAuthFlow(config: ProviderConfig, signal?: AbortSignal): Promise<OAuthSuccess> {
  const { verifier, challenge } = generatePkcePair();
  const state = base64url(randomBytes(16));

  const { code, redirectUri } = await captureAuthCode(config, { state, challenge, signal });
  const tokens = await exchangeCodeForTokens(config, code, verifier, redirectUri);
  const account = await config.mapUser(tokens.accessToken);

  return { tokens, account };
}

interface CaptureArgs {
  state: string;
  challenge: string;
  signal?: AbortSignal;
}

interface CaptureResult {
  code: string;
  redirectUri: string;
}

/** Resolves true when listening, false on EADDRINUSE (caller tries the next port). */
function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(new OAuthError("Local OAuth server error", err));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function captureAuthCode(config: ProviderConfig, args: CaptureArgs): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve, reject) => {
    // Captured once at listen() time and reused for both the auth URL and
    // the token-exchange redirect_uri — they MUST be byte-identical strings
    // or the provider rejects the exchange with redirect_uri_mismatch.
    let redirectUri = "";

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only handle GET /callback?...; ignore favicon, etc.
      if (!req.url || !req.url.startsWith("/callback")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(errorHtml(`${config.displayName} returned: ${error}`));
        server.close();
        reject(new OAuthError(`${config.displayName} authorization error: ${error}`));
        return;
      }
      if (!code || returnedState !== args.state) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(errorHtml("Invalid callback (missing code or state mismatch)."));
        server.close();
        reject(new OAuthError("Invalid OAuth callback"));
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      server.close();
      resolve({ code, redirectUri });
    });

    // Abort support: if the caller cancels, tear everything down.
    const onAbort = () => {
      try { server.close(); } catch { /* ignore */ }
      reject(new OAuthError("Sign-in cancelled"));
    };
    args.signal?.addEventListener("abort", onAbort, { once: true });

    void (async () => {
      const ports = config.redirectPorts ?? [0];
      let bound = false;
      for (const port of ports) {
        if (await tryListen(server, port)) {
          bound = true;
          break;
        }
      }
      if (!bound) {
        reject(
          new OAuthError(
            `Loopback ports ${ports.join(", ")} are all busy — close the conflicting app and retry.`,
          ),
        );
        return;
      }
      server.on("error", (err) => reject(new OAuthError("Local OAuth server error", err)));

      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new OAuthError("Failed to bind local OAuth server"));
        return;
      }
      redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      const authUrl = buildAuthUrl(config, {
        redirectUri,
        state: args.state,
        codeChallenge: args.challenge,
      });
      shell.openExternal(authUrl).catch((err) => {
        reject(new OAuthError("Failed to open system browser", err));
      });
    })().catch((err) => {
      reject(err instanceof OAuthError ? err : new OAuthError("Local OAuth server error", err));
    });
  });
}

function buildAuthUrl(
  config: ProviderConfig,
  args: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    state: args.state,
    ...config.extraAuthParams,
  });
  if (config.scopes.length > 0) {
    params.set("scope", config.scopes.join(" "));
  }
  if (config.usesPkce) {
    params.set("code_challenge", args.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${config.authEndpoint}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  id_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

async function tokenRequest(
  config: ProviderConfig,
  label: string,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const body = new URLSearchParams({ client_id: config.clientId, ...params });
  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }
  const res = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // GitHub answers form-encoded unless asked for JSON; Google ignores it.
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OAuthError(`${label} failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  // GitHub returns errors as HTTP 200 with an error body.
  if (json.error) {
    throw new OAuthError(`${label} failed: ${json.error}${json.error_description ? ` — ${json.error_description}` : ""}`);
  }
  return json;
}

async function exchangeCodeForTokens(
  config: ProviderConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<ProviderTokens> {
  const params: Record<string, string> = {
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  };
  if (config.usesPkce) {
    params.code_verifier = verifier;
  }
  const json = await tokenRequest(config, "Token exchange", params);
  if (config.requiresRefreshTokenOnExchange && !json.refresh_token) {
    throw new OAuthError(`No refresh_token returned by ${config.displayName} (re-consent may be required)`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    idToken: json.id_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    refreshTokenExpiresAt:
      json.refresh_token_expires_in != null ? Date.now() + json.refresh_token_expires_in * 1000 : undefined,
    scope: json.scope ?? "",
    tokenType: json.token_type ?? "bearer",
  };
}

/**
 * Use a refresh_token to mint a new access_token without user interaction.
 * Providers with rotatesRefreshToken return a NEW refresh_token here (GitHub);
 * others keep the original valid (Google).
 */
export async function refreshTokens(
  config: ProviderConfig,
  refreshToken: string,
): Promise<RefreshedTokens> {
  const json = await tokenRequest(config, "Token refresh", {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
    tokenType: json.token_type,
    idToken: json.id_token,
    refreshToken: json.refresh_token,
    refreshTokenExpiresAt:
      json.refresh_token_expires_in != null ? Date.now() + json.refresh_token_expires_in * 1000 : undefined,
  };
}
