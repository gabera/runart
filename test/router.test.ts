import { describe, expect, it } from "vitest";
import { fromLocal, suggestDistances, type LatLng, type Pt } from "../src/geo";
import { buildGraph, estimateBlockSize, type RawNode } from "../src/graph";
import { plan } from "../src/planner";
import { routeDrawing } from "../src/router";
import { SHAPES } from "../src/drawpad";

const origin: LatLng = { lat: -23.56, lng: -46.65 };

/** Regular street grid of `n`×`n` intersections spaced `block` meters, centered on origin. */
function grid(n: number, block: number) {
  const nodes: RawNode[] = [];
  const id = (i: number, j: number) => i * n + j + 1;
  const half = ((n - 1) * block) / 2;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const ll = fromLocal(origin, { x: j * block - half, y: i * block - half });
      nodes.push({ id: id(i, j), lat: ll.lat, lng: ll.lng });
    }
  const ways: number[][] = [];
  for (let i = 0; i < n; i++) {
    ways.push(Array.from({ length: n }, (_, j) => id(i, j)));
    ways.push(Array.from({ length: n }, (_, j) => id(j, i)));
  }
  return buildGraph(nodes, ways, origin, { s: -90, w: -180, n: 90, e: 180 });
}

const toCanvas = (pts: Pt[]) => pts.map((p) => ({ x: p.x * 100 + 200, y: -p.y * 100 + 200 }));

describe("router", () => {
  const g = grid(61, 100); // 6 km × 6 km, 100 m blocks

  it("estimates block size from intersection density", () => {
    expect(estimateBlockSize(g, { x: 0, y: 0 }, 700)).toBeGreaterThan(85);
    expect(estimateBlockSize(g, { x: 0, y: 0 }, 700)).toBeLessThan(115);
  });

  it("traces a grid-aligned square exactly", () => {
    const sq: Pt[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
      { x: 0, y: 0 },
    ];
    const r = routeDrawing(g, sq, 100)!;
    expect(r.lengthM).toBeCloseTo(4000, -1);
    expect(r.fidelity).toBeGreaterThan(95);
  });

  it("plans a heart close to the target distance with decent fidelity", async () => {
    const path = toCanvas(SHAPES.heart().map((p) => ({ x: p.x / 16, y: p.y / 16 })));
    const p = await plan(
      { pathPx: path, start: origin, targetKm: 8, rotDeg: 0, autoRotate: true },
      async () => g,
      () => {},
    );
    expect(Math.abs(p.lengthM / 8000 - 1)).toBeLessThan(0.08);
    expect(p.fidelity).toBeGreaterThan(70);
    // starts at the chosen start point
    expect(Math.hypot(p.local[0].x, p.local[0].y)).toBeLessThan(100);
  });

  it("suggests a larger minimum for detailed drawings", () => {
    const simple = toCanvas([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0, y: 0 },
    ]);
    const star = toCanvas(SHAPES.star());
    expect(suggestDistances(star, 100).minKm).toBeGreaterThan(suggestDistances(simple, 100).minKm);
  });
});
