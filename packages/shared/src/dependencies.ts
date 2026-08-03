import { sourceRefKey, type SourceRef } from "./inbox";
import type { LifecycleState, TrackedItem } from "./orchestrator";

/** Prerequisite states that stop blocking — Skipper saw the work land. */
export const DEP_RESOLVED_STATES: readonly LifecycleState[] = ["merged", "closed"];

/** Tracked items keyed by `${source}:${sourceRefKey(sourceRef)}` — the dependency-matching axis (#85). */
export type DependencyIndex = Map<string, TrackedItem>;

export interface DependencyLink {
  ref: SourceRef;
  /** The tracked item the ref resolves to; undefined when Skipper doesn't track it. */
  item?: TrackedItem;
}

function indexKey(source: string, ref: SourceRef): string {
  return `${source}:${sourceRefKey(ref)}`;
}

/** Resolution index over tracked items — built once per sweep so lookups stay O(1). */
export function dependencyIndex(items: Iterable<TrackedItem>): DependencyIndex {
  const index: DependencyIndex = new Map();
  for (const item of items) index.set(indexKey(item.source, item.sourceRef), item);
  return index;
}

/**
 * Prerequisites the item is still waiting on: self-references, duplicates and refs
 * resolving to a merged/closed tracked item drop. Untracked refs are KEPT (item
 * undefined) and waived refs are KEPT — a waiver suppresses the park, not the fact.
 */
export function pendingDependencies(item: TrackedItem, index: DependencyIndex): DependencyLink[] {
  if (!item.blockedBy?.length) return [];
  const selfKey = sourceRefKey(item.sourceRef);
  const seen = new Set<string>();
  const out: DependencyLink[] = [];
  for (const ref of item.blockedBy) {
    const key = sourceRefKey(ref);
    if (key === selfKey || seen.has(key)) continue;
    seen.add(key);
    const blocker = index.get(indexKey(item.source, ref));
    if (blocker && DEP_RESOLVED_STATES.includes(blocker.state)) continue;
    out.push(blocker ? { ref, item: blocker } : { ref });
  }
  return out;
}

/**
 * The subset of pending prerequisites that actually blocks: tracked (Skipper can
 * observe them landing) and not waived by the user.
 */
export function unmetDependencies(item: TrackedItem, index: DependencyIndex): DependencyLink[] {
  if (!item.blockedBy?.length) return [];
  const waived = new Set((item.blockedByWaived ?? []).map(sourceRefKey));
  return pendingDependencies(item, index).filter(
    (link) => link.item !== undefined && !waived.has(sourceRefKey(link.ref)),
  );
}

/** "#42" when the ref's project matches the item's (case-insensitive), else "owner/repo#42". */
export function displayDependencyRef(ref: SourceRef, item: TrackedItem): string {
  return ref.project.toLowerCase() === item.sourceRef.project.toLowerCase()
    ? `#${ref.key}`
    : `${ref.project}#${ref.key}`;
}

/**
 * Transition reason for a dependency park. The `"blocked by "` prefix is the marker
 * the release sweep matches on, so reconcile and the planner must both mint it here.
 */
export function dependencyBlockReason(item: TrackedItem, links: DependencyLink[]): string {
  return `blocked by ${links.map((link) => displayDependencyRef(link.ref, item)).join(", ")}`;
}
