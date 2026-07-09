import { describe, expect, it } from "vitest";
import { parsePorcelainV2 } from "./git";

const z = (...tokens: string[]) => tokens.join("\0") + "\0";

describe("parsePorcelainV2", () => {
  it("parses branch headers", () => {
    const s = parsePorcelainV2(
      z(
        "# branch.oid 1234567890abcdef",
        "# branch.head feature/issue-1",
        "# branch.upstream origin/feature/issue-1",
        "# branch.ab +3 -1",
      ),
    );
    expect(s.branch).toBe("feature/issue-1");
    expect(s.ahead).toBe(3);
    expect(s.behind).toBe(1);
    expect(s.hasUpstream).toBe(true);
    expect(s.files).toEqual({});
  });

  it("reports no upstream when the header is absent", () => {
    const s = parsePorcelainV2(z("# branch.oid abc", "# branch.head main"));
    expect(s.hasUpstream).toBe(false);
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });

  it("maps '.' to space in XY of changed entries", () => {
    const s = parsePorcelainV2(
      z(
        "1 .M N... 100644 100644 100644 abc def worktree-mod.txt",
        "1 M. N... 100644 100644 100644 abc def staged-mod.txt",
        "1 A. N... 000000 100644 100644 000 def staged-new.txt",
      ),
    );
    expect(s.files["worktree-mod.txt"]).toEqual({ index: " ", worktree: "M" });
    expect(s.files["staged-mod.txt"]).toEqual({ index: "M", worktree: " " });
    expect(s.files["staged-new.txt"]).toEqual({ index: "A", worktree: " " });
  });

  it("parses untracked and ignored entries", () => {
    const s = parsePorcelainV2(z("? new-file.txt", "! build-output.log"));
    expect(s.files["new-file.txt"]).toEqual({ index: "?", worktree: "?" });
    expect(s.files["build-output.log"]).toEqual({ index: "!", worktree: "!" });
  });

  it("keeps paths containing spaces intact", () => {
    const s = parsePorcelainV2(
      z("1 .M N... 100644 100644 100644 abc def my file with spaces.md", "? another spaced file.txt"),
    );
    expect(s.files["my file with spaces.md"]).toEqual({ index: " ", worktree: "M" });
    expect(s.files["another spaced file.txt"]).toEqual({ index: "?", worktree: "?" });
  });

  it("uses the new path for renames and skips the original-path token", () => {
    const s = parsePorcelainV2(
      z(
        "2 R. N... 100644 100644 100644 abc def R100 new-name.txt",
        "old-name.txt",
        "? trailing.txt",
      ),
    );
    expect(s.files["new-name.txt"]).toEqual({ index: "R", worktree: " " });
    expect(s.files["old-name.txt"]).toBeUndefined();
    expect(s.files["trailing.txt"]).toEqual({ index: "?", worktree: "?" });
  });

  it("parses unmerged entries", () => {
    const s = parsePorcelainV2(
      z("u UU N... 100644 100644 100644 100644 abc def ghi conflicted.txt"),
    );
    expect(s.files["conflicted.txt"]).toEqual({ index: "U", worktree: "U" });
  });

  it("returns empty defaults on empty output", () => {
    const s = parsePorcelainV2("");
    expect(s).toEqual({ branch: "", ahead: 0, behind: 0, files: {}, hasUpstream: false });
  });
});
