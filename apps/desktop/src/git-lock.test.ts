import { describe, it, expect } from "vitest";
import type { RepoRef } from "@skipper/shared";
import { makeRepoGitLock } from "./git-lock";

const repoA: RepoRef = { owner: "owner", name: "repo" };
const repoB: RepoRef = { owner: "owner", name: "other" };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("makeRepoGitLock", () => {
  it("serializes same-repo ops FIFO with no overlap", async () => {
    const lock = makeRepoGitLock();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const op = (label: string, gate: Promise<void>) =>
      lock(repoA, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${label}`);
        await gate;
        order.push(`end:${label}`);
        active--;
      });

    const g1 = deferred<void>();
    const g2 = deferred<void>();
    const p1 = op("a", g1.promise);
    const p2 = op("b", g2.promise);

    // b must not start until a ends: gate a, let it drain, then gate b.
    g1.resolve();
    await p1;
    g2.resolve();
    await p2;

    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(maxActive).toBe(1);
  });

  it("delivers a rejection to the caller and still runs the next op", async () => {
    const lock = makeRepoGitLock();
    const boom = new Error("boom");
    const failed = lock(repoA, async () => {
      throw boom;
    });
    await expect(failed).rejects.toBe(boom);

    const ran = lock(repoA, async () => "ok");
    await expect(ran).resolves.toBe("ok");
  });

  it("runs different repos concurrently", async () => {
    const lock = makeRepoGitLock();
    const gate = deferred<void>();
    let bStarted = false;
    const a = lock(repoA, async () => {
      await gate.promise;
    });
    const b = lock(repoB, async () => {
      bStarted = true;
    });
    await b;
    expect(bStarted).toBe(true); // B ran while A was still gated
    gate.resolve();
    await a;
  });

  it("keeps separate factory instances independent", async () => {
    const lock1 = makeRepoGitLock();
    const lock2 = makeRepoGitLock();
    const gate = deferred<void>();
    let ran2 = false;
    const p1 = lock1(repoA, async () => {
      await gate.promise;
    });
    const p2 = lock2(repoA, async () => {
      ran2 = true;
    });
    await p2;
    expect(ran2).toBe(true); // lock2 not blocked by lock1's held op
    gate.resolve();
    await p1;
  });

  it("shares one lock across repoKey-equal refs (case-insensitive)", async () => {
    const lock = makeRepoGitLock();
    const order: string[] = [];
    const gate = deferred<void>();
    const p1 = lock({ owner: "Owner", name: "Repo" }, async () => {
      order.push("start:1");
      await gate.promise;
      order.push("end:1");
    });
    const p2 = lock({ owner: "owner", name: "repo" }, async () => {
      order.push("start:2");
    });
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start:1", "end:1", "start:2"]);
  });
});
