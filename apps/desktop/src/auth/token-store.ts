// Encrypted persistence for OAuth tokens.
//
// Uses Electron's safeStorage, which is backed by:
//   - macOS:   Keychain Services
//   - Windows: DPAPI
//   - Linux:   kwallet / libsecret (with a basic fallback when no keyring)
//
// We refuse to write credentials at all if real OS encryption is unavailable —
// better to fail sign-in than to write a refresh_token in cleartext.

import { app, safeStorage } from "electron";
import { join } from "node:path";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { parseStoreFile, type AuthStoreFile } from "./store-format";

function getStorePath(): string {
  return join(app.getPath("userData"), "auth.enc");
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export async function saveStore(store: AuthStoreFile): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS-level encryption is not available; refusing to persist credentials. " +
        "On Linux this usually means no Secret Service (kwallet/libsecret) is running.",
    );
  }
  const path = getStorePath();
  await mkdir(join(path, ".."), { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(store));
  await writeFile(path, encrypted);
}

export async function loadStore(): Promise<AuthStoreFile | null> {
  const path = getStorePath();
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return null;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    // We have a file on disk but can't decrypt: nothing we can do.
    console.warn("[auth] auth.enc present but safeStorage unavailable — ignoring");
    return null;
  }
  let json: string;
  try {
    json = safeStorage.decryptString(buf);
  } catch (err) {
    console.warn("[auth] failed to decrypt auth.enc — clearing:", err);
    await clearStore().catch(() => { /* ignore */ });
    return null;
  }
  const parsed = parseStoreFile(json);
  if (!parsed) {
    console.warn("[auth] unrecognized auth.enc contents — clearing");
    await clearStore().catch(() => { /* ignore */ });
    return null;
  }
  if (parsed.migrated) {
    await saveStore(parsed.store).catch((err) =>
      console.warn("[auth] failed to persist migrated store:", err),
    );
  }
  return parsed.store;
}

export async function clearStore(): Promise<void> {
  try {
    await unlink(getStorePath());
  } catch {
    /* already gone */
  }
}
