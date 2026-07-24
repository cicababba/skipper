import { ApiError, AuthError, type RateLimit, type TokenProvider } from "./types";

export function parseLinkNext(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

export interface VendorHttpConfig {
  /** "GitHub" | "GitLab" | "Jira" | "Bitbucket" — used in error/auth messages. */
  vendor: string;
  baseHeaders?: Record<string, string>;
  /** reset = epoch seconds; omit → no rate-limit parsing (Jira, Bitbucket). */
  rateLimitHeaders?: { remaining: string; reset: string };
  /** Non-rate-limit error body extractor; defaults to res.text().catch(() => ""). */
  errorDetail?: (res: Response) => Promise<string>;
  /** if-none-match sending + 304 short-circuit (GitHub only). */
  supportsEtag?: boolean;
}

export interface CoreResponse<T> {
  status: 200 | 304; // any 2xx collapses to 200
  body?: T; // undefined on 304
  etag?: string; // only when supportsEtag
  nextUrl?: string; // Link rel="next"
  rateLimit?: RateLimit;
}

function parseRateLimit(res: Response, headers: VendorHttpConfig["rateLimitHeaders"]): RateLimit | undefined {
  if (!headers) return undefined;
  const remaining = res.headers.get(headers.remaining);
  const reset = res.headers.get(headers.reset);
  if (remaining == null || reset == null) return undefined;
  return {
    remaining: Number(remaining),
    resetAt: new Date(Number(reset) * 1000).toISOString(),
  };
}

export async function vendorRequest<T>(
  config: VendorHttpConfig,
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  getToken: TokenProvider,
  opts?: { etag?: string; body?: unknown },
): Promise<CoreResponse<T>> {
  const { vendor } = config;

  const doFetch = async (token: string) => {
    const headers: Record<string, string> = {
      ...config.baseHeaders,
      authorization: `Bearer ${token}`,
    };
    if (config.supportsEtag && opts?.etag) headers["if-none-match"] = opts.etag;
    if (opts?.body !== undefined) headers["content-type"] = "application/json";
    return fetch(url, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  };

  const token = await getToken();
  if (!token) throw new AuthError(`no ${vendor} token available`);

  let res = await doFetch(token);
  if (res.status === 401) {
    const fresh = await getToken(true);
    if (!fresh) throw new AuthError(`no ${vendor} token available after refresh`);
    res = await doFetch(fresh);
    if (res.status === 401) {
      throw new AuthError(`${vendor} rejected the token (401) — re-authentication needed`);
    }
  }

  const rateLimit = parseRateLimit(res, config.rateLimitHeaders);

  if (config.supportsEtag && res.status === 304) {
    return { status: 304, etag: res.headers.get("etag") ?? opts?.etag, rateLimit };
  }

  const retryAfterHeader = res.headers.get("retry-after");
  const isRateLimited =
    res.status === 429 ||
    (res.status === 403 && (retryAfterHeader != null || rateLimit?.remaining === 0));
  if (isRateLimited) {
    const retryAfterSeconds =
      retryAfterHeader != null
        ? Number(retryAfterHeader)
        : rateLimit?.remaining === 0
          ? Math.max(0, Math.ceil((Date.parse(rateLimit.resetAt) - Date.now()) / 1000))
          : undefined;
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `${vendor} rate limited (${res.status}): ${text}`,
      res.status,
      rateLimit,
      retryAfterSeconds,
    );
  }

  if (!res.ok) {
    const detail = config.errorDetail
      ? await config.errorDetail(res)
      : await res.text().catch(() => "");
    throw new ApiError(`${vendor} API error: ${res.status} ${detail}`, res.status, rateLimit);
  }

  return {
    status: 200,
    body: (await res.json()) as T,
    etag: config.supportsEtag ? (res.headers.get("etag") ?? undefined) : undefined,
    nextUrl: parseLinkNext(res.headers.get("link")),
    rateLimit,
  };
}

/** Drains a Link-header paginated endpoint into a flat array. `pick` extracts the
 *  items from each page body (defaults to treating the body as the item array). */
export async function drainLinkPages<Item>(
  firstUrl: string,
  getPage: (url: string) => Promise<{ body?: unknown; nextUrl?: string }>,
  pick: (body: unknown) => Item[] = (b) => (b as Item[] | undefined) ?? [],
): Promise<Item[]> {
  const out: Item[] = [];
  let url: string | undefined = firstUrl;
  while (url) {
    const page = await getPage(url);
    if (page.body !== undefined) out.push(...pick(page.body));
    url = page.nextUrl;
  }
  return out;
}
