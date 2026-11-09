import { type LatLng, type Pt, toLocal, dist } from "./geo";

export interface Graph {
  origin: LatLng;
  lat: Float64Array;
  lng: Float64Array;
  xs: Float64Array;
  ys: Float64Array;
  /** CSR adjacency: neighbors of i are adjTo[adjStart[i] .. adjStart[i+1]) */
  adjStart: Int32Array;
  adjTo: Int32Array;
  adjLen: Float64Array;
  cell: number;
  grid: Map<string, number[]>;
  /** covered area, in degrees */
  bbox: { s: number; w: number; n: number; e: number };
}

export interface RawNode {
  id: number;
  lat: number;
  lng: number;
}

/** Builds a walkable graph from nodes + ways (node id sequences), keeping only the largest connected component. */
export function buildGraph(
  rawNodes: RawNode[],
  ways: number[][],
  origin: LatLng,
  bbox: Graph["bbox"],
): Graph {
  const byId = new Map<number, RawNode>();
  for (const n of rawNodes) byId.set(n.id, n);

  const idx = new Map<number, number>();
  const nodes: RawNode[] = [];
  const edges: [number, number][] = [];
  const getIdx = (id: number) => {
    let i = idx.get(id);
    if (i === undefined) {
      i = nodes.length;
      idx.set(id, i);
      nodes.push(byId.get(id)!);
    }
    return i;
  };
  for (const w of ways) {
    for (let k = 1; k < w.length; k++) {
      if (!byId.has(w[k - 1]) || !byId.has(w[k]) || w[k - 1] === w[k]) continue;
      edges.push([getIdx(w[k - 1]), getIdx(w[k])]);
    }
  }

  // adjacency lists
  const n = nodes.length;
  const tmp: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    tmp[a].push(b);
    tmp[b].push(a);
  }

  // largest connected component
  const comp = new Int32Array(n).fill(-1);
  let bestComp = -1;
  let bestSize = 0;
  let c = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    let size = 0;
    const q = [s];
    comp[s] = c;
    while (q.length) {
      const u = q.pop()!;
      size++;
      for (const v of tmp[u]) if (comp[v] === -1) {
        comp[v] = c;
        q.push(v);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestComp = c;
    }
    c++;
  }

  const remap = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) if (comp[i] === bestComp) remap[i] = m++;

  const lat = new Float64Array(m);
  const lng = new Float64Array(m);
  const xs = new Float64Array(m);
  const ys = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const j = remap[i];
    if (j < 0) continue;
    lat[j] = nodes[i].lat;
    lng[j] = nodes[i].lng;
    const p = toLocal(origin, { lat: nodes[i].lat, lng: nodes[i].lng });
    xs[j] = p.x;
    ys[j] = p.y;
  }

  const adjStart = new Int32Array(m + 1);
  for (let i = 0; i < n; i++) if (remap[i] >= 0) adjStart[remap[i] + 1] = new Set(tmp[i]).size;
  for (let i = 0; i < m; i++) adjStart[i + 1] += adjStart[i];
  const adjTo = new Int32Array(adjStart[m]);
  const adjLen = new Float64Array(adjStart[m]);
  for (let i = 0; i < n; i++) {
    const j = remap[i];
    if (j < 0) continue;
    let k = adjStart[j];
    for (const v of new Set(tmp[i])) {
      const vj = remap[v];
      adjTo[k] = vj;
      adjLen[k] = Math.hypot(xs[j] - xs[vj], ys[j] - ys[vj]);
      k++;
    }
  }

  const cell = 100;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < m; i++) {
    const key = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`;
    let arr = grid.get(key);
    if (!arr) grid.set(key, (arr = []));
    arr.push(i);
  }

  return { origin, lat, lng, xs, ys, adjStart, adjTo, adjLen, cell, grid, bbox };
}

export function nodeCount(g: Graph) {
  return g.xs.length;
}

export function nearestNode(g: Graph, p: Pt): number {
  const cx = Math.floor(p.x / g.cell);
  const cy = Math.floor(p.y / g.cell);
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r < 200; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = g.grid.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const i of arr) {
          const d = Math.hypot(g.xs[i] - p.x, g.ys[i] - p.y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    // any node in a farther ring is at least r*cell away
    if (best >= 0 && bestD <= r * g.cell) break;
  }
  return best;
}

/** Typical block size (m) near `center`, from intersection density. */
export function estimateBlockSize(g: Graph, center: Pt, radius: number): number {
  // Sidewalks and crosswalks mapped as separate ways create clusters of junctions
  // around each real intersection, so count occupied ~40 m cells instead of raw nodes.
  const cells = new Set<string>();
  const m = nodeCount(g);
  const c = 40;
  for (let i = 0; i < m; i++) {
    if (g.adjStart[i + 1] - g.adjStart[i] < 3) continue;
    if (dist({ x: g.xs[i], y: g.ys[i] }, center) <= radius) cells.add(`${Math.floor(g.xs[i] / c)},${Math.floor(g.ys[i] / c)}`);
  }
  const count = cells.size;
  if (count < 4) return 200;
  const b = Math.sqrt((Math.PI * radius * radius) / count);
  return Math.max(50, Math.min(400, b));
}
