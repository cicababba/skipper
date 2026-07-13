import type { TrackedItem } from "@nestbrain/shared";
import { columnFor, repoKey, KANBAN_COLUMNS, type ColumnId } from "./model";

export type SortKey = "confidence" | "repo" | "age" | "state";
export type SortDir = "asc" | "desc";

const COLUMN_ORDER: (ColumnId | "attention")[] = ["attention", ...KANBAN_COLUMNS.map((c) => c.id)];

export function sortItems(items: TrackedItem[], key: SortKey, dir: SortDir): TrackedItem[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    switch (key) {
      case "confidence": {
        const ca = a.plan?.confidence;
        const cb = b.plan?.confidence;
        // Unscored items sink to the bottom in both directions.
        if (ca === undefined && cb === undefined) return 0;
        if (ca === undefined) return 1;
        if (cb === undefined) return -1;
        return sign * (ca - cb);
      }
      case "repo":
        return sign * repoKey(a.repo).localeCompare(repoKey(b.repo));
      case "age":
        return sign * a.createdAt.localeCompare(b.createdAt);
      case "state": {
        const oa = COLUMN_ORDER.indexOf(columnFor(a.state));
        const ob = COLUMN_ORDER.indexOf(columnFor(b.state));
        if (oa !== ob) return sign * (oa - ob);
        return sign * a.state.localeCompare(b.state);
      }
    }
  });
}

export interface InboxFilter {
  repo?: string;
  columns?: Set<ColumnId | "attention">;
  minConfidence?: number;
}

export function filterItems(items: TrackedItem[], filter: InboxFilter): TrackedItem[] {
  return items.filter((item) => {
    if (filter.repo && repoKey(item.repo) !== filter.repo) return false;
    if (filter.columns && filter.columns.size > 0 && !filter.columns.has(columnFor(item.state)))
      return false;
    if (filter.minConfidence !== undefined) {
      const c = item.plan?.confidence;
      if (c === undefined || c < filter.minConfidence) return false;
    }
    return true;
  });
}

export function formatAge(iso: string, now: Date): { value: number; unit: "m" | "h" | "d" } {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return { value: minutes, unit: "m" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: "h" };
  return { value: Math.floor(hours / 24), unit: "d" };
}
