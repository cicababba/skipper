// Plan-chat unread badge math (#167). The drawer reports the live message count;
// a per-item "seen" marker (localStorage, synced to the count while the drawer is
// open) records how many the user has already looked at. Pure so the FAB badge
// derivation is unit-testable without mounting the plan view.

/**
 * Parse a persisted "seen message count" marker, tolerating empty/malformed
 * values (a never-opened item stores "0"; a corrupted entry must not poison the
 * count into NaN). Only non-negative integers are accepted; anything else → 0.
 */
export function parseSeen(raw: string): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Unread plan-chat messages = how many have arrived past the last count the user
 * saw. Never negative (the count can only grow, but a stale/larger seen marker
 * must still clamp to 0).
 */
export function unreadCount(count: number, seenRaw: string): number {
  return Math.max(0, count - parseSeen(seenRaw));
}
