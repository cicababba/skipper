import { describe, expect, it } from "vitest";
import { parseSeen, unreadCount } from "./plan-chat-unread";

describe("parseSeen", () => {
  it("parses a plain non-negative integer marker", () => {
    expect(parseSeen("0")).toBe(0);
    expect(parseSeen("5")).toBe(5);
  });

  it("treats the empty (never-written) marker as 0", () => {
    expect(parseSeen("")).toBe(0);
  });

  it("falls back to 0 on malformed values instead of NaN", () => {
    expect(parseSeen("abc")).toBe(0);
    expect(parseSeen("3.5")).toBe(0);
    expect(parseSeen("-2")).toBe(0);
    expect(parseSeen("NaN")).toBe(0);
  });
});

describe("unreadCount", () => {
  it("is 0 for a fresh, never-opened item with no history", () => {
    // chatCount starts at 0 before the drawer loads any history.
    expect(unreadCount(0, "0")).toBe(0);
  });

  it("counts prior history against the never-opened marker", () => {
    // Drawer loaded 3 stored messages, item never opened (seen defaults to "0").
    expect(unreadCount(3, "0")).toBe(3);
  });

  it("grows as messages arrive while the drawer stays closed", () => {
    // Seen was synced at 2; two more turns land without opening.
    expect(unreadCount(2, "2")).toBe(0);
    expect(unreadCount(5, "2")).toBe(3);
  });

  it("clears to 0 the moment opening syncs seen to the current count", () => {
    // The open effect writes seen = String(chatCount).
    expect(unreadCount(5, "5")).toBe(0);
  });

  it("shows 1 when one assistant reply lands after a close", () => {
    // Opened at 5 (seen=5), closed, one reply arrives mid-turn → count 6.
    expect(unreadCount(6, "5")).toBe(1);
  });

  it("never goes negative if the seen marker is stale-high", () => {
    expect(unreadCount(2, "5")).toBe(0);
  });

  it("does not produce NaN from a corrupted stored marker", () => {
    const result = unreadCount(4, "garbage");
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(4);
  });

  it("treats an empty stored marker like never-opened", () => {
    expect(unreadCount(4, "")).toBe(4);
  });
});
