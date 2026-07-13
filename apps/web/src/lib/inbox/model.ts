import type { LifecycleState, RepoRef, TrackedItem } from "@nestbrain/shared";

export function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/** States where the item is waiting on the human — what the sidebar badges count. */
export const ATTENTION_STATES: readonly LifecycleState[] = [
  "plan-gate",
  "human-review",
  "needs-input",
  "blocked",
  "failed",
];

export function attentionCounts(items: TrackedItem[]): {
  total: number;
  byRepo: Map<string, number>;
} {
  const byRepo = new Map<string, number>();
  let total = 0;
  for (const item of items) {
    if (!ATTENTION_STATES.includes(item.state)) continue;
    total += 1;
    const key = repoKey(item.repo);
    byRepo.set(key, (byRepo.get(key) ?? 0) + 1);
  }
  return { total, byRepo };
}

export function reposOf(items: TrackedItem[]): RepoRef[] {
  const seen = new Map<string, RepoRef>();
  for (const item of items) seen.set(repoKey(item.repo), item.repo);
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, repo]) => repo);
}

export type ColumnId =
  | "triage"
  | "planning"
  | "planGate"
  | "queued"
  | "coding"
  | "review"
  | "done";

export const KANBAN_COLUMNS: { id: ColumnId; states: readonly LifecycleState[] }[] = [
  { id: "triage", states: ["triage"] },
  { id: "planning", states: ["planning"] },
  { id: "planGate", states: ["plan-gate"] },
  { id: "queued", states: ["queued"] },
  { id: "coding", states: ["coding", "agent-review"] },
  { id: "review", states: ["human-review", "pr-open", "in-review", "changes-requested"] },
  { id: "done", states: ["merged", "closed"] },
];

/** Stuck states rendered in the attention strip, never in a kanban column. */
export const ATTENTION_SECTION_STATES: readonly LifecycleState[] = [
  "needs-input",
  "blocked",
  "failed",
];

export function columnFor(state: LifecycleState): ColumnId | "attention" {
  if (ATTENTION_SECTION_STATES.includes(state)) return "attention";
  const column = KANBAN_COLUMNS.find((c) => c.states.includes(state));
  if (!column) throw new Error(`unmapped lifecycle state: ${state}`);
  return column.id;
}
