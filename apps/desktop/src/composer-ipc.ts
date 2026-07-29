import type { IpcMain } from "electron";
import {
  GITHUB_API_BASE_URL,
  type Account,
  type ComposerDraft,
  type ComposerEditedFlags,
  type ComposerSelfLogin,
  type RepoRef,
} from "@skipper/shared";
import {
  cancelComposerChat,
  disposeComposerChat,
  generateComposerDraft,
  getComposerChat,
  sendComposerChatMessage,
  startComposerChat,
  updateComposerDraft,
} from "./composer-chat";

// Chat composer IPC (#136). Guards (repo linked, busy, unknown chat) live in
// composer-chat.ts; this module is the Electron seam plus the one piece of
// account plumbing the composer needs on its own — the provider username behind
// the self-assign toggle. Deps are injected so the handlers are testable
// without a live Electron main.

export interface ComposerIpcDeps {
  ipcMain: IpcMain;
  getAccounts: () => Account[];
  getToken: (accountKey: string, forceRefresh?: boolean) => Promise<string | null>;
}

/** Logins resolved the slow way, kept for the session — a legacy account's
 *  username does not change under us. */
const loginCache = new Map<string, string>();

/** Test seam: the module-level cache would otherwise leak between cases. */
export function clearSelfLoginCache(): void {
  loginCache.clear();
}

/**
 * The account's provider username. Accounts connected from #136 on carry it;
 * older GitHub accounts only stored `name`, so it is fetched once from /user.
 * Any failure (offline, non-GitHub provider, revoked token) resolves to an
 * absent login — creation then proceeds unassigned with an inline notice.
 */
async function resolveSelfLogin(deps: ComposerIpcDeps, accountId: string): Promise<ComposerSelfLogin> {
  const account = deps.getAccounts().find((a) => a.key === accountId);
  if (!account) return {};
  if (account.login) return { login: account.login };
  const cached = loginCache.get(accountId);
  if (cached) return { login: cached };
  if (account.provider !== "github") return {};
  try {
    const token = await deps.getToken(accountId);
    if (!token) return {};
    const res = await fetch(`${account.baseUrl ?? GITHUB_API_BASE_URL}/user`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return {};
    const json = (await res.json()) as { login?: string };
    if (!json.login) return {};
    loginCache.set(accountId, json.login);
    return { login: json.login };
  } catch {
    return {};
  }
}

export function registerComposerHandlers(deps: ComposerIpcDeps): void {
  deps.ipcMain.handle("skipper:composer:start", (_e, repo: RepoRef) => startComposerChat(repo));
  deps.ipcMain.handle("skipper:composer:send", (_e, repo: RepoRef, chatId: string, text: string) =>
    sendComposerChatMessage(repo, chatId, text),
  );
  deps.ipcMain.handle("skipper:composer:getChat", (_e, repo: RepoRef, chatId: string) =>
    getComposerChat(repo, chatId),
  );
  deps.ipcMain.handle("skipper:composer:generateDraft", (_e, repo: RepoRef, chatId: string) =>
    generateComposerDraft(repo, chatId),
  );
  deps.ipcMain.handle(
    "skipper:composer:updateDraft",
    (_e, repo: RepoRef, chatId: string, draft: ComposerDraft, editedFlags: ComposerEditedFlags) =>
      updateComposerDraft(repo, chatId, draft, editedFlags),
  );
  deps.ipcMain.handle("skipper:composer:cancel", (_e, repo: RepoRef, chatId: string) => {
    cancelComposerChat(repo, chatId);
  });
  deps.ipcMain.handle("skipper:composer:dispose", (_e, repo: RepoRef, chatId: string) => {
    disposeComposerChat(repo, chatId);
  });
  deps.ipcMain.handle("skipper:composer:getSelfLogin", (_e, accountId: string) =>
    resolveSelfLogin(deps, accountId),
  );
}
