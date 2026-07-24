import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlanChatText } from "@skipper/shared";
import {
  appendPlanChatApplied,
  appendPlanChatExchange,
  deletePlanChat,
  readPlanChat,
} from "./plan-chat-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-plan-chat-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("plan-chat-store (#145)", () => {
  it("round-trips an appended exchange", async () => {
    await appendPlanChatExchange(dir, "github:1", "2026-07-21T00:00:00.000Z", "hi", "hello");
    const chat = await readPlanChat(dir, "github:1");
    expect(chat?.version).toBe(1);
    expect(chat?.planGeneratedAt).toBe("2026-07-21T00:00:00.000Z");
    expect(chat?.messages.filter(isPlanChatText).map((m) => [m.role, m.text])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
  });

  it("accumulates exchanges for the same plan generation", async () => {
    await appendPlanChatExchange(dir, "github:1", "gen-a", "q1", "a1");
    await appendPlanChatExchange(dir, "github:1", "gen-a", "q2", "a2");
    const chat = await readPlanChat(dir, "github:1");
    expect(chat?.messages).toHaveLength(4);
  });

  it("discards a stale transcript when planGeneratedAt changes", async () => {
    await appendPlanChatExchange(dir, "github:1", "gen-a", "q1", "a1");
    await appendPlanChatExchange(dir, "github:1", "gen-b", "q2", "a2");
    const chat = await readPlanChat(dir, "github:1");
    expect(chat?.planGeneratedAt).toBe("gen-b");
    expect(chat?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual(["q2", "a2"]);
  });

  it("delete is idempotent", async () => {
    await appendPlanChatExchange(dir, "github:1", "gen-a", "q", "a");
    await deletePlanChat(dir, "github:1");
    await deletePlanChat(dir, "github:1");
    expect(await readPlanChat(dir, "github:1")).toBeNull();
  });

  it("returns null for a corrupt file", async () => {
    await mkdir(join(dir, "chat"), { recursive: true });
    await writeFile(join(dir, "chat", "github_1.json"), "{ not json", "utf-8");
    expect(await readPlanChat(dir, "github:1")).toBeNull();
  });
});

describe("appendPlanChatApplied (#201)", () => {
  it("appends an applied marker preserving prior exchanges", async () => {
    await appendPlanChatExchange(dir, "github:1", "gen-a", "q1", "a1");
    await appendPlanChatApplied(dir, "github:1", "gen-a", 3);
    const chat = await readPlanChat(dir, "github:1");
    expect(chat?.messages).toHaveLength(3);
    expect(chat?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual(["q1", "a1"]);
    const marker = chat?.messages[2];
    expect(isPlanChatText(marker!)).toBe(false);
    expect(marker).toMatchObject({ kind: "applied", changeCount: 3 });
    expect(typeof (marker as { at: string }).at).toBe("string");
  });

  it("starts a fresh transcript when planGeneratedAt differs", async () => {
    await appendPlanChatExchange(dir, "github:1", "gen-a", "q1", "a1");
    await appendPlanChatApplied(dir, "github:1", "gen-b", 1);
    const chat = await readPlanChat(dir, "github:1");
    expect(chat?.planGeneratedAt).toBe("gen-b");
    expect(chat?.messages).toHaveLength(1);
    expect(chat?.messages[0]).toMatchObject({ kind: "applied", changeCount: 1 });
  });

  it("round-trips a marker-only transcript through readPlanChat", async () => {
    const written = await appendPlanChatApplied(dir, "github:1", "gen-a", 2);
    const read = await readPlanChat(dir, "github:1");
    expect(read).toEqual(written);
  });
});
