"use client";

import { useMemo, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { ExternalLink, Loader2, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import type { MemoryHit, SolutionRecord } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { VoteButton } from "@/components/vote-button";
import {
  buildMemoryGraph,
  dimmedNodeIds,
  type GraphNode,
  type Sentiment,
} from "@/lib/inbox/memory-graph";

const TICKS = 300;
const PADDING = 40;
const MEMORY_R = 9;
const FILE_R = 4;

type PositionedNode = GraphNode & SimulationNodeDatum;

const SENTIMENT_CLASS: Record<Sentiment, string> = {
  positive: "text-accent",
  neutral: "text-muted/60",
  negative: "text-danger/70",
};

/**
 * Bipartite memory↔file graph (#255, slice 2): memories and the files two or
 * more of them touch. The force layout runs to completion once per data change
 * and renders static positions — no animation, no dragging.
 */
export function MemoryGraphView({
  records,
  hits,
  fileFilter,
  busy,
  onFileFilter,
  onOpen,
  onDelete,
  onChanged,
}: {
  records: SolutionRecord[];
  hits: MemoryHit[] | null;
  fileFilter: string | null;
  busy: boolean;
  onFileFilter: (file: string | null) => void;
  onOpen: (id: string) => void;
  onDelete: (record: SolutionRecord) => void;
  onChanged: () => void;
}) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const [selected, setSelected] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);

  const graph = useMemo(() => buildMemoryGraph(records), [records]);
  const dimmed = useMemo(() => dimmedNodeIds(graph, hits, fileFilter), [graph, hits, fileFilter]);

  const { nodes, viewBox } = useMemo(() => {
    const simNodes: PositionedNode[] = graph.nodes.map((n) => ({ ...n }));
    const simLinks: SimulationLinkDatum<PositionedNode>[] = graph.links.map((l) => ({
      source: l.source,
      target: l.target,
    }));
    forceSimulation(simNodes)
      .force(
        "link",
        forceLink<PositionedNode, SimulationLinkDatum<PositionedNode>>(simLinks)
          .id((d) => d.id)
          .distance(70),
      )
      .force("charge", forceManyBody().strength(-180))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(MEMORY_R * 2))
      .stop()
      .tick(TICKS);

    const xs = simNodes.map((n) => n.x ?? 0);
    const ys = simNodes.map((n) => n.y ?? 0);
    const minX = Math.min(...xs, 0) - PADDING;
    const minY = Math.min(...ys, 0) - PADDING;
    const width = Math.max(...xs, 0) - minX + PADDING;
    const height = Math.max(...ys, 0) - minY + PADDING;
    return { nodes: simNodes, viewBox: `${minX} ${minY} ${width} ${height}` };
  }, [graph]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);
  const selectedRecord = records.find((r) => r.itemId === selected) ?? null;

  const curate = async (record: SolutionRecord, kind: "up" | "down") => {
    if (!window.skipper) return;
    setVoting(true);
    try {
      await window.skipper.memory.curate(record.itemId, record.curationVote === kind ? null : kind);
      onChanged();
    } finally {
      setVoting(false);
    }
  };

  if (graph.nodes.length === 0) {
    return <p className="text-[13px] text-muted/60 py-4">{m.empty}</p>;
  }

  return (
    <div className="flex gap-3">
      <div className="flex-1 min-w-0 rounded-lg border border-border overflow-hidden">
        <svg viewBox={viewBox} className="w-full h-[420px]" role="img" aria-label={m.viewGraph}>
          <g>
            {graph.links.map((link) => {
              const a = byId.get(link.source);
              const b = byId.get(link.target);
              if (!a || !b) return null;
              return (
                <line
                  key={`${link.source}->${link.target}`}
                  x1={a.x ?? 0}
                  y1={a.y ?? 0}
                  x2={b.x ?? 0}
                  y2={b.y ?? 0}
                  stroke="currentColor"
                  strokeWidth={1}
                  className={`text-border ${
                    dimmed.has(link.source) || dimmed.has(link.target) ? "opacity-20" : "opacity-60"
                  }`}
                />
              );
            })}
          </g>
          {nodes.map((node) => {
            const x = node.x ?? 0;
            const y = node.y ?? 0;
            const isDim = dimmed.has(node.id);
            if (node.kind === "file") {
              const active = fileFilter === node.path;
              return (
                <g
                  key={node.id}
                  role="button"
                  aria-label={node.path}
                  onClick={() => onFileFilter(active ? null : node.path)}
                  className={`cursor-pointer ${isDim ? "opacity-25" : ""} ${
                    active ? "text-accent" : "text-muted"
                  }`}
                >
                  <title>{node.path}</title>
                  <circle
                    cx={x}
                    cy={y}
                    r={FILE_R}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  />
                  <text
                    x={x}
                    y={y - FILE_R - 4}
                    textAnchor="middle"
                    fill="currentColor"
                    className="text-[7px] font-mono"
                  >
                    {node.label}
                  </text>
                </g>
              );
            }
            const isSelected = selected === node.id;
            return (
              <g
                key={node.id}
                role="button"
                aria-label={node.label}
                onClick={() => setSelected(node.id)}
                className={`cursor-pointer ${SENTIMENT_CLASS[node.sentiment]} ${
                  isDim ? "opacity-25" : ""
                }`}
              >
                <title>{node.label}</title>
                {node.kind === "note" ? (
                  <rect
                    x={x - MEMORY_R}
                    y={y - MEMORY_R}
                    width={MEMORY_R * 2}
                    height={MEMORY_R * 2}
                    rx={3}
                    fill="currentColor"
                    stroke={isSelected ? "currentColor" : "none"}
                    strokeWidth={isSelected ? 3 : 0}
                    strokeOpacity={0.4}
                  />
                ) : (
                  <circle
                    cx={x}
                    cy={y}
                    r={MEMORY_R}
                    fill="currentColor"
                    stroke={isSelected ? "currentColor" : "none"}
                    strokeWidth={isSelected ? 3 : 0}
                    strokeOpacity={0.4}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {selectedRecord && (
        <GraphSidePanel
          record={selectedRecord}
          busy={busy}
          voting={voting}
          onClose={() => setSelected(null)}
          onOpen={() => onOpen(selectedRecord.itemId)}
          onDelete={() => onDelete(selectedRecord)}
          onVote={(kind) => void curate(selectedRecord, kind)}
        />
      )}
    </div>
  );
}

function GraphSidePanel({
  record,
  busy,
  voting,
  onClose,
  onOpen,
  onDelete,
  onVote,
}: {
  record: SolutionRecord;
  busy: boolean;
  voting: boolean;
  onClose: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onVote: (kind: "up" | "down") => void;
}) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const feedback = record.feedback ?? { up: 0, down: 0 };
  const snippet = record.kind === "note" ? record.note?.body : record.plan?.plan.summary;

  return (
    <div className="w-[280px] shrink-0 space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start gap-2">
        <span className="flex-1 min-w-0 text-[13px] font-medium break-words">{record.title}</span>
        <button
          onClick={onClose}
          aria-label={m.close}
          className="shrink-0 text-muted hover:text-foreground transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {snippet && <p className="text-[12px] text-muted/80 line-clamp-6">{snippet}</p>}

      <div className="flex items-center gap-1">
        <VoteButton
          active={record.curationVote === "up"}
          disabled={voting}
          label={t.inbox.plan.memories.helpful}
          count={feedback.up}
          onClick={() => onVote("up")}
        >
          <ThumbsUp size={13} />
        </VoteButton>
        <VoteButton
          active={record.curationVote === "down"}
          disabled={voting}
          label={t.inbox.plan.memories.notHelpful}
          count={feedback.down}
          onClick={() => onVote("down")}
        >
          <ThumbsDown size={13} />
        </VoteButton>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onOpen}
          className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-border text-muted hover:text-foreground transition-colors"
        >
          <ExternalLink size={12} />
          {m.openRecord}
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          aria-label={m.delete}
          className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-danger/25 text-danger hover:bg-danger/10 transition-colors disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        </button>
      </div>
    </div>
  );
}
