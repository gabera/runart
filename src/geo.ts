export interface Pt {
  x: number;
  y: number;
}
export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6371008.8;
const D2R = Math.PI / 180;

/** Equirectangular projection to local meters around `o` (x = east, y = north). */
export function toLocal(o: LatLng, p: LatLng): Pt {
  return {
    x: (p.lng - o.lng) * D2R * R * Math.cos(o.lat * D2R),
    y: (p.lat - o.lat) * D2R * R,
  };
}

export function fromLocal(o: LatLng, p: Pt): LatLng {
  return {
    lat: o.lat + p.y / R / D2R,
    lng: o.lng + p.x / (R * Math.cos(o.lat * D2R)) / D2R,
  };
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function pathLength(p: Pt[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]);
  return L;
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Pt, line: Pt[]): number {
  if (line.length === 1) return dist(p, line[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = distToSeg(p, line[i - 1], line[i]);
    if (d < best) best = d;
  }
  return best;
}

/** Ramer–Douglas–Peucker simplification. */
export function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSeg(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Points evenly spaced every `step` along the polyline (always includes both ends). */
export function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = dist(a, b);
    let t = step - carry;
    while (t <= L) {
      out.push({ x: a.x + ((b.x - a.x) * t) / L, y: a.y + ((b.y - a.y) * t) / L });
      t += step;
    }
    carry = L - (t - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > 1e-9) out.push(last);
  return out;
}

export function bounds(pts: Pt[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, diag: Math.hypot(maxX - minX, maxY - minY) };
}

/**
 * Converts the drawing (canvas px, y down) into meters relative to its first point
 * (x east, y north), scaled by `mPerPx` and rotated clockwise by `rotDeg`.
 */
export function drawingToMeters(path: Pt[], mPerPx: number, rotDeg: number): Pt[] {
  const o = path[0];
  const t = rotDeg * D2R;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return path.map((p) => {
    const x = (p.x - o.x) * mPerPx;
    const y = -(p.y - o.y) * mPerPx;
    return { x: x * c + y * s, y: -x * s + y * c };
  });
}

/**
 * Smallest distance (km) at which the drawing's smallest feature still spans
 * ~1.5 city blocks, so it remains recognizable once snapped to streets.
 */
export function suggestDistances(pathPx: Pt[], blockM: number) {
  const b = bounds(pathPx);
  if (pathPx.length < 2 || b.diag === 0) return { minKm: 0, recKm: 0 };
  const simp = rdp(pathPx, b.diag * 0.03);
  const lens: number[] = [];
  for (let i = 1; i < simp.length; i++) lens.push(dist(simp[i - 1], simp[i]));
  lens.sort((a, z) => a - z);
  const p10 = lens[Math.floor(lens.length * 0.1)] ?? b.diag;
  const feature = Math.max(p10, b.diag * 0.05);
  const mPerPx = (1.5 * blockM) / feature;
  const km = (pathLength(simp) * mPerPx * 1.1) / 1000;
  const minKm = Math.max(1, Math.ceil(km * 2) / 2);
  const recKm = Math.ceil(minKm * 1.6 * 2) / 2;
  return { minKm, recKm };
}
