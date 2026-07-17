import { sourceRefKey, type TrackedItem } from "@skipper/shared";

// Prerequisites the item is still waiting on (#85). Mirrors reconcile's `unmet`
// in packages/core/src/orchestrator/reconcile.ts — keep the two in lockstep: a
// ref blocks only when it resolves to a same-tracker tracked item that isn't
// merged/closed; waived refs and self-references drop.
export function blockingItemsFor(item: TrackedItem, all: TrackedItem[]): TrackedItem[] {
  if (!item.blockedBy?.length) return [];
  const selfKey = sourceRefKey(item.sourceRef);
  const waived = new Set((item.blockedByWaived ?? []).map(sourceRefKey));
  const index = new Map<string, TrackedItem>();
  for (const t of all) {
    if (t.source === item.source) index.set(sourceRefKey(t.sourceRef), t);
  }
  const out: TrackedItem[] = [];
  const seen = new Set<string>();
  for (const ref of item.blockedBy) {
    const key = sourceRefKey(ref);
    if (key === selfKey || waived.has(key) || seen.has(key)) continue;
    const blocker = index.get(key);
    if (!blocker || blocker.state === "merged" || blocker.state === "closed") continue;
    seen.add(key);
    out.push(blocker);
  }
  return out;
}
