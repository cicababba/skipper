import { describe, it, expect } from "vitest";
import { diffFiles, type FileMap, type SyncAction } from "./backend";

// A file map keyed by path → content hash (size/mtime are irrelevant to the
// three-way reconcile, which only compares hashes).
function map(entries: Record<string, string>): FileMap {
  const out: FileMap = {};
  for (const [path, hash] of Object.entries(entries)) {
    out[path] = { hash, size: hash.length, mtime: 0 };
  }
  return out;
}

function actionFor(actions: SyncAction[], path: string): SyncAction["action"] | undefined {
  return actions.find((a) => a.path === path)?.action;
}

describe("diffFiles three-way reconcile", () => {
  it("emits nothing when local and remote are already equal", () => {
    const base = map({ "a.txt": "1" });
    expect(diffFiles(base, map({ "a.txt": "1" }), map({ "a.txt": "1" }))).toEqual([]);
    // Divergent base but converged sides is still in sync.
    expect(diffFiles(map({ "a.txt": "0" }), map({ "a.txt": "9" }), map({ "a.txt": "9" }))).toEqual([]);
    // Absent on both sides.
    expect(diffFiles(base, map({}), map({}))).toEqual([]);
  });

  it("downloads when only the remote changed", () => {
    const actions = diffFiles(map({ "a.txt": "1" }), map({ "a.txt": "1" }), map({ "a.txt": "2" }));
    expect(actions).toEqual([{ path: "a.txt", action: "download" }]);
  });

  it("uploads when only the local changed", () => {
    const actions = diffFiles(map({ "a.txt": "1" }), map({ "a.txt": "2" }), map({ "a.txt": "1" }));
    expect(actions).toEqual([{ path: "a.txt", action: "upload" }]);
  });

  it("keeps both when both sides edited the same path away from base", () => {
    const actions = diffFiles(map({ "a.txt": "1" }), map({ "a.txt": "L" }), map({ "a.txt": "R" }));
    expect(actions).toEqual([{ path: "a.txt", action: "keep-both" }]);
  });

  it("deletes locally when the remote removed an otherwise-unchanged file", () => {
    const actions = diffFiles(map({ "a.txt": "1" }), map({ "a.txt": "1" }), map({}));
    expect(actions).toEqual([{ path: "a.txt", action: "delete-local" }]);
  });

  it("deletes remotely when the local removed an otherwise-unchanged file", () => {
    const actions = diffFiles(map({ "a.txt": "1" }), map({}), map({ "a.txt": "1" }));
    expect(actions).toEqual([{ path: "a.txt", action: "delete-remote" }]);
  });

  it("resurrects a local edit that the remote deleted (upload wins over delete)", () => {
    // remote deleted, but local edited away from base → the edit must survive.
    const actions = diffFiles(map({ "a.txt": "1" }), map({ "a.txt": "L" }), map({}));
    expect(actions).toEqual([{ path: "a.txt", action: "upload" }]);
  });

  it("resurrects a remote edit that the local deleted (download wins over delete)", () => {
    const actions = diffFiles(map({ "a.txt": "1" }), map({}), map({ "a.txt": "R" }));
    expect(actions).toEqual([{ path: "a.txt", action: "download" }]);
  });

  it("downloads a file that appeared only on the remote", () => {
    const actions = diffFiles(map({}), map({}), map({ "new.txt": "R" }));
    expect(actions).toEqual([{ path: "new.txt", action: "download" }]);
  });

  it("uploads a file that appeared only on the local", () => {
    const actions = diffFiles(map({}), map({ "new.txt": "L" }), map({}));
    expect(actions).toEqual([{ path: "new.txt", action: "upload" }]);
  });

  it("keeps both when the same new path appears on both sides with different content", () => {
    const actions = diffFiles(map({}), map({ "new.txt": "L" }), map({ "new.txt": "R" }));
    expect(actions).toEqual([{ path: "new.txt", action: "keep-both" }]);
  });

  it("reconciles many paths in one pass, each independently", () => {
    const base = map({ same: "1", localEdit: "1", remoteEdit: "1", bothEdit: "1", localDel: "1", remoteDel: "1" });
    const local = map({ same: "1", localEdit: "L", remoteEdit: "1", bothEdit: "L", remoteDel: "1", localNew: "N" });
    const remote = map({ same: "1", localEdit: "1", remoteEdit: "R", bothEdit: "R", localDel: "1", remoteNew: "N" });
    const actions = diffFiles(base, local, remote);

    expect(actionFor(actions, "same")).toBeUndefined();
    expect(actionFor(actions, "localEdit")).toBe("upload");
    expect(actionFor(actions, "remoteEdit")).toBe("download");
    expect(actionFor(actions, "bothEdit")).toBe("keep-both");
    // localDel: local removed an unchanged file → drop it from the commit.
    expect(actionFor(actions, "localDel")).toBe("delete-remote");
    // remoteDel: remote removed an unchanged file → remove it locally.
    expect(actionFor(actions, "remoteDel")).toBe("delete-local");
    expect(actionFor(actions, "localNew")).toBe("upload");
    expect(actionFor(actions, "remoteNew")).toBe("download");
    // 'same' produced no action.
    expect(actions).toHaveLength(7);
  });

  it("treats empty base as a first-ever sync (no deletes)", () => {
    const actions = diffFiles(map({}), map({ "a.txt": "L" }), map({ "a.txt": "R" }));
    expect(actions).toEqual([{ path: "a.txt", action: "keep-both" }]);
  });
});
