import { type Pt, type LatLng, dist, distToSeg, distToPolyline, rdp, resample, bounds, pathLength } from "./geo";
import { type Graph, nearestNode, nodeCount } from "./graph";

export interface RouteResult {
  nodes: number[];
  local: Pt[];
  latlngs: LatLng[];
  lengthM: number;
  /** 0–100: how closely the route traces the drawing */
  fidelity: number;
  meanDevM: number;
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k,
      v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k,
      v = this.v;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

/** Reusable A* buffers per graph (avoids reallocating for every segment). */
const buffers = new WeakMap<Graph, { g: Float64Array; prev: Int32Array; stamp: Uint32Array; closed: Uint32Array; cur: number }>();

/**
 * A* from `src` to `dst`, where each edge costs its length times a penalty that grows
 * with the distance of the edge from the target segment a→b (keeps the route on the stroke).
 */
function corridorPath(g: Graph, src: number, dst: number, a: Pt, b: Pt, blockM: number): number[] | null {
  if (src === dst) return [src];
  const n = nodeCount(g);
  let buf = buffers.get(g);
  if (!buf) {
    buf = { g: new Float64Array(n), prev: new Int32Array(n), stamp: new Uint32Array(n), closed: new Uint32Array(n), cur: 0 };
    buffers.set(g, buf);
  }
  const run = ++buf.cur;
  const { xs, ys, adjStart, adjTo, adjLen } = g;
  const gx = xs[dst],
    gy = ys[dst];
  const K = 3;
  const heap = new MinHeap();
  buf.stamp[src] = run;
  buf.g[src] = 0;
  buf.prev[src] = -1;
  heap.push(Math.hypot(xs[src] - gx, ys[src] - gy), src);

  while (heap.size) {
    const u = heap.pop();
    if (buf.closed[u] === run) continue;
    buf.closed[u] = run;
    if (u === dst) break;
    const gu = buf.g[u];
    for (let e = adjStart[u]; e < adjStart[u + 1]; e++) {
      const v = adjTo[e];
      if (buf.closed[v] === run) continue;
      const mid = { x: (xs[u] + xs[v]) / 2, y: (ys[u] + ys[v]) / 2 };
      const d = distToSeg(mid, a, b) / blockM;
      const cost = adjLen[e] * (1 + K * Math.min(d * d, 16));
      const ng = gu + cost;
      if (buf.stamp[v] !== run || ng < buf.g[v]) {
        buf.stamp[v] = run;
        buf.g[v] = ng;
        buf.prev[v] = u;
        heap.push(ng + Math.hypot(xs[v] - gx, ys[v] - gy), v);
      }
    }
  }
  if (buf.closed[dst] !== run) return null;
  const path: number[] = [];
  for (let u = dst; u !== -1; u = buf.prev[u]) path.push(u);
  return path.reverse();
}

/** Removes short out-and-back spurs (x→y→x) created when a waypoint snaps to a node off the line. */
function removeSpurs(g: Graph, nodes: number[], maxSpurM: number): number[] {
  const st: number[] = [];
  for (const u of nodes) {
    if (st.length && st[st.length - 1] === u) continue;
    if (st.length >= 2 && st[st.length - 2] === u) {
      const y = st[st.length - 1];
      if (Math.hypot(g.xs[u] - g.xs[y], g.ys[u] - g.ys[y]) < maxSpurM) {
        st.pop();
        continue;
      }
    }
    st.push(u);
  }
  return st;
}

export function scoreRoute(route: Pt[], target: Pt[]) {
  const t = rdp(target, 2);
  const r = rdp(route, 2);
  const rs = resample(route, 15);
  const ts = resample(target, 15);
  let a = 0;
  for (const p of rs) a += distToPolyline(p, t);
  let b = 0;
  for (const p of ts) b += distToPolyline(p, r);
  const meanDevM = (a / rs.length + b / ts.length) / 2;
  const diag = bounds(target).diag || 1;
  const fidelity = Math.max(0, Math.min(100, 100 * (1 - meanDevM / (0.12 * diag))));
  return { meanDevM, fidelity };
}

/** Routes along walkable streets following `target` (local meters in the graph's frame). */
export function routeDrawing(g: Graph, target: Pt[], blockM: number): RouteResult | null {
  if (target.length < 2) return null;
  // waypoints: drawing corners, plus subdivisions of long straight strokes
  const corners = rdp(target, blockM * 0.25);
  const wps: Pt[] = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1],
      b = corners[i];
    const pieces = Math.max(1, Math.ceil(dist(a, b) / (blockM * 2.5)));
    for (let k = 1; k <= pieces; k++) wps.push({ x: a.x + ((b.x - a.x) * k) / pieces, y: a.y + ((b.y - a.y) * k) / pieces });
  }
  const snapped = wps.map((p) => nearestNode(g, p));
  if (snapped.some((s) => s < 0)) return null;

  let nodes: number[] = [snapped[0]];
  for (let i = 1; i < snapped.length; i++) {
    const seg = corridorPath(g, snapped[i - 1], snapped[i], wps[i - 1], wps[i], blockM);
    if (!seg) continue;
    for (let k = 1; k < seg.length; k++) nodes.push(seg[k]);
  }
  nodes = removeSpurs(g, nodes, blockM * 0.6);

  const local = nodes.map((i) => ({ x: g.xs[i], y: g.ys[i] }));
  const latlngs = nodes.map((i) => ({ lat: g.lat[i], lng: g.lng[i] }));
  const { meanDevM, fidelity } = scoreRoute(local, target);
  return { nodes, local, latlngs, lengthM: pathLength(local), fidelity, meanDevM };
}
