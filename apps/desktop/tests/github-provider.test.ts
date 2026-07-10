import { describe, it, expect, vi, afterEach } from "vitest";
import { mapGitHubUser } from "../src/auth/providers/github";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapGitHubUser", () => {
  it("maps /user with a public email", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(200, {
        id: 42,
        login: "octo",
        name: "Octo Cat",
        email: "octo@example.com",
        avatar_url: "https://avatars/42",
      }),
    ));
    await expect(mapGitHubUser("tok")).resolves.toEqual({
      provider: "github",
      id: "42",
      email: "octo@example.com",
      name: "Octo Cat",
      avatarUrl: "https://avatars/42",
    });
  });

  it("falls back to /user/emails when the public email is null", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/user/emails")) {
        return jsonResponse(200, [
          { email: "secondary@example.com", primary: false, verified: true },
          { email: "primary@example.com", primary: true, verified: true },
        ]);
      }
      return jsonResponse(200, { id: 42, login: "octo", name: null, email: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    const account = await mapGitHubUser("tok");
    expect(account.email).toBe("primary@example.com");
    expect(account.name).toBe("octo");
  });

  it("leaves email undefined when the emails call fails", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/user/emails")) {
        return jsonResponse(403, { message: "forbidden" });
      }
      return jsonResponse(200, { id: 42, login: "octo", name: null, email: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    const account = await mapGitHubUser("tok");
    expect(account.email).toBeUndefined();
  });

  it("throws on a /user failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad token" })));
    await expect(mapGitHubUser("tok")).rejects.toThrow("GitHub /user failed (401)");
  });
});
