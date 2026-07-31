import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodingEventEnvelope } from "@skipper/shared";
import type { EventStream } from "./event-stream";
import {
  applyPlanChatUpdate,
  cancelPlanChat,
  getPlanChatHistory,
  sendPlanChatMessage,
} from "./plan-chat";
import {
  cancelAgentChat,
  confirmCoderChatApply,
  getAgentChatHistory,
  prepareCoderChatApply,
  sendAgentChatMessage,
} from "./agent-chat";
import { startRescore } from "./rescore";
import { registerChatHandlers, type ChatIpcDeps } from "./chat-ipc";

vi.mock("./plan-chat", () => ({
  applyPlanChatUpdate: vi.fn(async () => ({ ok: false as const, error: "no" })),
  cancelPlanChat: vi.fn(),
  getPlanChatHistory: vi.fn(() => []),
  sendPlanChatMessage: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("./agent-chat", () => ({
  cancelAgentChat: vi.fn(),
  confirmCoderChatApply: vi.fn(async () => ({ ok: true as const })),
  getAgentChatHistory: vi.fn(() => []),
  prepareCoderChatApply: vi.fn(async () => ({ ok: true as const })),
  sendAgentChatMessage: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("./rescore", () => ({ startRescore: vi.fn() }));

const applyPlanChatUpdateMock = vi.mocked(applyPlanChatUpdate);
const cancelPlanChatMock = vi.mocked(cancelPlanChat);
const getPlanChatHistoryMock = vi.mocked(getPlanChatHistory);
const sendPlanChatMessageMock = vi.mocked(sendPlanChatMessage);
const cancelAgentChatMock = vi.mocked(cancelAgentChat);
const confirmCoderChatApplyMock = vi.mocked(confirmCoderChatApply);
const getAgentChatHistoryMock = vi.mocked(getAgentChatHistory);
const prepareCoderChatApplyMock = vi.mocked(prepareCoderChatApply);
const sendAgentChatMessageMock = vi.mocked(sendAgentChatMessage);
const startRescoreMock = vi.mocked(startRescore);

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function stream(tag: string): EventStream {
  return {
    emit: vi.fn(),
    getEvents: vi.fn((itemId: string) => [
      { tag, itemId } as unknown as CodingEventEnvelope,
    ]),
  };
}

function setup() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const streams = {
    codingStream: stream("coding"),
    planningStream: stream("planning"),
    reviewStream: stream("review"),
    composerStream: stream("composer"),
  };
  registerChatHandlers({
    ipcMain: ipcMain as unknown as ChatIpcDeps["ipcMain"],
    ...streams,
  });
  return { handlers, ...streams };
}

function handlerOf(handlers: Map<string, Handler>, channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  applyPlanChatUpdateMock.mockResolvedValue({ ok: false, error: "no" } as never);
  getPlanChatHistoryMock.mockReturnValue([] as never);
  getAgentChatHistoryMock.mockReturnValue([] as never);
});

describe("registerChatHandlers", () => {
  it("registers all thirteen chat and replay channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      "skipper:agentChat:cancel",
      "skipper:agentChat:confirmApply",
      "skipper:agentChat:getHistory",
      "skipper:agentChat:prepareApply",
      "skipper:agentChat:send",
      "skipper:coding:getEvents",
      "skipper:composer:getEvents",
      "skipper:planChat:apply",
      "skipper:planChat:cancel",
      "skipper:planChat:getHistory",
      "skipper:planning:getEvents",
      "skipper:planChat:send",
      "skipper:review:getEvents",
    ].sort());
  });
});

describe("planChat", () => {
  it("forwards send to the chat module", async () => {
    const { handlers } = setup();
    await handlerOf(handlers, "skipper:planChat:send")(null, "github:1", "tighten step 2");
    expect(sendPlanChatMessageMock).toHaveBeenCalledWith("github:1", "tighten step 2");
  });

  it("rescores only when apply succeeded", async () => {
    const { handlers } = setup();
    const apply = handlerOf(handlers, "skipper:planChat:apply");

    await apply(null, "github:1");
    expect(startRescoreMock).not.toHaveBeenCalled();

    applyPlanChatUpdateMock.mockResolvedValue({
      ok: true,
      stored: { ref: "plan.json" },
    } as never);
    const res = await apply(null, "github:1");
    expect(res).toMatchObject({ ok: true });
    expect(startRescoreMock).toHaveBeenCalledWith("github:1", { ref: "plan.json" });
  });

  it("forwards getHistory and cancel", async () => {
    const { handlers } = setup();
    await handlerOf(handlers, "skipper:planChat:getHistory")(null, "github:1");
    expect(getPlanChatHistoryMock).toHaveBeenCalledWith("github:1");
    await handlerOf(handlers, "skipper:planChat:cancel")(null, "github:1");
    expect(cancelPlanChatMock).toHaveBeenCalledWith("github:1");
  });
});

describe("agentChat kind guard (#170)", () => {
  it("refuses send for an invalid kind without reaching the chat module", async () => {
    const { handlers } = setup();
    const res = await handlerOf(handlers, "skipper:agentChat:send")(
      null,
      "planner",
      "github:1",
      "hi",
    );
    expect(res).toEqual({ ok: false, error: "invalid chat kind planner" });
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
  });

  it("passes coder and reviewer through with the context", async () => {
    const { handlers } = setup();
    const send = handlerOf(handlers, "skipper:agentChat:send");
    await send(null, "coder", "github:1", "why", { selectedFile: "src/a.ts" });
    await send(null, "reviewer", "github:1", "why");
    expect(sendAgentChatMessageMock).toHaveBeenNthCalledWith(1, "coder", "github:1", "why", {
      selectedFile: "src/a.ts",
    });
    expect(sendAgentChatMessageMock).toHaveBeenNthCalledWith(
      2,
      "reviewer",
      "github:1",
      "why",
      undefined,
    );
  });

  it("returns an empty history for an invalid kind", async () => {
    const { handlers } = setup();
    const res = await handlerOf(handlers, "skipper:agentChat:getHistory")(null, "nope", "github:1");
    expect(res).toEqual([]);
    expect(getAgentChatHistoryMock).not.toHaveBeenCalled();
  });

  it("no-ops cancel for an invalid kind", async () => {
    const { handlers } = setup();
    const res = await handlerOf(handlers, "skipper:agentChat:cancel")(null, "nope", "github:1");
    expect(res).toBeUndefined();
    expect(cancelAgentChatMock).not.toHaveBeenCalled();
  });

  it("cancels for a valid kind", async () => {
    const { handlers } = setup();
    await handlerOf(handlers, "skipper:agentChat:cancel")(null, "coder", "github:1");
    expect(cancelAgentChatMock).toHaveBeenCalledWith("coder", "github:1");
  });
});

describe("coder-chat apply (#188)", () => {
  it("forwards prepareApply and confirmApply", async () => {
    const { handlers } = setup();
    await handlerOf(handlers, "skipper:agentChat:prepareApply")(null, "github:1");
    expect(prepareCoderChatApplyMock).toHaveBeenCalledWith("github:1");

    const instructions = [{ path: "src/a.ts", body: "rename it" }];
    await handlerOf(handlers, "skipper:agentChat:confirmApply")(null, "github:1", instructions);
    expect(confirmCoderChatApplyMock).toHaveBeenCalledWith("github:1", instructions);
  });
});

describe("event replay", () => {
  it("routes each channel to its own stream", async () => {
    const h = setup();
    expect(await handlerOf(h.handlers, "skipper:coding:getEvents")(null, "github:1")).toEqual([
      { tag: "coding", itemId: "github:1" },
    ]);
    expect(await handlerOf(h.handlers, "skipper:planning:getEvents")(null, "github:1")).toEqual([
      { tag: "planning", itemId: "github:1" },
    ]);
    expect(await handlerOf(h.handlers, "skipper:review:getEvents")(null, "github:1")).toEqual([
      { tag: "review", itemId: "github:1" },
    ]);
    // The composer keys by `${repoKey}:${chatId}` — it has no item.
    expect(
      await handlerOf(h.handlers, "skipper:composer:getEvents")(null, "acme/widgets:chat-1"),
    ).toEqual([{ tag: "composer", itemId: "acme/widgets:chat-1" }]);
    expect(h.codingStream.getEvents).toHaveBeenCalledTimes(1);
    expect(h.planningStream.getEvents).toHaveBeenCalledTimes(1);
  });
});
