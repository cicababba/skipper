"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import {
  ExternalLink,
  Loader2,
  Maximize,
  Minus,
  Plus,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import type { MemoryHit, SolutionRecord } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";
import { VoteButton } from "@/components/vote-button";
import {
  contentBounds,
  fitViewport,
  panBy,
  zoomAt,
  type Viewport,
} from "@/lib/inbox/graph-viewport";
import {
  buildMemoryGraph,
  dimmedNodeIds,
  egoIds,
  fileRadius,
  showFileLabel,
  type GraphNode,
  type Sentiment,
} from "@/lib/inbox/memory-graph";
import { StalenessBadge } from "./memory-badges";

const TICKS = 300;
const MEMORY_R = 9;
const ZOOM_STEP = 1.4;
const PAN_THRESHOLD = 3;
const DEFAULT_SIZE = { width: 800, height: 480 };
const TITLE_MAX = 48;

type PositionedNode = GraphNode & SimulationNodeDatum;

const SENTIMENT_CLASS: Record<Sentiment, string> = {
  positive: "text-accent",
  neutral: "text-muted/60",
  negative: "text-danger/70",
};

/**
 * Bipartite memory↔file graph (#255, slice 2): memories and the files two or
 * more of them touch. The force layout runs to completion once per data change
 * and renders static positions — no animation, no dragging. Slice 3 adds
 * zoom/pan over those static world coordinates and a hover ego-network.
 */
export function MemoryGraphView({
  records,
  hits,
  fileFilter,
  busy,
  candidateIds,
  onFileFilter,
  onOpen,
  onDelete,
  onKeep,
  onChanged,
}: {
  records: SolutionRecord[];
  hits: MemoryHit[] | null;
  fileFilter: string | null;
  busy: boolean;
  /** Prune candidates (#256) — highlighted with a ring on the canvas. */
  candidateIds: Set<string>;
  onFileFilter: (file: string | null) => void;
  onOpen: (id: string) => void;
  onDelete: (record: SolutionRecord) => void;
  onKeep: (record: SolutionRecord) => void;
  onChanged: () => void;
}) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const [selected, setSelected] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [panning, setPanning] = useState(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef<Viewport>({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const movedRef = useRef(false);

  const graph = useMemo(() => buildMemoryGraph(records), [records]);
  const dimmed = useMemo(() => dimmedNodeIds(graph, hits, fileFilter), [graph, hits, fileFilter]);
  const ego = useMemo(() => (hovered ? egoIds(graph, hovered) : null), [graph, hovered]);

  const nodes = useMemo(() => {
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
      .force(
        "collide",
        forceCollide<PositionedNode>((n) =>
          n.kind === "file" ? fileRadius(n.degree) + 6 : MEMORY_R * 2,
        ),
      )
      .stop()
      .tick(TICKS);
    return simNodes;
  }, [graph]);

  const bounds = useMemo(() => contentBounds(nodes), [nodes]);
  const view = viewport ?? fitViewport(bounds, size);
  viewRef.current = view;

  useEffect(() => setViewport(null), [graph]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [graph]);

  // React's onWheel is passive, so preventDefault() there is a no-op and the
  // page scrolls instead of the graph zooming.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      setViewport(
        zoomAt(
          viewRef.current,
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          Math.exp(-event.deltaY * 0.002),
        ),
      );
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
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

  const zoomBy = (factor: number) =>
    setViewport(zoomAt(viewRef.current, { x: size.width / 2, y: size.height / 2 }, factor));

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
    movedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      movedRef.current = true;
      setPanning(true);
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    setViewport(panBy(viewRef.current, dx, dy));
  };

  const endPan = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPanning(false);
  };

  // A pan ends with a click on whatever node the pointer landed on — ignore it.
  const onNodeClick = (fn: () => void) => () => {
    if (movedRef.current) return;
    fn();
  };

  if (graph.nodes.length === 0) {
    return <p className="text-[13px] text-muted/60 py-4">{m.empty}</p>;
  }

  return (
    <div className="flex gap-3">
      <div
        ref={wrapperRef}
        className="relative flex-1 min-w-0 rounded-lg border border-border overflow-hidden"
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${size.width} ${size.height}`}
          className={`w-full h-[max(420px,calc(100vh-380px))] ${
            panning ? "cursor-grabbing" : "cursor-grab"
          }`}
          role="img"
          aria-label={m.viewGraph}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <g>
              {graph.links.map((link) => {
                const a = byId.get(link.source);
                const b = byId.get(link.target);
                if (!a || !b) return null;
                const incident = link.source === hovered || link.target === hovered;
                const opacity = ego
                  ? incident
                    ? "opacity-90"
                    : "opacity-10"
                  : dimmed.has(link.source) || dimmed.has(link.target)
                    ? "opacity-20"
                    : "opacity-60";
                return (
                  <line
                    key={`${link.source}->${link.target}`}
                    x1={a.x ?? 0}
                    y1={a.y ?? 0}
                    x2={b.x ?? 0}
                    y2={b.y ?? 0}
                    stroke="currentColor"
                    strokeWidth={1 / view.k}
                    className={`text-border ${opacity}`}
                  />
                );
              })}
            </g>
            {nodes.map((node) => {
              const x = node.x ?? 0;
              const y = node.y ?? 0;
              const isHovered = hovered === node.id;
              const faded = dimmed.has(node.id) || (ego !== null && !ego.has(node.id));
              if (node.kind === "file") {
                const active = fileFilter === node.path;
                const r = fileRadius(node.degree);
                return (
                  <g
                    key={node.id}
                    role="button"
                    aria-label={node.path}
                    onClick={onNodeClick(() => onFileFilter(active ? null : node.path))}
                    onMouseEnter={() => setHovered(node.id)}
                    onMouseLeave={() => setHovered(null)}
                    className={`cursor-pointer ${faded ? "opacity-25" : ""} ${
                      active ? "text-accent" : "text-muted"
                    }`}
                  >
                    <title>{node.path}</title>
                    {/* Unfilled shapes only hit-test on the stroke: without this
                        the interior of a file node ignores hover and clicks. */}
                    <circle
                      cx={x}
                      cy={y}
                      r={r}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      pointerEvents="all"
                    />
                    {showFileLabel(node.degree, view.k, isHovered, active) && (
                      <text
                        x={x}
                        y={y - r - 4 / view.k}
                        textAnchor="middle"
                        fill="currentColor"
                        fontSize={7 / view.k}
                        className="font-mono pointer-events-none"
                      >
                        {node.label}
                      </text>
                    )}
                  </g>
                );
              }
              const isSelected = selected === node.id;
              const isCandidate = candidateIds.has(node.id);
              return (
                <g
                  key={node.id}
                  role="button"
                  aria-label={node.label}
                  onClick={onNodeClick(() => setSelected(node.id))}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  className={`cursor-pointer ${
                    node.stale ? "text-muted/40" : SENTIMENT_CLASS[node.sentiment]
                  } ${faded ? "opacity-25" : ""}`}
                >
                  <title>{node.label}</title>
                  {isCandidate && (
                    <circle
                      cx={x}
                      cy={y}
                      r={MEMORY_R + 4}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray="3 2"
                      className="text-warning"
                    />
                  )}
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
                  {isHovered && (
                    <text
                      x={x}
                      y={y - MEMORY_R - 4 / view.k}
                      textAnchor="middle"
                      fill="currentColor"
                      fontSize={8 / view.k}
                      className="pointer-events-none"
                    >
                      {truncate(node.label)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        <div className="absolute top-2 right-2 flex flex-col rounded-lg border border-border bg-card overflow-hidden">
          <ZoomButton label={m.zoomIn} onClick={() => zoomBy(ZOOM_STEP)}>
            <Plus size={13} />
          </ZoomButton>
          <ZoomButton label={m.zoomOut} onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <Minus size={13} />
          </ZoomButton>
          <ZoomButton label={m.zoomFit} onClick={() => setViewport(null)}>
            <Maximize size={13} />
          </ZoomButton>
        </div>
      </div>

      {selectedRecord && (
        <GraphSidePanel
          record={selectedRecord}
          busy={busy}
          voting={voting}
          isCandidate={candidateIds.has(selectedRecord.itemId)}
          onClose={() => setSelected(null)}
          onOpen={() => onOpen(selectedRecord.itemId)}
          onDelete={() => onDelete(selectedRecord)}
          onKeep={() => onKeep(selectedRecord)}
          onVote={(kind) => void curate(selectedRecord, kind)}
        />
      )}
    </div>
  );
}

function truncate(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title;
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="px-2 py-1.5 text-muted hover:text-foreground transition-colors"
    >
      {children}
    </button>
  );
}

function GraphSidePanel({
  record,
  busy,
  voting,
  isCandidate,
  onClose,
  onOpen,
  onDelete,
  onKeep,
  onVote,
}: {
  record: SolutionRecord;
  busy: boolean;
  voting: boolean;
  isCandidate: boolean;
  onClose: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onKeep: () => void;
  onVote: (kind: "up" | "down") => void;
}) {
  const { t } = useT();
  const m = t.inbox.repoPage.memory;
  const feedback = record.feedback ?? { up: 0, down: 0 };
  const snippet =
    record.kind === "note" ? record.note?.body : (record.lesson ?? record.plan?.plan.summary);

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

      <StalenessBadge record={record} />

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
        {isCandidate && (
          <button
            onClick={onKeep}
            disabled={busy}
            title={m.keepHint}
            className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-md border border-border text-muted hover:text-foreground transition-colors disabled:opacity-40"
          >
            <ShieldCheck size={12} />
            {m.keep}
          </button>
        )}
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
