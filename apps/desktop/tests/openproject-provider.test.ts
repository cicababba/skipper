import { describe, it, expect, vi, afterEach } from "vitest";
import { mapOpenProjectUser, mapOpenProjectPatUser } from "../src/auth/providers/openproject";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const meBody = {
  id: 7,
  name: "Ada Lovelace",
  login: "ada",
  email: "ada@op.example.com",
  avatar: "https://op.example.com/avatar/7",
};

describe("mapOpenProjectUser (OAuth)", () => {
  it("maps /api/v3/users/me with a Bearer header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, meBody));
    vi.stubGlobal("fetch", fetchMock);
    await expect(mapOpenProjectUser("tok", "https://op.example.com")).resolves.toEqual({
      provider: "openproject",
      id: "7",
      email: "ada@op.example.com",
      name: "Ada Lovelace",
      avatarUrl: "https://op.example.com/avatar/7",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://op.example.com/api/v3/users/me");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
  });

  it("falls back to login when name is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: 7, login: "ada" })));
    const account = await mapOpenProjectUser("tok", "https://op.example.com");
    expect(account.name).toBe("ada");
  });

  it("throws without an instance URL", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(mapOpenProjectUser("tok")).rejects.toThrow("A valid instance URL is required");
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad" })));
    await expect(mapOpenProjectUser("tok", "https://op.example.com")).rejects.toThrow(
      "OpenProject /users/me failed (401)",
    );
  });

  it("throws when the identity carries no id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { name: "Ada" })));
    await expect(mapOpenProjectUser("tok", "https://op.example.com")).rejects.toThrow(
      "OpenProject /users/me returned no id",
    );
  });
});

describe("mapOpenProjectPatUser (API key)", () => {
  it("sends the API key as HTTP Basic apikey:<pat> and maps the identity", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, meBody));
    vi.stubGlobal("fetch", fetchMock);
    const account = await mapOpenProjectPatUser("secret-key", "https://op.example.com");
    expect(account.id).toBe("7");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("apikey:secret-key").toString("base64")}`,
    );
  });

  it("throws without an instance URL", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(mapOpenProjectPatUser("secret-key")).rejects.toThrow(
      "A valid instance URL is required",
    );
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { message: "nope" })));
    await expect(mapOpenProjectPatUser("secret-key", "https://op.example.com")).rejects.toThrow(
      "OpenProject /users/me failed (403)",
    );
  });
});
