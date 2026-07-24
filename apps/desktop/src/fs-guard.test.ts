import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertInsideWorktrees, looksBinary } from "./fs-guard";

describe("assertInsideWorktrees", () => {
  const root = resolve("/home/user/.config/Skipper/worktrees");

  it("accepts the root itself", () => {
    expect(assertInsideWorktrees(root, root)).toBe(root);
  });

  it("accepts a nested path and returns it resolved", () => {
    const nested = join(root, "acme", "issue-1", "src", "a.ts");
    expect(assertInsideWorktrees(nested, root)).toBe(nested);
  });

  it("normalizes a traversal that stays inside the root", () => {
    const messy = join(root, "acme", "..", "acme", "b.ts");
    expect(assertInsideWorktrees(messy, root)).toBe(join(root, "acme", "b.ts"));
  });

  it("rejects a traversal that escapes the root", () => {
    expect(() => assertInsideWorktrees(join(root, "..", "secrets.txt"), root)).toThrow(
      /outside the worktrees root/,
    );
  });

  it("rejects an absolute path elsewhere on disk", () => {
    expect(() => assertInsideWorktrees("/etc/passwd", root)).toThrow(/outside the worktrees root/);
  });

  it("rejects a sibling whose name shares the root as a prefix", () => {
    // ".../worktrees-evil" starts with the root string but is not inside it.
    expect(() => assertInsideWorktrees(`${root}-evil/x`, root)).toThrow(/outside the worktrees root/);
  });
});

describe("assertInsideWorktrees symlink resolution", () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-guard-"));
    root = join(dir, "worktrees");
    await mkdir(root, { recursive: true });
    await mkdir(join(dir, "outside"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a path reached through a symlink that stays inside the root", async () => {
    await mkdir(join(root, "real"), { recursive: true });
    await symlink(join(root, "real"), join(root, "link"));
    // resolve() collapses the link target; it is still under root.
    expect(() => assertInsideWorktrees(join(root, "link", "f.ts"), root)).not.toThrow();
  });
});

describe("looksBinary", () => {
  it("flags a buffer with a null byte in the first 8KB", () => {
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it("treats plain UTF-8 text as non-binary", () => {
    expect(looksBinary(Buffer.from("export const x = 1;\n", "utf-8"))).toBe(false);
  });

  it("only scans the first 8KB — a null byte past the window is ignored", () => {
    const buf = Buffer.concat([Buffer.alloc(8192, 0x41), Buffer.from([0x00])]);
    expect(looksBinary(buf)).toBe(false);
  });

  it("handles an empty buffer", () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });
});
