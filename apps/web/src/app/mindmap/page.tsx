"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/lib/theme-context";
import { useT } from "@/lib/app-i18n";

// The map is canvas-drawn outside React, so theme reaches the standalone draw
// helpers through this module-level flag, kept in sync by an effect.
let mmLight = false;

/**
 * Mind Map
 *
 * Dark "neural" map of the wiki. The graph is partitioned into a handful of
 * macro-concepts (clusters discovered by multi-source BFS from the most
 * connected nodes). To keep dense regions readable we DON'T show every atom
 * at once:
 *
 *   • Each dense cluster collapses into a single **macro atom** — a larger,
 *     pulsing, glowing bead that stands for the whole concept group.
 *   • Hovering a macro atom **explodes** it: its member atoms spring out on
 *     concentric rings, spaced so their labels never overlap, ready to click.
 *   • Moving the cursor away **re-collapses** the cluster back into the macro
 *     atom. Only one cluster is expanded at a time; the rest dim back.
 *
 * Small clusters (below the density threshold) stay permanently expanded —
 * there's nothing to hide. There is no central node: the macro atoms sit on a
 * ring around the origin and connect to each other with faint aggregate
 * links.
 */

interface RawNode {
  id: string;
  label: string;
  type: "concept" | "source" | "output";
  path: string;
  connections: number;
}
interface RawLink { source: string; target: string; }
interface GraphData { nodes: RawNode[]; links: RawLink[]; }

interface LaidOutNode {
  id: string;
  label: string;
  type: RawNode["type"];
  path: string;
  /** Exploded (fully expanded) absolute position. */
  ex: number;
  ey: number;
  r: number;
  color: string;
  clusterIndex: number;
  isHub: boolean;
  neighbors: string[];
}

interface ClusterInfo {
  index: number;
  label: string;
  color: string;
  /** Anchor — where the macro atom sits and where members collapse to. */
  ax: number;
  ay: number;
  macroR: number;
  count: number;
  collapsible: boolean;
  /** Cursor must stay within this radius of the anchor to keep it open. */
  expandZone: number;
  memberIds: string[];
  hubId: string;
}

interface IntraEdge { source: string; target: string; color: string; clusterIndex: number; }
interface InterEdge { a: number; b: number; color: string; count: number; }

interface LayoutResult {
  nodes: LaidOutNode[];
  clusters: ClusterInfo[];
  intraEdges: IntraEdge[];
  interEdges: InterEdge[];
  /** Member ids that have at least one real intra-cluster edge. */
  hasIntra: Set<string>;
}

const CLUSTER_PALETTE = [
  "#ef4f4f", // red
  "#f59e0b", // amber
  "#eab308", // yellow
  "#22c55e", // emerald
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#a855f7", // violet
  "#ec4899", // pink
];
const MISC_COLOR = "#8b93ad";

/** A cluster with at least this many members collapses into a macro atom. */
const MACRO_MIN = 6;

function chooseHubs(nodes: RawNode[], adj: Map<string, Set<string>>, k: number): string[] {
  const candidates = nodes
    .filter((n) => n.type === "concept")
    .map((n) => ({ id: n.id, score: adj.get(n.id)?.size ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const picked = candidates.slice(0, k).map((c) => c.id);
  // Fall back to any node type if there aren't enough concept hubs.
  if (picked.length < k) {
    for (const n of nodes) {
      if (picked.length >= k) break;
      if (!picked.includes(n.id)) picked.push(n.id);
    }
  }
  return picked;
}

function assignClusters(
  nodes: RawNode[],
  adj: Map<string, Set<string>>,
  hubs: string[],
): Map<string, number> {
  const cluster = new Map<string, number>();
  const distance = new Map<string, number>();
  const queue: { id: string; d: number; cluster: number }[] = [];
  for (let i = 0; i < hubs.length; i++) {
    cluster.set(hubs[i], i);
    distance.set(hubs[i], 0);
    queue.push({ id: hubs[i], d: 0, cluster: i });
  }
  let head = 0;
  while (head < queue.length) {
    const { id, d, cluster: c } = queue[head++];
    const neighbors = adj.get(id);
    if (!neighbors) continue;
    for (const nb of neighbors) {
      if (distance.has(nb)) continue;
      distance.set(nb, d + 1);
      cluster.set(nb, c);
      queue.push({ id: nb, d: d + 1, cluster: c });
    }
  }
  for (const n of nodes) if (!cluster.has(n.id)) cluster.set(n.id, -1);
  return cluster;
}

/**
 * Concentric-ring placement for a cluster's members. Index 0 is the hub at
 * the centre; the rest fill rings whose capacity grows with circumference so
 * adjacent atoms keep roughly `CELL_W` apart — enough room for their labels.
 */
function placeRings(count: number): { x: number; y: number }[] {
  const CELL_W = 104;
  const ROW_H = 34;
  const pos: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  let placed = 1;
  let ring = 0;
  let radius = 96;
  while (placed < count) {
    const circ = 2 * Math.PI * radius;
    const cap = Math.max(1, Math.floor(circ / CELL_W));
    for (let s = 0; s < cap && placed < count; s++) {
      const ang = (s / cap) * Math.PI * 2 + ring * 0.6;
      pos.push({ x: Math.cos(ang) * radius, y: Math.sin(ang) * radius });
      placed++;
    }
    ring++;
    radius += ROW_H + ring * 3;
  }
  return pos;
}

function buildLayout(data: GraphData): LayoutResult {
  const empty: LayoutResult = { nodes: [], clusters: [], intraEdges: [], interEdges: [], hasIntra: new Set() };
  if (data.nodes.length === 0) return empty;

  const adj = new Map<string, Set<string>>();
  for (const n of data.nodes) adj.set(n.id, new Set());
  for (const l of data.links) {
    adj.get(l.source)?.add(l.target);
    adj.get(l.target)?.add(l.source);
  }
  const rawById = new Map(data.nodes.map((n) => [n.id, n]));

  const desiredHubs = Math.min(CLUSTER_PALETTE.length, Math.max(3, Math.ceil(data.nodes.length / 12)));
  const hubIds = chooseHubs(data.nodes, adj, desiredHubs);
  const cluster = assignClusters(data.nodes, adj, hubIds);

  // Group members by their original hub index.
  const groups = new Map<number, string[]>();
  for (let i = 0; i < hubIds.length; i++) groups.set(i, []);
  const orphans: string[] = [];
  for (const n of data.nodes) {
    const c = cluster.get(n.id) ?? -1;
    if (c < 0) orphans.push(n.id);
    else groups.get(c)!.push(n.id);
  }

  // Raw cluster descriptors (hub-first member order), plus a misc bucket for
  // anything unreachable so no atom is ever left floating.
  interface Raw { origHub: string | null; members: string[]; misc: boolean; }
  const raws: Raw[] = [];
  for (let i = 0; i < hubIds.length; i++) {
    const members = groups.get(i) ?? [];
    if (members.length === 0) continue;
    // hub first
    const ordered = [hubIds[i], ...members.filter((m) => m !== hubIds[i])];
    raws.push({ origHub: hubIds[i], members: ordered, misc: false });
  }
  if (orphans.length > 0) raws.push({ origHub: null, members: orphans, misc: true });

  // Largest clusters first → consistent colour + placement.
  raws.sort((a, b) => b.members.length - a.members.length);

  const N = raws.length;
  const RING = 220 + N * 16;

  const nodes: LaidOutNode[] = [];
  const clusters: ClusterInfo[] = [];
  const nodeCluster = new Map<string, number>();

  for (let idx = 0; idx < N; idx++) {
    const raw = raws[idx];
    const color = raw.misc ? MISC_COLOR : CLUSTER_PALETTE[idx % CLUSTER_PALETTE.length];
    const angle = -Math.PI / 2 + (idx / N) * Math.PI * 2;
    const ax = Math.cos(angle) * RING;
    const ay = Math.sin(angle) * RING;
    const count = raw.members.length;
    const collapsible = count >= MACRO_MIN;
    const positions = placeRings(count);
    const maxR = positions.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), 0);
    const macroR = Math.min(38, 16 + Math.sqrt(count) * 2.8);
    const expandZone = maxR + 80;
    const hubId = raw.members[0];

    for (let k = 0; k < raw.members.length; k++) {
      const id = raw.members[k];
      const rn = rawById.get(id);
      if (!rn) continue;
      nodeCluster.set(id, idx);
      const isHub = k === 0 && !raw.misc;
      nodes.push({
        id,
        label: rn.label,
        type: rn.type,
        path: rn.path,
        ex: ax + positions[k].x,
        ey: ay + positions[k].y,
        r: isHub ? 11 : rn.type === "source" ? 6 : 8,
        color,
        clusterIndex: idx,
        isHub,
        neighbors: [...(adj.get(id) ?? [])],
      });
    }

    clusters.push({
      index: idx,
      label: raw.misc ? "Other" : rawById.get(hubId)?.label ?? "Cluster",
      color,
      ax,
      ay,
      macroR,
      count,
      collapsible,
      expandZone,
      memberIds: raw.members,
      hubId,
    });
  }

  // Edges: split into intra-cluster (drawn when a cluster is expanded) and
  // aggregated inter-cluster links (drawn faintly between anchors).
  const intraEdges: IntraEdge[] = [];
  const hasIntra = new Set<string>();
  const interAgg = new Map<string, InterEdge>();
  for (const l of data.links) {
    const ca = nodeCluster.get(l.source);
    const cb = nodeCluster.get(l.target);
    if (ca === undefined || cb === undefined) continue;
    if (ca === cb) {
      intraEdges.push({ source: l.source, target: l.target, color: clusters[ca].color, clusterIndex: ca });
      hasIntra.add(l.source);
      hasIntra.add(l.target);
    } else {
      const a = Math.min(ca, cb), b = Math.max(ca, cb);
      const key = `${a}-${b}`;
      const e = interAgg.get(key);
      if (e) e.count++;
      else interAgg.set(key, { a, b, color: clusters[a].color, count: 1 });
    }
  }

  return { nodes, clusters, intraEdges, interEdges: [...interAgg.values()], hasIntra };
}

export default function MindMapPage() {
  const { t } = useT();
  const tm = t.wiki.mindmap;
  const router = useRouter();
  const { theme } = useTheme();
  const light = theme === "light";
  useEffect(() => { mmLight = light; }, [light]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const zoom = useRef(1);
  const pan = useRef({ x: 0, y: 0 });
  const hovered = useRef<string | null>(null);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const lastMouse = useRef({ x: 0, y: 0 });
  const layoutRef = useRef<LayoutResult>({ nodes: [], clusters: [], intraEdges: [], interEdges: [], hasIntra: new Set() });
  const entryT = useRef(0);
  const hoverStart = useRef(0);
  const rafRef = useRef(0);
  const tStart = useRef(performance.now());

  // Cursor in graph coords + last screen position (so we can re-derive graph
  // coords after a pan/zoom without a fresh mousemove).
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const lastScreen = useRef<{ x: number; y: number } | null>(null);

  // Per-cluster expansion 0→1, eased every frame.
  const expansion = useRef<number[]>([]);
  const activeCluster = useRef(-1);
  // A cluster pinned open by the locate/search box (stays expanded until the
  // user clicks empty space).
  const pinnedCluster = useRef(-1);
  const [query, setQuery] = useState("");
  const [notFound, setNotFound] = useState(false);

  // Animated display positions for hit-testing, keyed by node id.
  const displayPos = useRef<Map<string, { x: number; y: number; r: number; alpha: number; cluster: number }>>(new Map());

  const layout = useMemo(() => buildLayout(graphData), [graphData]);
  layoutRef.current = layout;

  const nodeById = useMemo(() => {
    const m = new Map<string, LaidOutNode>();
    for (const n of layout.nodes) m.set(n.id, n);
    return m;
  }, [layout]);

  function screenToGraph(sx: number, sy: number): { x: number; y: number } {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (sx - rect.left - rect.width / 2 - pan.current.x) / zoom.current,
      y: (sy - rect.top - rect.height / 2 - pan.current.y) / zoom.current,
    };
  }

  function applyZoom(factor: number, sx: number, sy: number) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const newZoom = Math.min(6, Math.max(0.15, zoom.current * factor));
    const ratio = newZoom / zoom.current;
    const cx = sx - rect.left - rect.width / 2;
    const cy = sy - rect.top - rect.height / 2;
    pan.current = {
      x: cx - ratio * (cx - pan.current.x),
      y: cy - ratio * (cy - pan.current.y),
    };
    zoom.current = newZoom;
  }

  function fitToView() {
    const clusters = layoutRef.current.clusters;
    if (clusters.length === 0) {
      zoom.current = 1;
      pan.current = { x: 0, y: 0 };
      return;
    }
    // Fit the collapsed layout (anchors + macro radius + label room).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of clusters) {
      minX = Math.min(minX, c.ax - c.macroR - 70);
      maxX = Math.max(maxX, c.ax + c.macroR + 70);
      minY = Math.min(minY, c.ay - c.macroR - 30);
      maxY = Math.max(maxY, c.ay + c.macroR + 40);
    }
    const gW = maxX - minX, gH = maxY - minY;
    const cX = (minX + maxX) / 2, cY = (minY + maxY) / 2;
    const fz = Math.min((dimensions.width - 80) / gW, (dimensions.height - 80) / gH, 2.2);
    zoom.current = Math.max(0.25, fz);
    pan.current = { x: -cX * zoom.current, y: -cY * zoom.current };
  }

  useEffect(() => {
    function update() {
      if (containerRef.current) {
        setDimensions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => { loadGraph(); }, []);

  useEffect(() => {
    entryT.current = 0;
    expansion.current = layout.clusters.map((c) => (c.collapsible ? 0 : 1));
    activeCluster.current = -1;
    fitToView();
    tStart.current = performance.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, dimensions]);

  useEffect(() => {
    function tick() {
      const now = performance.now();
      const elapsed = (now - tStart.current) / 1000;
      entryT.current = Math.min(1, elapsed / 0.9);
      updateExpansion();
      draw(elapsed);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, dimensions, selectedNode]);

  /** Pick the cluster under the cursor and ease every cluster's expansion. */
  function updateExpansion() {
    const clusters = layoutRef.current.clusters;
    const exp = expansion.current;
    if (exp.length !== clusters.length) {
      expansion.current = clusters.map((c) => (c.collapsible ? 0 : 1));
    }

    // While panning, FREEZE the active cluster: a drag must never collapse an
    // expanded macro atom. We only re-pick the active cluster when not
    // dragging.
    if (!isDragging.current) {
      if (lastScreen.current) {
        cursor.current = screenToGraph(lastScreen.current.x, lastScreen.current.y);
      }
      let active = -1;
      if (cursor.current) {
        let bestD = Infinity;
        for (const c of clusters) {
          if (!c.collapsible) continue;
          const e = expansion.current[c.index] ?? 0;
          const d = Math.hypot(cursor.current.x - c.ax, cursor.current.y - c.ay);
          // Hysteresis: need to be near the macro atom to OPEN, but only need
          // to stay within the (larger) explosion zone to STAY open.
          const thr = e > 0.4 ? c.expandZone : c.macroR + 38;
          if (d < thr && d < bestD) { bestD = d; active = c.index; }
        }
      }
      activeCluster.current = active;
    }
    const active = activeCluster.current;

    const pinned = pinnedCluster.current;
    for (const c of clusters) {
      const target = c.collapsible ? (c.index === active || c.index === pinned ? 1 : 0) : 1;
      const cur = expansion.current[c.index] ?? 0;
      let next = cur + (target - cur) * 0.16;
      if (Math.abs(next - target) < 0.002) next = target;
      expansion.current[c.index] = next;
    }
  }

  function draw(time: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = dimensions.width, H = dimensions.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawBackground(ctx, W, H);

    const { nodes, clusters, intraEdges, interEdges, hasIntra } = layoutRef.current;
    if (clusters.length === 0) return;

    ctx.save();
    ctx.translate(W / 2 + pan.current.x, H / 2 + pan.current.y);
    ctx.scale(zoom.current, zoom.current);

    const p = easeOut(entryT.current);
    const exp = expansion.current;
    const maxExp = clusters.reduce((m, c) => (c.collapsible ? Math.max(m, exp[c.index] ?? 0) : m), 0);

    // Display positions: lerp each member between its cluster anchor
    // (collapsed) and its exploded slot, per the cluster's expansion.
    const disp = new Map<string, { x: number; y: number; r: number; alpha: number; cluster: number; node: LaidOutNode }>();
    for (const n of nodes) {
      const c = clusters[n.clusterIndex];
      const e = exp[n.clusterIndex] ?? 0;
      const x = lerp(c.ax, n.ex, e);
      const y = lerp(c.ay, n.ey, e);
      const alpha = (c.collapsible ? e : 1) * p;
      disp.set(n.id, { x, y, r: n.r, alpha, cluster: n.clusterIndex, node: n });
    }
    displayPos.current = new Map([...disp].map(([k, v]) => [k, { x: v.x, y: v.y, r: v.r, alpha: v.alpha, cluster: v.cluster }]));

    const activeId = hovered.current ?? selectedNode;
    const hoveredNode = activeId ? nodeById.get(activeId) : undefined;
    const hovNeighbors = hoveredNode ? new Set(hoveredNode.neighbors) : null;

    // INTER-CLUSTER aggregate links — fade as anything expands.
    for (const e of interEdges) {
      const a = clusters[e.a], b = clusters[e.b];
      const fade = 1 - Math.max(exp[e.a] ?? 0, exp[e.b] ?? 0);
      const op = 0.12 * p * fade;
      if (op < 0.01) continue;
      drawCurve(ctx, a.ax, a.ay, b.ax, b.ay, e.color, op, 1 + Math.min(2, e.count * 0.3));
    }

    // INTRA-CLUSTER edges — only meaningful once the cluster opens.
    for (const e of intraEdges) {
      const ce = exp[e.clusterIndex] ?? 0;
      if (ce < 0.05) continue;
      const a = disp.get(e.source), b = disp.get(e.target);
      if (!a || !b) continue;
      drawCurve(ctx, a.x, a.y, b.x, b.y, e.color, 0.22 * ce * p, 1.1);
    }
    // Spokes for members with no intra edge, so nothing floats when exploded.
    for (const c of clusters) {
      const ce = exp[c.index] ?? 0;
      if (ce < 0.05) continue;
      const hub = disp.get(c.hubId);
      if (!hub) continue;
      for (const mid of c.memberIds) {
        if (mid === c.hubId || hasIntra.has(mid)) continue;
        const m = disp.get(mid);
        if (!m) continue;
        drawCurve(ctx, hub.x, hub.y, m.x, m.y, c.color, 0.1 * ce * p, 0.7);
      }
    }

    // SPARKS along the hovered member's intra edges.
    if (hovered.current) {
      const hid = hovered.current;
      const hoverElapsed = time - hoverStart.current;
      for (const e of intraEdges) {
        let a, b;
        if (e.source === hid) { a = disp.get(e.source); b = disp.get(e.target); }
        else if (e.target === hid) { a = disp.get(e.target); b = disp.get(e.source); }
        if (!a || !b) continue;
        drawSpark(ctx, a.x, a.y, b.x, b.y, e.color, (hoverElapsed * 0.95) % 1, p);
        drawSpark(ctx, a.x, a.y, b.x, b.y, e.color, ((hoverElapsed * 0.95) + 0.5) % 1, p);
      }
    }

    // MACRO ATOMS — pulsing/glowing beads for collapsed clusters. Fade out as
    // the cluster expands; dim non-active clusters while one is open.
    for (const c of clusters) {
      if (!c.collapsible) continue;
      const e = exp[c.index] ?? 0;
      let a = (1 - e) * p;
      if (activeCluster.current >= 0 && c.index !== activeCluster.current) a *= 1 - maxExp * 0.75;
      if (a < 0.02) continue;
      drawMacroAtom(ctx, c, a, time);
    }

    // MEMBER nodes (hub last within its cluster so it sits on top).
    const order = [...disp.values()].sort((x, y) => (x.node.isHub ? 1 : 0) - (y.node.isHub ? 1 : 0));

    if (hovered.current) {
      const h = disp.get(hovered.current);
      if (h && h.alpha > 0.4) drawNeuronPulse(ctx, h.x, h.y, h.r, h.node.color, time - hoverStart.current);
    }

    for (const d of order) {
      if (d.alpha < 0.02) continue;
      const isActive = activeId === d.node.id;
      // Dim non-neighbour members of the same cluster while hovering one.
      let a = d.alpha;
      if (hoveredNode && hoveredNode.clusterIndex === d.cluster && hovNeighbors) {
        if (d.node.id !== activeId && !hovNeighbors.has(d.node.id)) a *= 0.45;
      }
      drawBead(ctx, d.x, d.y, d.r, d.node.color, a, isActive, d.node.isHub);
    }

    // LABELS — greedy collision avoidance. Macro labels (collapsed clusters)
    // and the hovered/expanded members compete for space; whatever can't fit
    // without overlapping a higher-priority label is dropped.
    interface Cand { box: LabelBox; color: string; textAlpha: number; bgAlpha: number; prio: number; }
    const cands: Cand[] = [];

    for (const c of clusters) {
      if (!c.collapsible) continue;
      const e = exp[c.index] ?? 0;
      let a = (1 - e) * p;
      if (activeCluster.current >= 0 && c.index !== activeCluster.current) a *= 1 - maxExp * 0.75;
      if (a < 0.15) continue;
      const text = `${truncate(c.label, 18)}  ·${c.count}`;
      const box = measureLabel(ctx, c.ax, c.ay, c.macroR, text, 12, 600);
      cands.push({ box, color: c.color, textAlpha: a, bgAlpha: 0.6 * a, prio: 800 + c.count });
    }

    for (const d of order) {
      const c = clusters[d.cluster];
      const e = exp[d.cluster] ?? 0;
      // Members get labels when their cluster is (near) open, or always for
      // permanently-expanded small clusters.
      const show = c.collapsible ? e > 0.55 : true;
      if (!show || d.alpha < 0.2) continue;
      const focused = !activeId || activeId === d.node.id || (hovNeighbors?.has(d.node.id) ?? false);
      const text = truncate(d.node.label, 24);
      const fs = d.node.isHub ? 11 : 10;
      const box = measureLabel(ctx, d.x, d.y, d.r, text, fs, d.node.isHub ? 600 : 500);
      const prio =
        (activeId === d.node.id ? 1000 : 0) +
        (focused ? 200 : 0) +
        e * 100 +
        (d.node.isHub ? 60 : 0) +
        d.node.neighbors.length * 0.3;
      cands.push({
        box,
        color: d.node.color,
        textAlpha: (focused ? 1 : 0.7) * Math.min(1, d.alpha + 0.2),
        bgAlpha: 0.55 * d.alpha,
        prio,
      });
    }

    cands.sort((a, b) => b.prio - a.prio);
    const placed: LabelBox[] = [];
    for (const cand of cands) {
      let clash = false;
      for (const q of placed) { if (rectsOverlap(cand.box, q, 3)) { clash = true; break; } }
      if (clash) continue;
      placed.push(cand.box);
      drawLabelBox(ctx, cand.box, cand.color, cand.textAlpha, cand.bgAlpha);
    }

    ctx.restore();
  }

  function nodeAt(cx: number, cy: number): LaidOutNode | null {
    const g = screenToGraph(cx, cy);
    let best: LaidOutNode | null = null;
    let bestD = Infinity;
    for (const n of layoutRef.current.nodes) {
      const d = displayPos.current.get(n.id);
      if (!d || d.alpha < 0.35) continue;
      const dx = g.x - d.x, dy = g.y - d.y;
      const hitR = d.r + 8;
      const dd = dx * dx + dy * dy;
      if (dd < hitR * hitR && dd < bestD) { bestD = dd; best = n; }
    }
    return best;
  }

  function onMouseMove(e: React.MouseEvent) {
    lastScreen.current = { x: e.clientX, y: e.clientY };
    cursor.current = screenToGraph(e.clientX, e.clientY);
    const n = nodeAt(e.clientX, e.clientY);
    const resolvedId = n?.id ?? null;
    if (resolvedId !== hovered.current) {
      hovered.current = resolvedId;
      hoverStart.current = (performance.now() - tStart.current) / 1000;
    }
    if (canvasRef.current && !isDragging.current) {
      canvasRef.current.style.cursor = n ? "pointer" : "grab";
    }
  }

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragStart.current = { x: e.clientX, y: e.clientY };
    lastMouse.current = { x: e.clientX, y: e.clientY };

    // Only treat this as a pan once the pointer actually moves past the
    // threshold. A stationary click must NOT flip isDragging — otherwise the
    // expansion logic would briefly collapse the hovered cluster mid-click.
    let dragging = false;
    function onMove(ev: MouseEvent) {
      if (!dragging) {
        const m = Math.abs(ev.clientX - dragStart.current.x) + Math.abs(ev.clientY - dragStart.current.y);
        if (m < 5) return;
        dragging = true;
        isDragging.current = true;
        if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
      }
      const dx = ev.clientX - lastMouse.current.x;
      const dy = ev.clientY - lastMouse.current.y;
      pan.current = { x: pan.current.x + dx, y: pan.current.y + dy };
      lastMouse.current = { x: ev.clientX, y: ev.clientY };
    }
    function onUp(ev: MouseEvent) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      isDragging.current = false;
      lastScreen.current = { x: ev.clientX, y: ev.clientY };
      if (canvasRef.current) canvasRef.current.style.cursor = "grab";
      const moved = Math.abs(ev.clientX - dragStart.current.x) + Math.abs(ev.clientY - dragStart.current.y);
      if (moved < 5) {
        const n = nodeAt(ev.clientX, ev.clientY);
        if (n) {
          if (selectedNode === n.id) router.push(`/wiki?path=${encodeURIComponent(n.path)}`);
          else setSelectedNode(n.id);
        } else {
          setSelectedNode(null);
          pinnedCluster.current = -1; // clicking empty space un-pins a located cluster
        }
      }
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Trackpad / wheel: pinch (or ctrl+wheel) zooms toward the cursor, plain
  // two-finger scroll pans. Bound to the always-mounted container so it
  // attaches even before graph data (and the canvas) load.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      lastScreen.current = { x: e.clientX, y: e.clientY };
      if (e.ctrlKey) {
        applyZoom(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      } else {
        pan.current = { x: pan.current.x - e.deltaX, y: pan.current.y - e.deltaY };
      }
      cursor.current = screenToGraph(e.clientX, e.clientY);
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadGraph = useCallback(async () => {
    try {
      const res = await fetch("/api/wiki/graph");
      setGraphData(await res.json());
    } catch {
      setGraphData({ nodes: [], links: [] });
    }
  }, []);

  // Find a concept and reveal it: expand its macro cluster, select it, and
  // centre the view on it. Solves "I synced/have X but can't find it".
  function locate(q: string) {
    const term = q.trim().toLowerCase();
    if (!term) return;
    const nodes = layoutRef.current.nodes;
    const hit =
      nodes.find((n) => n.label.toLowerCase() === term || n.id.toLowerCase() === term) ??
      nodes.find((n) => n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term));
    if (!hit) { setNotFound(true); return; }
    setNotFound(false);
    setSelectedNode(hit.id);
    pinnedCluster.current = hit.clusterIndex;
    // Centre on the node's exploded position.
    const z = Math.max(zoom.current, 1.1);
    zoom.current = z;
    pan.current = { x: -hit.ex * z, y: -hit.ey * z };
  }

  return (
    <div className="flex-1 flex flex-col">
      <div className="h-12 border-b border-border flex items-center justify-between px-6 shrink-0 gap-4">
        <h1 className="text-sm font-medium shrink-0">Mind Map</h1>
        <div className="flex items-center gap-3 flex-1 justify-end">
          <div className="relative w-56 max-w-[40vw]">
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setNotFound(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") locate(query); }}
              placeholder={tm.findPlaceholder}
              className={`w-full px-3 py-1.5 bg-card border rounded-lg text-xs text-foreground placeholder:text-muted/40 focus:outline-none focus:border-accent/50 ${notFound ? "border-red-500/50" : "border-border"}`}
            />
            {notFound && <span className="absolute -bottom-4 left-1 text-[10px] text-red-400/80">{tm.notFound}</span>}
          </div>
          <button
            onClick={() => locate(query)}
            className="text-[11px] text-muted/60 hover:text-foreground transition-colors shrink-0"
            title={tm.locate}
          >{tm.locate}</button>
          <button
            onClick={() => loadGraph()}
            className="text-muted/50 hover:text-foreground transition-colors shrink-0"
            title={tm.refreshTitle}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
          <span className="text-[11px] text-muted/30 shrink-0">{tm.stats(graphData.nodes.length, graphData.links.length)}</span>
        </div>
      </div>

      <div ref={containerRef} className="flex-1 relative" style={{ background: light ? "#eef2f8" : "#05060d" }}>
        {graphData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-muted">
              <div className="text-5xl mb-4">🕸️</div>
              <p className="text-sm text-muted/50">{tm.empty}</p>
            </div>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            style={{ width: dimensions.width, height: dimensions.height }}
            className="absolute inset-0"
            onMouseMove={onMouseMove}
            onMouseDown={onMouseDown}
            onMouseLeave={() => { hovered.current = null; cursor.current = null; lastScreen.current = null; }}
          />
        )}

        <div className="absolute bottom-6 right-6 z-20 flex flex-col gap-1">
          <button
            onClick={() => { const r = canvasRef.current?.getBoundingClientRect(); if (r) applyZoom(1.3, r.left + r.width / 2, r.top + r.height / 2); }}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-card/80 backdrop-blur-sm border border-border text-foreground/70 hover:text-foreground hover:bg-card transition-colors text-sm font-medium"
            title={tm.zoomIn}
          >+</button>
          <button
            onClick={() => { const r = canvasRef.current?.getBoundingClientRect(); if (r) applyZoom(0.7, r.left + r.width / 2, r.top + r.height / 2); }}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-card/80 backdrop-blur-sm border border-border text-foreground/70 hover:text-foreground hover:bg-card transition-colors text-sm font-medium"
            title={tm.zoomOut}
          >−</button>
          <button
            onClick={fitToView}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-card/80 backdrop-blur-sm border border-border text-foreground/70 hover:text-foreground hover:bg-card transition-colors"
            title={tm.resetView}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 1 9 9"/><polyline points="3 21 3 12 12 12"/></svg>
          </button>
        </div>

        {selectedNode && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20">
            <div className="bg-card/90 backdrop-blur-md border border-border rounded-xl px-5 py-3 shadow-2xl flex items-center gap-4">
              <div>
                <p className="text-sm font-medium">{graphData.nodes.find((n) => n.id === selectedNode)?.label}</p>
                <p className="text-[11px] text-muted/50 mt-0.5">{tm.clickAgain}</p>
              </div>
              <button
                onClick={() => {
                  const n = graphData.nodes.find((n) => n.id === selectedNode);
                  if (n) router.push(`/wiki?path=${encodeURIComponent(n.path)}`);
                }}
                className="px-3 py-1.5 bg-accent text-background text-xs font-medium rounded-lg hover:bg-accent-hover transition-colors"
              >{tm.open}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── drawing helpers ─────────────────────────

function easeOut(t: number): number { return 1 - Math.pow(1 - t, 3); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const cx = W / 2, cy = H / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
  if (mmLight) {
    g.addColorStop(0, "#fbfcfe");
    g.addColorStop(0.6, "#eef2f8");
    g.addColorStop(1, "#e2e8f2");
  } else {
    g.addColorStop(0, "#0d1228");
    g.addColorStop(0.6, "#07091a");
    g.addColorStop(1, "#03040b");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const step = 28;
  ctx.fillStyle = mmLight ? "rgba(70, 90, 140, 0.10)" : "rgba(150, 170, 220, 0.06)";
  for (let y = step / 2; y < H; y += step) {
    for (let x = step / 2; x < W; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A gently-curved connector between two points. */
function drawCurve(
  ctx: CanvasRenderingContext2D,
  ax: number, ay: number, bx: number, by: number,
  color: string, op: number, width: number,
) {
  if (op <= 0) return;
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  const nx = -dy / len, ny = dx / len;
  const bend = Math.min(len * 0.15, 34);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.bezierCurveTo(
    ax + dx * 0.35 + nx * bend, ay + dy * 0.35 + ny * bend,
    ax + dx * 0.65 + nx * bend, ay + dy * 0.65 + ny * bend,
    bx, by,
  );
  ctx.strokeStyle = color + alpha(op);
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawSpark(
  ctx: CanvasRenderingContext2D,
  ax: number, ay: number, bx: number, by: number,
  color: string, phase: number, p: number,
) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  const nx = -dy / len, ny = dx / len;
  const bend = Math.min(len * 0.15, 34);
  const cp1x = ax + dx * 0.35 + nx * bend, cp1y = ay + dy * 0.35 + ny * bend;
  const cp2x = ax + dx * 0.65 + nx * bend, cp2y = ay + dy * 0.65 + ny * bend;
  const t = phase, omt = 1 - t;
  const x = omt * omt * omt * ax + 3 * omt * omt * t * cp1x + 3 * omt * t * t * cp2x + t * t * t * bx;
  const y = omt * omt * omt * ay + 3 * omt * omt * t * cp1y + 3 * omt * t * t * cp2y + t * t * t * by;
  const fade = Math.sin(Math.PI * t);
  const a0 = 0.95 * fade * p;
  const r = 3.2;
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
  grad.addColorStop(0, color + alpha(a0));
  grad.addColorStop(0.4, color + alpha(a0 * 0.45));
  grad.addColorStop(1, color + alpha(0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r * 4, 0, Math.PI * 2);
  ctx.fill();
}

/** The macro atom: a big glowing bead with a slow breathing pulse + ring. */
function drawMacroAtom(ctx: CanvasRenderingContext2D, c: ClusterInfo, a: number, time: number) {
  const { ax, ay, macroR, color } = c;
  const pulse = 0.5 + 0.5 * Math.sin(time * 2.2 + c.index);

  // Expanding ripple ring — neuron-like, signals "I can open".
  const ringT = (time * 0.6 + c.index * 0.3) % 1;
  const ringR = macroR * (1.1 + ringT * 1.6);
  ctx.beginPath();
  ctx.arc(ax, ay, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = color + alpha((1 - ringT) * 0.35 * a);
  ctx.lineWidth = 1.6 * (1 - ringT * 0.5);
  ctx.stroke();

  // Soft outer glow, breathing.
  const glowR = macroR * (2.4 + pulse * 0.5);
  const glow = ctx.createRadialGradient(ax, ay, 0, ax, ay, glowR);
  glow.addColorStop(0, color + alpha((0.5 + pulse * 0.2) * a));
  glow.addColorStop(0.5, color + alpha(0.14 * a));
  glow.addColorStop(1, color + alpha(0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(ax, ay, glowR, 0, Math.PI * 2);
  ctx.fill();

  // Core bead.
  const r = macroR * (1 + pulse * 0.04);
  const bead = ctx.createRadialGradient(ax - r * 0.35, ay - r * 0.4, 0, ax, ay, r);
  bead.addColorStop(0, color + alpha(0.98 * a));
  bead.addColorStop(0.7, color + alpha(0.7 * a));
  bead.addColorStop(1, color + alpha(0.25 * a));
  ctx.fillStyle = bead;
  ctx.beginPath();
  ctx.arc(ax, ay, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = color + alpha(0.6 * a);
  ctx.stroke();

  // Specular highlight.
  ctx.beginPath();
  ctx.arc(ax - r * 0.32, ay - r * 0.4, Math.max(2, r * 0.16), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${0.55 * a})`;
  ctx.fill();
}

/** A normal member / hub bead. */
function drawBead(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r0: number, color: string,
  a: number, active: boolean, isHub: boolean,
) {
  const r = r0 * (active ? 1.18 : 1);
  const glowR = r * 3.2;
  const glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
  glow.addColorStop(0, color + alpha(0.35 * a * (active ? 1.3 : 1)));
  glow.addColorStop(0.5, color + alpha(0.1 * a));
  glow.addColorStop(1, color + alpha(0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, glowR, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  const bead = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, 0, x, y, r);
  bead.addColorStop(0, color + alpha(0.95 * a));
  bead.addColorStop(0.7, color + alpha(0.65 * a));
  bead.addColorStop(1, color + alpha(0.18 * a));
  ctx.fillStyle = bead;
  ctx.fill();
  ctx.strokeStyle = color + alpha((isHub ? 0.7 : 0.5) * a);
  ctx.lineWidth = isHub ? 1.1 : 0.8;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x - r * 0.32, y - r * 0.4, Math.max(1.4, r * 0.18), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${(active ? 0.65 : 0.4) * a})`;
  ctx.fill();
}

function drawNeuronPulse(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r0: number, color: string, hoverElapsed: number,
) {
  const RING_DUR = 1.2, STAGGER = 0.4;
  for (let i = 0; i < 3; i++) {
    const t = ((hoverElapsed - i * STAGGER) % RING_DUR) / RING_DUR;
    if (t < 0) continue;
    const ringR = r0 * (1.4 + t * 4);
    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = color + alpha((1 - t) * 0.35);
    ctx.lineWidth = 1.6 * (1 - t * 0.5);
    ctx.stroke();
  }
  const corePulse = 0.5 + 0.5 * Math.sin(hoverElapsed * 4);
  const coreR = r0 * (1.6 + corePulse * 0.25);
  const g = ctx.createRadialGradient(x, y, 0, x, y, coreR * 2);
  g.addColorStop(0, color + alpha(0.5 + corePulse * 0.2));
  g.addColorStop(1, color + alpha(0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, coreR * 2, 0, Math.PI * 2);
  ctx.fill();
}

// ───────────────────────── labels ─────────────────────────

interface LabelBox { x: number; y: number; w: number; h: number; text: string; fs: number; weight: number; }

function measureLabel(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, belowR: number,
  text: string, fs: number, weight: number,
): LabelBox {
  ctx.font = `${weight} ${fs}px Inter, system-ui, sans-serif`;
  const padX = 8, padY = 4;
  const w = ctx.measureText(text).width + padX * 2;
  const h = fs + padY * 2;
  return { x: cx - w / 2, y: cy + belowR + 6, w, h, text, fs, weight };
}

function rectsOverlap(a: LabelBox, b: LabelBox, gap: number): boolean {
  return !(
    a.x > b.x + b.w + gap ||
    a.x + a.w + gap < b.x ||
    a.y > b.y + b.h + gap ||
    a.y + a.h + gap < b.y
  );
}

function drawLabelBox(ctx: CanvasRenderingContext2D, box: LabelBox, color: string, textAlpha: number, bgAlpha: number) {
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, 5);
  ctx.fillStyle = mmLight ? `rgba(255, 255, 255, ${Math.min(1, bgAlpha + 0.35)})` : `rgba(8, 10, 24, ${bgAlpha})`;
  ctx.fill();
  ctx.strokeStyle = color + alpha((mmLight ? 0.45 : 0.2) * textAlpha);
  ctx.lineWidth = mmLight ? 0.8 : 0.6;
  ctx.stroke();

  ctx.font = `${box.weight} ${box.fs}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = mmLight ? `rgba(24, 28, 40, ${textAlpha})` : `rgba(228, 233, 248, ${textAlpha})`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(box.text, box.x + box.w / 2, box.y + box.h / 2);
}

function alpha(a: number): string {
  const v = Math.max(0, Math.min(1, a));
  return Math.round(v * 255).toString(16).padStart(2, "0");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
