import { vendorRequest, type VendorHttpConfig } from "../http";
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

const CONFIG: VendorHttpConfig = {
  vendor: "Bitbucket",
  errorDetail,
};

async function bitbucketRequest<T>(
  method: "GET" | "POST",
  url: string,
  getToken: BitbucketTokenProvider,
  body?: unknown,
): Promise<T> {
  return (await vendorRequest<T>(CONFIG, method, url, getToken, { body })).body as T;
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
