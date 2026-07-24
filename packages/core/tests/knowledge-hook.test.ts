import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHook, uninstallHook, getHookStatus } from "../src/knowledge/hook";

let repo: string;

function hookPath(): string {
  return join(repo, ".git", "hooks", "post-commit");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skipper-hook-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("installHook (v2 snippet)", () => {
  it("installs a hook that delegates path resolution to the CLI", () => {
    installHook({ repoPath: repo, cliCommand: "skipper" });
    const body = readFileSync(hookPath(), "utf-8");
    expect(body).toContain("# skipper-knowledge-hook:2");
    expect(body).toContain('knowledge extract \\"$skipper_sha\\" --repo \\"$skipper_repo\\"');
    // The v1 workspace discovery is gone entirely.
    expect(body).not.toContain("--workspace");
    expect(body).not.toContain(".skipper");
    expect(body).not.toContain("skipper_workspace");
    expect(body).not.toContain("knowledge-log");
    // Still detached so the commit never blocks.
    expect(body).toContain("</dev/null &");
  });

  it("getHookStatus reports our snippet as v2", () => {
    installHook({ repoPath: repo, cliCommand: "skipper" });
    const s = getHookStatus(repo);
    expect(s.exists).toBe(true);
    expect(s.ours).toBe(true);
    expect(s.version).toBe(2);
  });

  it("upgrades a v1 snippet in place, preserving foreign hook content", () => {
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    const v1 = [
      "#!/bin/sh",
      'echo "user hook before"',
      "# >>> skipper knowledge hook (managed) >>>",
      "# skipper-knowledge-hook:1",
      "skipper_workspace=''",
      'eval "skipper knowledge extract \\"$sha\\" --repo \\"$repo\\" --workspace \\"$skipper_workspace\\""',
      "# <<< skipper knowledge hook (managed) <<<",
      'echo "user hook after"',
      "",
    ].join("\n");
    writeFileSync(hookPath(), v1, "utf-8");
    chmodSync(hookPath(), 0o755);

    const result = installHook({ repoPath: repo, cliCommand: "skipper" });
    expect(result.replaced).toBe(true);
    const body = readFileSync(hookPath(), "utf-8");
    expect(body).toContain('echo "user hook before"');
    expect(body).toContain('echo "user hook after"');
    expect(body).toContain("# skipper-knowledge-hook:2");
    expect(body).not.toContain("--workspace");
    expect(getHookStatus(repo).version).toBe(2);
  });

  it("uninstallHook removes only our block", () => {
    installHook({ repoPath: repo, cliCommand: "skipper" });
    const { removed } = uninstallHook(repo);
    expect(removed).toBe(true);
    const body = readFileSync(hookPath(), "utf-8");
    expect(body).not.toContain("skipper knowledge hook");
    expect(getHookStatus(repo).ours).toBe(false);
  });
});
