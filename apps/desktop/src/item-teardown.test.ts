import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoRef } from "@skipper/shared";
import { resolveBaseRef, discardWorktree } from "./worktrees";
import { archiveStoredPlan } from "./plan-store";
import { deletePlanChat } from "./plan-chat-store";
import { deleteAgentChats } from "./agent-chat-store";
import { discardItemWorktreeUnderLock, archivePlanAndDeleteChats } from "./item-teardown";

vi.mock("./worktrees", () => ({
  resolveBaseRef: vi.fn(async () => "origin/main"),
  discardWorktree: vi.fn(async () => ({ removed: true, branchDeleted: true })),
}));
vi.mock("./plan-store", () => ({ archiveStoredPlan: vi.fn(async () => "archive/plan.json") }));
vi.mock("./plan-chat-store", () => ({ deletePlanChat: vi.fn(async () => undefined) }));
vi.mock("./agent-chat-store", () => ({ deleteAgentChats: vi.fn(async () => undefined) }));

const resolveBaseRefMock = vi.mocked(resolveBaseRef);
const discardWorktreeMock = vi.mocked(discardWorktree);
const archiveStoredPlanMock = vi.mocked(archiveStoredPlan);
const deletePlanChatMock = vi.mocked(deletePlanChat);
const deleteAgentChatsMock = vi.mocked(deleteAgentChats);

const repo: RepoRef = { owner: "acme", name: "widget" };

beforeEach(() => {
  vi.clearAllMocks();
  resolveBaseRefMock.mockResolvedValue("origin/main");
  discardWorktreeMock.mockResolvedValue({ removed: true, branchDeleted: true });
  archiveStoredPlanMock.mockResolvedValue("archive/plan.json");
  deletePlanChatMock.mockResolvedValue(undefined);
  deleteAgentChatsMock.mockResolvedValue(undefined);
});

describe("discardItemWorktreeUnderLock", () => {
  it("runs the discard inside the injected lock, keyed by the item's repo", async () => {
    const order: string[] = [];
    const lockedRepos: RepoRef[] = [];
    const withRepoGitLock = async <T>(r: RepoRef, fn: () => Promise<T>): Promise<T> => {
      lockedRepos.push(r);
      order.push("lock-enter");
      const result = await fn();
      order.push("lock-exit");
      return result;
    };
    resolveBaseRefMock.mockImplementation(async () => {
      order.push("resolveBaseRef");
      return "origin/main";
    });
    discardWorktreeMock.mockImplementation(async () => {
      order.push("discardWorktree");
      return { removed: true, branchDeleted: true };
    });

    const res = await discardItemWorktreeUnderLock({
      repo,
      localPath: "/repo",
      baseBranch: "main",
      worktreePath: "/wt",
      branch: "feature/x",
      withRepoGitLock,
    });

    expect(res).toEqual({ ok: true });
    expect(lockedRepos).toEqual([repo]);
    expect(order).toEqual(["lock-enter", "resolveBaseRef", "discardWorktree", "lock-exit"]);
  });

  it("resolves the base ref from localPath + baseBranch and passes it to discardWorktree", async () => {
    resolveBaseRefMock.mockResolvedValue("origin/release");
    const withRepoGitLock = <T>(_r: RepoRef, fn: () => Promise<T>) => fn();

    await discardItemWorktreeUnderLock({
      repo,
      localPath: "/repo",
      baseBranch: "release",
      worktreePath: "/wt",
      branch: "feature/x",
      withRepoGitLock,
    });

    expect(resolveBaseRefMock).toHaveBeenCalledWith("/repo", "release");
    expect(discardWorktreeMock).toHaveBeenCalledWith({
      repoPath: "/repo",
      worktreePath: "/wt",
      branch: "feature/x",
      baseRef: "origin/release",
    });
  });

  it("falls back to baseRef undefined when resolveBaseRef rejects", async () => {
    resolveBaseRefMock.mockRejectedValue(new Error("no base"));
    const withRepoGitLock = <T>(_r: RepoRef, fn: () => Promise<T>) => fn();

    const res = await discardItemWorktreeUnderLock({
      repo,
      localPath: "/repo",
      baseBranch: undefined,
      worktreePath: "/wt",
      branch: "feature/x",
      withRepoGitLock,
    });

    expect(res).toEqual({ ok: true });
    expect(discardWorktreeMock).toHaveBeenCalledWith({
      repoPath: "/repo",
      worktreePath: "/wt",
      branch: "feature/x",
      baseRef: undefined,
    });
  });

  it("returns the Error message when discardWorktree throws an Error", async () => {
    discardWorktreeMock.mockRejectedValue(new Error("worktree busy"));
    const withRepoGitLock = <T>(_r: RepoRef, fn: () => Promise<T>) => fn();

    const res = await discardItemWorktreeUnderLock({
      repo,
      localPath: "/repo",
      baseBranch: "main",
      worktreePath: "/wt",
      branch: "feature/x",
      withRepoGitLock,
    });

    expect(res).toEqual({ ok: false, error: "worktree busy" });
  });

  it("stringifies a non-Error throw", async () => {
    discardWorktreeMock.mockRejectedValue("plain string");
    const withRepoGitLock = <T>(_r: RepoRef, fn: () => Promise<T>) => fn();

    const res = await discardItemWorktreeUnderLock({
      repo,
      localPath: "/repo",
      baseBranch: "main",
      worktreePath: "/wt",
      branch: "feature/x",
      withRepoGitLock,
    });

    expect(res).toEqual({ ok: false, error: "plain string" });
  });
});

describe("archivePlanAndDeleteChats", () => {
  it("swaps in the archived ref and preserves the plan's other fields", async () => {
    archiveStoredPlanMock.mockResolvedValue("archive/plan-9.json");
    const plan = { confidence: 0.8, ref: "plans/plan-9.json", sessionId: "s1" };

    const out = await archivePlanAndDeleteChats("/plans", "item-9", plan);

    expect(archiveStoredPlanMock).toHaveBeenCalledWith("/plans", "plans/plan-9.json");
    expect(out).toEqual({ confidence: 0.8, ref: "archive/plan-9.json", sessionId: "s1" });
  });

  it("leaves the plan unchanged when archiveStoredPlan rejects", async () => {
    archiveStoredPlanMock.mockRejectedValue(new Error("nope"));
    const plan = { confidence: 0.8, ref: "plans/plan-9.json" };

    const out = await archivePlanAndDeleteChats("/plans", "item-9", plan);

    expect(out).toEqual(plan);
  });

  it("does not call archiveStoredPlan when the plan has no ref", async () => {
    const plan = { confidence: 0.5 };

    const out = await archivePlanAndDeleteChats("/plans", "item-9", plan);

    expect(archiveStoredPlanMock).not.toHaveBeenCalled();
    expect(out).toEqual(plan);
  });

  it("deletes the plan chat and agent chats with (plansDir, itemId)", async () => {
    await archivePlanAndDeleteChats("/plans", "item-9", undefined);

    expect(deletePlanChatMock).toHaveBeenCalledWith("/plans", "item-9");
    expect(deleteAgentChatsMock).toHaveBeenCalledWith("/plans", "item-9");
  });

  it("does not reject when the chat deletes reject", async () => {
    deletePlanChatMock.mockRejectedValue(new Error("chat gone"));
    deleteAgentChatsMock.mockRejectedValue(new Error("agents gone"));

    await expect(
      archivePlanAndDeleteChats("/plans", "item-9", { ref: "plans/p.json" }),
    ).resolves.toBeDefined();
  });
});
