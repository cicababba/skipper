import { describe, it, expect } from "vitest";
import {
  toClaudePathRoot,
  scopedWriteRules,
  buildConfinementSettingsArgs,
  confinementEnv,
  type RunConfinement,
} from "../src/llm/confinement";

describe("toClaudePathRoot", () => {
  it("prefixes // and drops the leading slash of an absolute posix path", () => {
    expect(toClaudePathRoot("/home/user/wt")).toBe("//home/user/wt");
  });

  it("strips a trailing separator", () => {
    expect(toClaudePathRoot("/home/user/wt/")).toBe("//home/user/wt");
  });

  it("forces forward slashes (Windows-style separators)", () => {
    expect(toClaudePathRoot("/tmp/a\\b\\c")).toBe("//tmp/a/b/c");
  });
});

describe("scopedWriteRules", () => {
  it("emits root-scoped Edit and Write rules", () => {
    expect(scopedWriteRules("/wt/issue-1")).toEqual([
      "Edit(//wt/issue-1/**)",
      "Write(//wt/issue-1/**)",
    ]);
  });
});

describe("buildConfinementSettingsArgs", () => {
  it("returns [] when there is no CLI bundle to launch the guard from", () => {
    const conf: RunConfinement = { runRoot: "/wt/issue-1", denyRoots: ["/repo"] };
    expect(buildConfinementSettingsArgs(conf)).toEqual([]);
  });

  it("builds a PreToolUse guard hook with Edit|Write and Bash matchers", () => {
    const conf: RunConfinement = {
      runRoot: "/wt/issue-1",
      denyRoots: ["/home/me/repo", "/other/repo"],
      cliBundlePath: "/app/skipper.bundle.cjs",
    };
    const args = buildConfinementSettingsArgs(conf);
    expect(args[0]).toBe("--settings");
    const settings = JSON.parse(args[1]);
    const hooks = settings.hooks.PreToolUse;
    expect(hooks.map((h: { matcher: string }) => h.matcher)).toEqual(["Edit|Write", "Bash"]);
    const command = hooks[0].hooks[0].command;
    expect(command).toContain("skipper.bundle.cjs");
    expect(command).toContain("guard");
    expect(command).toContain('--root "/wt/issue-1"');
    expect(command).toContain('--deny "/home/me/repo"');
    expect(command).toContain('--deny "/other/repo"');
    // Same command backs both matchers — it branches on tool_name from stdin.
    expect(hooks[1].hooks[0].command).toBe(command);
  });
});

describe("confinementEnv", () => {
  it("returns the base env untouched with no confinement", () => {
    const base = { FOO: "bar" };
    expect(confinementEnv(undefined, base)).toBe(base);
  });

  it("returns the base env untouched when there is no CLI bundle", () => {
    const base = { FOO: "bar" };
    expect(confinementEnv({ runRoot: "/wt", denyRoots: ["/repo"] }, base)).toBe(base);
  });

  it("adds ELECTRON_RUN_AS_NODE when the guard hook is active", () => {
    const conf: RunConfinement = {
      runRoot: "/wt",
      denyRoots: ["/repo"],
      cliBundlePath: "/app/skipper.bundle.cjs",
    };
    const env = confinementEnv(conf, { FOO: "bar" });
    expect(env).toMatchObject({ FOO: "bar", ELECTRON_RUN_AS_NODE: "1" });
  });
});
