import { describe, it, expect, vi, afterEach } from "vitest";
import { mapBitbucketUser } from "../src/auth/providers/bitbucket";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapBitbucketUser", () => {
  it("maps /user with the primary confirmed email", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/user/emails")) {
        return jsonResponse(200, {
          values: [
            { email: "secondary@example.com", is_primary: false, is_confirmed: true },
            { email: "primary@example.com", is_primary: true, is_confirmed: true },
          ],
        });
      }
      return jsonResponse(200, {
        uuid: "{a1b2}",
        account_id: "acc-1",
        display_name: "Ada Lovelace",
        nickname: "ada",
        links: { avatar: { href: "https://avatars/ada" } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(mapBitbucketUser("tok")).resolves.toEqual({
      provider: "bitbucket",
      id: "{a1b2}",
      email: "primary@example.com",
      name: "Ada Lovelace",
      avatarUrl: "https://avatars/ada",
    });
  });

  it("ignores emails that are not both primary and confirmed", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/user/emails")) {
        return jsonResponse(200, {
          values: [
            { email: "primary-unconfirmed@example.com", is_primary: true, is_confirmed: false },
            { email: "confirmed-secondary@example.com", is_primary: false, is_confirmed: true },
          ],
        });
      }
      return jsonResponse(200, { uuid: "{a1b2}", display_name: "Ada" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const account = await mapBitbucketUser("tok");
    expect(account.email).toBeUndefined();
  });

  it("falls back to nickname when display_name is absent", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/user/emails")) {
        return jsonResponse(200, { values: [] });
      }
      return jsonResponse(200, { uuid: "{a1b2}", nickname: "ada" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const account = await mapBitbucketUser("tok");
    expect(account.name).toBe("ada");
  });

  it("leaves email undefined when the emails call is non-OK", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/user/emails")) {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, { uuid: "{a1b2}", display_name: "Ada" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const account = await mapBitbucketUser("tok");
    expect(account.email).toBeUndefined();
  });

  it("throws on a /user failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "bad token" })));
    await expect(mapBitbucketUser("tok")).rejects.toThrow("Bitbucket /user failed (401)");
  });

  it("throws when /user returns no uuid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { display_name: "Ada" })));
    await expect(mapBitbucketUser("tok")).rejects.toThrow("Bitbucket /user returned no uuid");
  });
});
