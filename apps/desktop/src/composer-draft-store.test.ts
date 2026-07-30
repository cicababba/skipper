import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredComposerDraft } from "@skipper/shared";
import {
  deleteComposerDraftFile,
  deleteUnfinishedDraftFiles,
  deleteUnfinishedDraftFilesSync,
  draftFileName,
  draftFilePath,
  listComposerDrafts,
  readComposerDraftFile,
  saveComposerDraftFile,
  saveComposerDraftFileSync,
} from "./composer-draft-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sk-drafts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeDraft(over: Partial<StoredComposerDraft> = {}): StoredComposerDraft {
  return {
    version: 1,
    draftId: "draft-1",
    repo: { owner: "acme", name: "widgets" },
    chatId: "draft-1",
    title: "web:feat: rate-limit the webhook",
    messages: [{ role: "user", text: "rate-limit it", at: "2026-07-25T10:00:00.000Z" }],
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T10:00:00.000Z",
    ...over,
  };
}

describe("draftFileName", () => {
  it("keeps a uuid-shaped id intact", () => {
    expect(draftFileName("6f1c2e40-0d2a-4a44-9b0e-3c1a2f5c7d88")).toBe(
      "6f1c2e40-0d2a-4a44-9b0e-3c1a2f5c7d88.json",
    );
  });

  it("replaces every character that is illegal in a filename", () => {
    expect(draftFileName("acme/widgets:chat 1*?")).toBe("acme_widgets_chat_1__.json");
  });

  it("cannot escape the directory through the id", () => {
    expect(draftFilePath(dir, "../../etc/passwd")).toBe(join(dir, ".._.._etc_passwd.json"));
  });
});

describe("saveComposerDraftFile / readComposerDraftFile", () => {
  it("round-trips a draft, session lineage included", async () => {
    const draft = makeDraft({
      sessionId: "sess-a",
      sessionRuntime: "claude-cli",
      draft: {
        issues: [{ title: "one", body: "b", acceptanceCriteria: ["works"], labels: ["web"] }],
        relations: [],
      },
      editedFlags: { 0: ["title"] },
    });
    await saveComposerDraftFile(dir, draft);
    expect(await readComposerDraftFile(dir, "draft-1")).toEqual(draft);
  });

  it("overwrites the same file instead of forking a second one", async () => {
    await saveComposerDraftFile(dir, makeDraft());
    await saveComposerDraftFile(dir, makeDraft({ title: "a better title" }));
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toEqual(["draft-1.json"]);
    expect((await readComposerDraftFile(dir, "draft-1"))?.title).toBe("a better title");
  });

  it("leaves no temp file behind", async () => {
    await saveComposerDraftFile(dir, makeDraft());
    expect((await readdir(dir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("serializes concurrent saves so the last one wins", async () => {
    await Promise.all([
      saveComposerDraftFile(dir, makeDraft({ title: "first" })),
      saveComposerDraftFile(dir, makeDraft({ title: "second" })),
      saveComposerDraftFile(dir, makeDraft({ title: "third" })),
    ]);
    expect((await readComposerDraftFile(dir, "draft-1"))?.title).toBe("third");
  });

  it("returns null for a missing draft", async () => {
    expect(await readComposerDraftFile(dir, "nope")).toBeNull();
  });

  it("returns null for unparseable json", async () => {
    await writeFile(join(dir, "broken.json"), "{ not json", "utf-8");
    expect(await readComposerDraftFile(dir, "broken")).toBeNull();
  });

  it("gates on the version", async () => {
    await writeFile(join(dir, "future.json"), JSON.stringify({ ...makeDraft(), version: 2 }), "utf-8");
    expect(await readComposerDraftFile(dir, "future")).toBeNull();
  });
});

// The quit path (#272) writes outside the async queue: same bytes, same atomicity.
describe("saveComposerDraftFileSync", () => {
  it("round-trips a draft the async reader can pick up", async () => {
    const draft = makeDraft({ unfinished: true });
    saveComposerDraftFileSync(dir, draft);
    expect(await readComposerDraftFile(dir, "draft-1")).toEqual(draft);
  });

  it("leaves no temp file behind", async () => {
    saveComposerDraftFileSync(dir, makeDraft());
    expect((await readdir(dir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("creates the drafts directory on first write", async () => {
    const fresh = join(dir, "never-created");
    saveComposerDraftFileSync(fresh, makeDraft());
    expect((await readComposerDraftFile(fresh, "draft-1"))?.draftId).toBe("draft-1");
  });
});

describe("deleteUnfinishedDraftFiles", () => {
  async function seed(): Promise<void> {
    await saveComposerDraftFile(dir, makeDraft({ draftId: "u1", chatId: "u1", unfinished: true }));
    await saveComposerDraftFile(dir, makeDraft({ draftId: "u2", chatId: "u2", unfinished: true }));
    await saveComposerDraftFile(dir, makeDraft({ draftId: "explicit", chatId: "explicit" }));
    await saveComposerDraftFile(
      dir,
      makeDraft({
        draftId: "other-repo",
        chatId: "other-repo",
        unfinished: true,
        repo: { owner: "acme", name: "rocket" },
      }),
    );
  }

  it("drops the repo's other unfinished drafts and nothing else", async () => {
    await seed();
    expect(await deleteUnfinishedDraftFiles(dir, "acme/widgets", new Set(["u2"]))).toBe(true);
    expect(await readComposerDraftFile(dir, "u1")).toBeNull();
    expect(await readComposerDraftFile(dir, "u2")).not.toBeNull();
    expect(await readComposerDraftFile(dir, "explicit")).not.toBeNull();
    expect(await readComposerDraftFile(dir, "other-repo")).not.toBeNull();
  });

  it("deletes nothing when every unfinished draft is on the keep list", async () => {
    await seed();
    expect(await deleteUnfinishedDraftFiles(dir, "acme/widgets", new Set(["u1", "u2"]))).toBe(false);
    expect(await readComposerDraftFile(dir, "u1")).not.toBeNull();
  });

  it("matches the repo the way repoKey does, case included", async () => {
    await saveComposerDraftFile(
      dir,
      makeDraft({
        draftId: "mixed",
        chatId: "mixed",
        unfinished: true,
        repo: { owner: "Acme", name: "Widgets" },
      }),
    );
    expect(await deleteUnfinishedDraftFiles(dir, "acme/widgets", new Set())).toBe(true);
    expect(await readComposerDraftFile(dir, "mixed")).toBeNull();
  });

  it("reports nothing deleted when the directory does not exist", async () => {
    expect(
      await deleteUnfinishedDraftFiles(join(dir, "never-created"), "acme/widgets", new Set()),
    ).toBe(false);
  });

  it("sync twin honours the same flag, repo and keep rules", async () => {
    await seed();
    expect(deleteUnfinishedDraftFilesSync(dir, "acme/widgets", new Set(["u2"]))).toBe(true);
    expect(await readComposerDraftFile(dir, "u1")).toBeNull();
    expect(await readComposerDraftFile(dir, "u2")).not.toBeNull();
    expect(await readComposerDraftFile(dir, "explicit")).not.toBeNull();
    expect(await readComposerDraftFile(dir, "other-repo")).not.toBeNull();
    expect(deleteUnfinishedDraftFilesSync(join(dir, "never-created"), "acme/widgets", new Set())).toBe(
      false,
    );
  });
});

describe("deleteComposerDraftFile", () => {
  it("removes the file and reports it", async () => {
    await saveComposerDraftFile(dir, makeDraft());
    expect(await deleteComposerDraftFile(dir, "draft-1")).toBe(true);
    expect(await readComposerDraftFile(dir, "draft-1")).toBeNull();
  });

  it("reports a miss instead of throwing", async () => {
    expect(await deleteComposerDraftFile(dir, "never-existed")).toBe(false);
  });
});

describe("listComposerDrafts", () => {
  it("projects each draft to its list shape", async () => {
    await saveComposerDraftFile(dir, makeDraft());
    expect(await listComposerDrafts(dir)).toEqual([
      {
        draftId: "draft-1",
        repo: { owner: "acme", name: "widgets" },
        title: "web:feat: rate-limit the webhook",
        updatedAt: "2026-07-25T10:00:00.000Z",
      },
    ]);
  });

  // The list is what /drafts renders: the tag comes from the flag, the mode the
  // Resume link opens comes from the absence of a transcript (#272).
  it("flags an unfinished draft and infers the quick shape from an empty transcript", async () => {
    await saveComposerDraftFile(
      dir,
      makeDraft({ draftId: "quick", chatId: "quick", unfinished: true, messages: [] }),
    );
    expect(await listComposerDrafts(dir)).toEqual([
      {
        draftId: "quick",
        repo: { owner: "acme", name: "widgets" },
        title: "web:feat: rate-limit the webhook",
        updatedAt: "2026-07-25T10:00:00.000Z",
        unfinished: true,
        quick: true,
      },
    ]);
  });

  it("keeps an unfinished chat draft out of the quick bucket", async () => {
    await saveComposerDraftFile(dir, makeDraft({ unfinished: true }));
    const [item] = await listComposerDrafts(dir);
    expect(item.unfinished).toBe(true);
    expect(item.quick).toBeUndefined();
  });

  it("sorts by updatedAt, most recently touched first", async () => {
    await saveComposerDraftFile(
      dir,
      makeDraft({ draftId: "old", chatId: "old", updatedAt: "2026-07-20T09:00:00.000Z" }),
    );
    await saveComposerDraftFile(
      dir,
      makeDraft({ draftId: "newest", chatId: "newest", updatedAt: "2026-07-28T09:00:00.000Z" }),
    );
    await saveComposerDraftFile(
      dir,
      makeDraft({ draftId: "middle", chatId: "middle", updatedAt: "2026-07-24T09:00:00.000Z" }),
    );
    expect((await listComposerDrafts(dir)).map((d) => d.draftId)).toEqual([
      "newest",
      "middle",
      "old",
    ]);
  });

  it("skips unreadable and wrong-version files instead of failing the list", async () => {
    await saveComposerDraftFile(dir, makeDraft());
    await writeFile(join(dir, "broken.json"), "{ not json", "utf-8");
    await writeFile(join(dir, "v2.json"), JSON.stringify({ ...makeDraft(), version: 9 }), "utf-8");
    await writeFile(join(dir, "notes.txt"), "ignored", "utf-8");
    expect((await listComposerDrafts(dir)).map((d) => d.draftId)).toEqual(["draft-1"]);
  });

  it("is empty when the directory does not exist yet", async () => {
    expect(await listComposerDrafts(join(dir, "never-created"))).toEqual([]);
  });
});
