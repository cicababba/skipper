import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlanChatText } from "@skipper/shared";
import {
  appendAgentChatExchange,
  deleteAgentChat,
  deleteAgentChats,
  readAgentChat,
  setAgentChatSessionId,
} from "./agent-chat-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-agent-chat-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("agent-chat-store (#170)", () => {
  it("round-trips an appended exchange", async () => {
    await appendAgentChatExchange(dir, "coder", "github:1", "/wt/1", "hi", "hello");
    const chat = await readAgentChat(dir, "coder", "github:1");
    expect(chat?.version).toBe(1);
    expect(chat?.kind).toBe("coder");
    expect(chat?.binding).toBe("/wt/1");
    expect(chat?.messages.filter(isPlanChatText).map((m) => [m.role, m.text])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
  });

  it("accumulates exchanges for a matching binding and preserves sessionId", async () => {
    await setAgentChatSessionId(dir, "coder", "github:1", "/wt/1", "sess-fork");
    await appendAgentChatExchange(dir, "coder", "github:1", "/wt/1", "q1", "a1");
    await appendAgentChatExchange(dir, "coder", "github:1", "/wt/1", "q2", "a2");
    const chat = await readAgentChat(dir, "coder", "github:1");
    expect(chat?.messages).toHaveLength(4);
    expect(chat?.sessionId).toBe("sess-fork");
  });

  it("discards a stale transcript (and its sessionId) when the binding changes", async () => {
    await setAgentChatSessionId(dir, "coder", "github:1", "/wt/1", "sess-old");
    await appendAgentChatExchange(dir, "coder", "github:1", "/wt/1", "q1", "a1");
    await appendAgentChatExchange(dir, "coder", "github:1", "/wt/2", "q2", "a2");
    const chat = await readAgentChat(dir, "coder", "github:1");
    expect(chat?.binding).toBe("/wt/2");
    expect(chat?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual(["q2", "a2"]);
    expect(chat?.sessionId).toBeUndefined();
  });

  it("keeps coder and reviewer transcripts in separate files", async () => {
    await appendAgentChatExchange(dir, "coder", "github:1", "/wt/1", "cq", "ca");
    await appendAgentChatExchange(dir, "reviewer", "github:1", "2026-01-01T00:00:00.000Z", "rq", "ra");
    const coder = await readAgentChat(dir, "coder", "github:1");
    const reviewer = await readAgentChat(dir, "reviewer", "github:1");
    expect(coder?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual(["cq", "ca"]);
    expect(reviewer?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual(["rq", "ra"]);
  });

  it("setAgentChatSessionId creates the file when absent", async () => {
    await setAgentChatSessionId(dir, "reviewer", "github:1", "at-1", "sess-1");
    const chat = await readAgentChat(dir, "reviewer", "github:1");
    expect(chat?.sessionId).toBe("sess-1");
    expect(chat?.messages).toEqual([]);
  });

  it("deleteAgentChats removes both kinds", async () => {
    await appendAgentChatExchange(dir, "coder", "github:1", "/wt/1", "q", "a");
    await appendAgentChatExchange(dir, "reviewer", "github:1", "at-1", "q", "a");
    await deleteAgentChats(dir, "github:1");
    expect(await readAgentChat(dir, "coder", "github:1")).toBeNull();
    expect(await readAgentChat(dir, "reviewer", "github:1")).toBeNull();
  });

  it("delete is idempotent", async () => {
    await appendAgentChatExchange(dir, "coder", "github:1", "/wt/1", "q", "a");
    await deleteAgentChat(dir, "coder", "github:1");
    await deleteAgentChat(dir, "coder", "github:1");
    expect(await readAgentChat(dir, "coder", "github:1")).toBeNull();
  });

  it("returns null for a corrupt file", async () => {
    await mkdir(join(dir, "chat"), { recursive: true });
    await writeFile(join(dir, "chat", "github_1.coder.json"), "{ not json", "utf-8");
    expect(await readAgentChat(dir, "coder", "github:1")).toBeNull();
  });
});
