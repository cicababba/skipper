import { dependencyIndex, unmetDependencies, type TrackedItem } from "@skipper/shared";

/** Prerequisites the item is still waiting on (#85), resolved to their tracked items. */
export function blockingItemsFor(item: TrackedItem, all: TrackedItem[]): TrackedItem[] {
  return unmetDependencies(item, dependencyIndex(all)).map((link) => link.item!);
}
