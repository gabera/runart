import { type Pt, rdp } from "./geo";

/** Freehand drawing canvas. Strokes are joined in order into a single runnable path. */
export class DrawPad {
  strokes: Pt[][] = [];
  closed = false;
  private ctx: CanvasRenderingContext2D;
  private drawing: Pt[] | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private onChange: () => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    };
    new ResizeObserver(resize).observe(canvas);

    const pos = (e: PointerEvent): Pt => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.drawing = [pos(e)];
      this.render();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.drawing) return;
      const p = pos(e);
      const l = this.drawing[this.drawing.length - 1];
      if (Math.hypot(p.x - l.x, p.y - l.y) >= 2) {
        this.drawing.push(p);
        this.render();
      }
    });
    const end = () => {
      if (!this.drawing) return;
      if (this.drawing.length > 1) this.strokes.push(rdp(this.drawing, 1));
      this.drawing = null;
      this.render();
      this.onChange();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  /** The full path the runner follows (canvas px), including connectors between strokes. */
  path(): Pt[] {
    const p = this.strokes.flat();
    if (this.closed && p.length > 2) p.push(p[0]);
    return p;
  }

  undo() {
    this.strokes.pop();
    this.render();
    this.onChange();
  }

  clear() {
    this.strokes = [];
    this.render();
    this.onChange();
  }

  /** Loads a shape given in unit coordinates (y up), fitted to the canvas. */
  setShape(pts: Pt[]) {
    const r = this.canvas.getBoundingClientRect();
    const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const pad = 28;
    const k = Math.min((r.width - 2 * pad) / (maxX - minX), (r.height - 2 * pad) / (maxY - minY));
    const ox = (r.width - (maxX - minX) * k) / 2;
    const oy = (r.height - (maxY - minY) * k) / 2;
    this.strokes = [pts.map((p) => ({ x: ox + (p.x - minX) * k, y: oy + (maxY - p.y) * k }))];
    this.render();
    this.onChange();
  }

  render() {
    const { ctx, canvas } = this;
    const css = getComputedStyle(canvas);
    const ink = css.getPropertyValue("--ink").trim() || "#111";
    const muted = css.getPropertyValue("--muted").trim() || "#999";
    const accent = css.getPropertyValue("--accent").trim() || "#f60";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = ctx.lineJoin = "round";

    // connectors between strokes (you'll run these too)
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = muted;
    ctx.lineWidth = 2;
    for (let i = 1; i < this.strokes.length; i++) {
      const a = this.strokes[i - 1].at(-1)!,
        b = this.strokes[i][0];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const all = this.strokes.flat();
    if (this.closed && all.length > 2) {
      ctx.beginPath();
      ctx.moveTo(all.at(-1)!.x, all.at(-1)!.y);
      ctx.lineTo(all[0].x, all[0].y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    for (const s of [...this.strokes, ...(this.drawing ? [this.drawing] : [])]) {
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }

    const first = this.strokes[0]?.[0] ?? this.drawing?.[0];
    if (first) {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(first.x, first.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export const SHAPES: Record<string, () => Pt[]> = {
  heart: () => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * Math.PI * 2;
      pts.push({
        x: 16 * Math.sin(t) ** 3,
        y: 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      });
    }
    return pts;
  },
  star: () => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? 0.42 : 1;
      pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return pts;
  },
  house: () =>
    // classic one-stroke "envelope house"
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 0.5, y: 1.6 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ],
};
