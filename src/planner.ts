import { type LatLng, type Pt, drawingToMeters, fromLocal, toLocal, pathLength } from "./geo";
import { type Graph, estimateBlockSize } from "./graph";
import { routeDrawing, type RouteResult } from "./router";

export interface PlanInput {
  pathPx: Pt[];
  start: LatLng;
  targetKm: number;
  rotDeg: number;
  autoRotate: boolean;
}

export interface Plan extends RouteResult {
  rotDeg: number;
  mPerPx: number;
  target: LatLng[];
  blockM: number;
}

/** Drawing placed on the map: first point at `start`, given scale and rotation. */
export function placeDrawing(pathPx: Pt[], start: LatLng, mPerPx: number, rotDeg: number): LatLng[] {
  return drawingToMeters(pathPx, mPerPx, rotDeg).map((p) => fromLocal(start, p));
}

/** Initial scale guess: streets add ~12% over the ideal drawing length. */
export function initialScale(pathPx: Pt[], targetKm: number) {
  return (targetKm * 1000) / pathLength(pathPx) / 1.12;
}

/** Radius (m) around start that any rotation of the drawing at this scale fits in. */
export function requiredRadius(pathPx: Pt[], mPerPx: number) {
  const m = drawingToMeters(pathPx, mPerPx, 0);
  return Math.max(...m.map((p) => Math.hypot(p.x, p.y)));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

export async function plan(
  input: PlanInput,
  getGraph: (center: LatLng, radiusM: number) => Promise<Graph>,
  onStatus: (s: string) => void,
): Promise<Plan> {
  const { pathPx, start, targetKm } = input;
  const targetM = targetKm * 1000;
  const s0 = initialScale(pathPx, targetKm);
  // allow the scale to grow up to 40% while converging on the target distance
  const g = await getGraph(start, requiredRadius(pathPx, s0 * 1.4) + 400);
  const startLocal = toLocal(g.origin, start);
  const blockM = estimateBlockSize(g, startLocal, 700);

  const rotations = input.autoRotate
    ? [0, -15, 15, -30, 30, -45, 45].map((d) => input.rotDeg + d)
    : [input.rotDeg];

  let best: Plan | null = null;
  const rank = (p: Plan) => p.fidelity - 150 * Math.abs(p.lengthM / targetM - 1);

  for (let ri = 0; ri < rotations.length; ri++) {
    const rot = rotations[ri];
    let s = s0;
    for (let iter = 0; iter < 4; iter++) {
      onStatus(`Traçando percurso… rotação ${rot}° (${ri + 1}/${rotations.length})`);
      await tick();
      const meters = drawingToMeters(pathPx, s, rot);
      const target = meters.map((p) => ({ x: p.x + startLocal.x, y: p.y + startLocal.y }));
      const r = routeDrawing(g, target, blockM);
      if (!r || r.lengthM === 0) break;
      const candidate: Plan = {
        ...r,
        rotDeg: rot,
        mPerPx: s,
        target: target.map((p) => fromLocal(g.origin, p)),
        blockM,
      };
      if (!best || rank(candidate) > rank(best)) best = candidate;
      const ratio = targetM / r.lengthM;
      if (Math.abs(ratio - 1) < 0.03) break;
      s = Math.min(s * ratio, s0 * 1.4);
    }
  }
  if (!best) throw new Error("Não consegui traçar um percurso aqui. Tente outro ponto de partida.");
  return best;
}
