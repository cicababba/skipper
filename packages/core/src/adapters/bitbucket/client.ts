import { ApiError, AuthError } from "../types";
import type { BitbucketTokenProvider } from "./types";

interface BitbucketPage<T> {
  values?: T[];
  next?: string;
}

/** Pulls the human-readable message out of Bitbucket's error envelope
 *  ({"error":{"message","fields"}}), appending the field detail (duplicate-PR
 *  reasons live there) — falls back to the raw body when it isn't that shape. */
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; fields?: unknown } };
    const message = parsed.error?.message;
    if (message) {
      return parsed.error?.fields ? `${message} ${JSON.stringify(parsed.error.fields)}` : message;
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  return text;
}

async function bitbucketRequest<T>(
  method: "GET" | "POST",
  url: string,
  getToken: BitbucketTokenProvider,
  body?: unknown,
): Promise<T> {
  const doFetch = async (token: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  const token = await getToken();
  if (!token) throw new AuthError("no Bitbucket token available");

  let res = await doFetch(token);
  if (res.status === 401) {
    const fresh = await getToken(true);
    if (!fresh) throw new AuthError("no Bitbucket token available after refresh");
    res = await doFetch(fresh);
    if (res.status === 401) {
      throw new AuthError("Bitbucket rejected the token (401) — re-authentication needed");
    }
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const retryAfterSeconds = retryAfter != null ? Number(retryAfter) : undefined;
    const text = await res.text().catch(() => "");
    throw new ApiError(`Bitbucket rate limited (429): ${text}`, 429, undefined, retryAfterSeconds);
  }

  if (!res.ok) {
    throw new ApiError(`Bitbucket API error: ${res.status} ${await errorDetail(res)}`, res.status);
  }

  return (await res.json()) as T;
}

export async function bitbucketGet<T>(url: string, getToken: BitbucketTokenProvider): Promise<T> {
  return bitbucketRequest<T>("GET", url, getToken);
}

export async function bitbucketPost<T>(
  url: string,
  getToken: BitbucketTokenProvider,
  body: unknown,
): Promise<T> {
  return bitbucketRequest<T>("POST", url, getToken, body);
}

/** Walks Bitbucket's JSON-body pagination ({values, next}) until `next` is absent. */
export async function bitbucketPaginate<T>(
  url: string,
  getToken: BitbucketTokenProvider,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const page: BitbucketPage<T> = await bitbucketGet<BitbucketPage<T>>(next, getToken);
    out.push(...(page.values ?? []));
    next = page.next;
  }
  return out;
}
