// Composer chat attachments (#281), one directory per chat under
// <userData>/composer/attachments/. Pure Node module (no electron import) so it
// stays unit-testable; callers inject the root. The files MUST live here and
// never inside the repo checkout — a composer turn runs in the user's own
// checkout behind the dirty-tree tripwire.

import { rmSync } from "node:fs";
import { mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

export type AttachmentKind = "image" | "pdf" | "text";

export const ALLOWED_ATTACHMENT_EXTENSIONS: Record<AttachmentKind, readonly string[]> = {
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif"],
  pdf: [".pdf"],
  text: [".txt", ".md", ".markdown", ".csv", ".json", ".log", ".yaml", ".yml"],
};

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export function attachmentKind(name: string): AttachmentKind | null {
  const ext = extname(name).toLowerCase();
  for (const [kind, extensions] of Object.entries(ALLOWED_ATTACHMENT_EXTENSIONS)) {
    if (extensions.includes(ext)) return kind as AttachmentKind;
  }
  return null;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function attachmentDir(root: string, chatId: string): string {
  return join(root, sanitize(chatId));
}

/** Resolve and assert `path` sits inside the chat's own attachment directory. */
export function assertAttachmentPath(root: string, chatId: string, path: string): string {
  const dir = resolve(attachmentDir(root, chatId));
  const abs = resolve(path);
  if (!abs.startsWith(dir + sep)) {
    throw new Error(`Refusing to access an attachment outside its chat directory: ${abs}`);
  }
  return abs;
}

async function uniqueName(dir: string, name: string): Promise<string> {
  let existing: string[];
  try {
    existing = await readdir(dir);
  } catch {
    return name;
  }
  if (!existing.includes(name)) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

export async function saveAttachmentFile(
  root: string,
  chatId: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string; name: string; kind: AttachmentKind }> {
  const kind = attachmentKind(name);
  if (!kind) throw new Error(`Unsupported attachment type: ${name}`);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is larger than ${MAX_ATTACHMENT_BYTES} bytes: ${name}`);
  }
  const dir = attachmentDir(root, chatId);
  await mkdir(dir, { recursive: true });
  const fileName = await uniqueName(dir, sanitize(name));
  const path = join(dir, fileName);
  await writeFile(path, bytes);
  return { path, name: fileName, kind };
}

export async function deleteAttachmentFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export async function deleteAttachmentsDir(root: string, chatId: string): Promise<void> {
  await rm(attachmentDir(root, chatId), { recursive: true, force: true });
}

/** The quit path cannot await; `before-quit` force-exits shortly after. */
export function deleteAttachmentsDirSync(root: string, chatId: string): void {
  try {
    rmSync(attachmentDir(root, chatId), { recursive: true, force: true });
  } catch {
    /* best-effort: an orphaned directory is swept at the next composer init */
  }
}

/** Sanitized chat ids of every attachment directory that exists. */
export async function listAttachmentDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
