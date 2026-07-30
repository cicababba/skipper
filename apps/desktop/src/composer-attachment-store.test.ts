import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  assertAttachmentPath,
  attachmentDir,
  attachmentKind,
  deleteAttachmentFile,
  deleteAttachmentsDir,
  deleteAttachmentsDirSync,
  listAttachmentDirs,
  saveAttachmentFile,
} from "./composer-attachment-store";

// The #281 attachment store against a real temp dir — pure Node, no Electron.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sk-attachments-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (text = "hello") => new Uint8Array(Buffer.from(text));

describe("attachmentKind", () => {
  it("classifies the allowed extensions, case-insensitively", () => {
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.gif"]) {
      expect(attachmentKind(name)).toBe("image");
    }
    expect(attachmentKind("spec.pdf")).toBe("pdf");
    expect(attachmentKind("SPEC.PDF")).toBe("pdf");
    for (const name of ["a.txt", "a.md", "a.markdown", "a.csv", "a.json", "a.log", "a.yaml", "a.yml"]) {
      expect(attachmentKind(name)).toBe("text");
    }
  });

  it("rejects everything else, office formats included", () => {
    for (const name of ["a.docx", "a.xlsx", "a.exe", "a.sh", "noextension", "a.png.exe"]) {
      expect(attachmentKind(name)).toBeNull();
    }
  });
});

describe("attachmentDir", () => {
  it("sanitizes the chat id into a single directory name", () => {
    expect(attachmentDir(root, "../../etc")).toBe(join(root, ".._.._etc"));
    expect(attachmentDir(root, "a/b")).toBe(join(root, "a_b"));
    // A real chat id is a UUID and survives untouched.
    const uuid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    expect(attachmentDir(root, uuid)).toBe(join(root, uuid));
  });
});

describe("saveAttachmentFile", () => {
  it("writes the bytes under the chat's own directory", async () => {
    const saved = await saveAttachmentFile(root, "chat-1", "shot.png", bytes("png-data"));
    expect(saved).toMatchObject({ name: "shot.png", kind: "image" });
    expect(saved.path).toBe(join(root, "chat-1", "shot.png"));
    expect(await readFile(saved.path, "utf-8")).toBe("png-data");
  });

  it("sanitizes the file name", async () => {
    const saved = await saveAttachmentFile(root, "chat-1", "../my shot (1).png", bytes());
    expect(saved.name).toBe(".._my_shot__1_.png");
    expect(saved.path).toBe(join(root, "chat-1", ".._my_shot__1_.png"));
  });

  it("uniquifies a colliding name instead of overwriting", async () => {
    const first = await saveAttachmentFile(root, "chat-1", "shot.png", bytes("one"));
    const second = await saveAttachmentFile(root, "chat-1", "shot.png", bytes("two"));
    const third = await saveAttachmentFile(root, "chat-1", "shot.png", bytes("three"));
    expect([first.name, second.name, third.name]).toEqual(["shot.png", "shot-2.png", "shot-3.png"]);
    expect(await readFile(first.path, "utf-8")).toBe("one");
    expect(await readFile(third.path, "utf-8")).toBe("three");
  });

  it("rejects an unsupported extension", async () => {
    await expect(saveAttachmentFile(root, "chat-1", "payload.docx", bytes())).rejects.toThrow(
      /Unsupported attachment type/,
    );
    expect(existsSync(attachmentDir(root, "chat-1"))).toBe(false);
  });

  it("rejects a file over the size cap", async () => {
    const tooBig = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    await expect(saveAttachmentFile(root, "chat-1", "huge.png", tooBig)).rejects.toThrow(/larger than/);
  });

  it("accepts a file exactly on the cap", async () => {
    const exact = new Uint8Array(MAX_ATTACHMENT_BYTES);
    await expect(saveAttachmentFile(root, "chat-1", "big.png", exact)).resolves.toMatchObject({
      name: "big.png",
    });
  });
});

describe("assertAttachmentPath", () => {
  it("returns the resolved path for a file inside the chat's directory", async () => {
    const saved = await saveAttachmentFile(root, "chat-1", "shot.png", bytes());
    expect(assertAttachmentPath(root, "chat-1", saved.path)).toBe(saved.path);
  });

  it("refuses a traversal, another chat's directory, and the root itself", async () => {
    const outside = join(root, "chat-1", "..", "chat-2", "shot.png");
    expect(() => assertAttachmentPath(root, "chat-1", outside)).toThrow(/outside its chat directory/);
    expect(() => assertAttachmentPath(root, "chat-1", join(root, "chat-2", "shot.png"))).toThrow();
    expect(() => assertAttachmentPath(root, "chat-1", attachmentDir(root, "chat-1"))).toThrow();
    expect(() => assertAttachmentPath(root, "chat-1", "/etc/passwd")).toThrow();
  });
});

describe("deleting attachments", () => {
  it("removes a single file and reports a missing one as false", async () => {
    const saved = await saveAttachmentFile(root, "chat-1", "shot.png", bytes());
    await expect(deleteAttachmentFile(saved.path)).resolves.toBe(true);
    expect(existsSync(saved.path)).toBe(false);
    await expect(deleteAttachmentFile(saved.path)).resolves.toBe(false);
  });

  it("removes the whole directory, and is a no-op when it is already gone", async () => {
    await saveAttachmentFile(root, "chat-1", "shot.png", bytes());
    await saveAttachmentFile(root, "chat-1", "spec.pdf", bytes());
    await deleteAttachmentsDir(root, "chat-1");
    expect(existsSync(attachmentDir(root, "chat-1"))).toBe(false);
    await expect(deleteAttachmentsDir(root, "chat-1")).resolves.toBeUndefined();
  });

  it("removes the directory synchronously for the quit path", async () => {
    await saveAttachmentFile(root, "chat-1", "shot.png", bytes());
    deleteAttachmentsDirSync(root, "chat-1");
    // Sync: gone before anything is awaited.
    expect(existsSync(attachmentDir(root, "chat-1"))).toBe(false);
    expect(() => deleteAttachmentsDirSync(root, "chat-1")).not.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("leaves the other chats' directories alone", async () => {
    await saveAttachmentFile(root, "chat-1", "shot.png", bytes());
    await saveAttachmentFile(root, "chat-2", "shot.png", bytes());
    await deleteAttachmentsDir(root, "chat-1");
    expect(await listAttachmentDirs(root)).toEqual(["chat-2"]);
  });
});

describe("listAttachmentDirs", () => {
  it("lists the sanitized chat ids and ignores loose files", async () => {
    await saveAttachmentFile(root, "chat-1", "shot.png", bytes());
    await saveAttachmentFile(root, "chat/2", "shot.png", bytes());
    expect((await listAttachmentDirs(root)).sort()).toEqual(["chat-1", "chat_2"]);
  });

  it("returns nothing when the root does not exist yet", async () => {
    await expect(listAttachmentDirs(join(root, "never-created"))).resolves.toEqual([]);
  });
});

describe("limits", () => {
  it("caps a message at four attachments and a file at 10 MiB", () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(4);
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});
