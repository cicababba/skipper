// Bipartite memory↔file graph for the Memory tab's graph view (#255, slice 2).
// Pure shaping: no d3, no layout, no React. The view layer runs the force
// simulation over whatever this returns.

import type { MemoryHit, SolutionRecord } from "@skipper/shared";
import { recordFiles } from "./memory-filters";

/** A file linking fewer memories than this adds noise, not structure. */
const MIN_SHARED_MEMORIES = 2;

/** Net feedback bucket, driving the node fill. */
export type Sentiment = "positive" | "neutral" | "negative";

export interface MemoryNode {
  id: string;
  kind: "memory" | "note";
  label: string;
  sentiment: Sentiment;
}

export interface FileNode {
  id: string;
  kind: "file";
  /** Repo-relative path, verbatim. */
  path: string;
  /** Basename, for the on-canvas label. */
  label: string;
  /** How many memories touch this file. */
  degree: number;
}

export type GraphNode = MemoryNode | FileNode;

export interface GraphLink {
  source: string;
  target: string;
}

export interface MemoryGraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

export function sentimentOf(feedback: SolutionRecord["feedback"]): Sentiment {
  const up = feedback?.up ?? 0;
  const down = feedback?.down ?? 0;
  if (up > down) return "positive";
  if (down > up) return "negative";
  return "neutral";
}

/** `src/auth/oauth.ts` → `oauth.ts`. Paths are always forward-slashed. */
export function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * One node per record, plus a node for every file shared by at least two
 * records, linked to the memories that touch it. Files below the threshold are
 * dropped entirely — including their links.
 */
export function buildMemoryGraph(records: SolutionRecord[]): MemoryGraph {
  const touchedBy = new Map<string, string[]>();
  for (const record of records) {
    for (const file of new Set(recordFiles(record))) {
      const memories = touchedBy.get(file);
      if (memories) memories.push(record.itemId);
      else touchedBy.set(file, [record.itemId]);
    }
  }

  const nodes: GraphNode[] = records.map((record) => ({
    id: record.itemId,
    kind: record.kind === "note" ? "note" : "memory",
    label: record.title,
    sentiment: sentimentOf(record.feedback),
  }));
  const links: GraphLink[] = [];

  for (const [path, memories] of [...touchedBy].sort(([a], [b]) => a.localeCompare(b))) {
    if (memories.length < MIN_SHARED_MEMORIES) continue;
    nodes.push({
      id: `file:${path}`,
      kind: "file",
      path,
      label: basename(path),
      degree: memories.length,
    });
    for (const memory of memories) links.push({ source: memory, target: `file:${path}` });
  }

  return { nodes, links };
}

/**
 * Ids to render dimmed rather than hidden: with a search or a file filter
 * active, everything outside the match keeps its position so the shape of the
 * graph stays readable. No constraint active → nothing dimmed.
 */
export function dimmedNodeIds(
  graph: MemoryGraph,
  hits: MemoryHit[] | null,
  fileFilter: string | null,
): Set<string> {
  const dimmed = new Set<string>();
  if (!hits && !fileFilter) return dimmed;

  const matching = new Set(
    graph.nodes.filter((n) => n.kind !== "file").map((n) => n.id),
  );
  if (hits) {
    const hitIds = new Set(hits.map((h) => h.id));
    for (const id of [...matching]) if (!hitIds.has(id)) matching.delete(id);
  }
  if (fileFilter) {
    const onFile = new Set(
      graph.links.filter((l) => l.target === `file:${fileFilter}`).map((l) => l.source),
    );
    for (const id of [...matching]) if (!onFile.has(id)) matching.delete(id);
  }

  for (const node of graph.nodes) {
    if (node.kind === "file") {
      if (fileFilter && node.path !== fileFilter) dimmed.add(node.id);
      continue;
    }
    if (!matching.has(node.id)) dimmed.add(node.id);
  }
  return dimmed;
}
