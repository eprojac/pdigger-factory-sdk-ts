/**
 * `OverlayCanvas` (SDK-DESIGN.md section 11): draws a render-ready `Overlay2D` (`draw=primitives` or the shapes) or a
 * frame's world and overlay layers on a 2-D canvas context, scaled from native px to the canvas. It uses only the
 * context methods listed in {@link Context2DLike}, so a recording fake context tests it in Node.
 *
 * @module
 */
import { uvToPx } from "../codec.js";
import type {
  CirclePrimitive,
  DrawStone2D,
  Frame,
  ImagePrimitive,
  LabelPrimitive,
  Overlay2D,
  PolygonPrimitive,
  Primitives2D,
  SegmentPrimitive,
  StoneView,
  Topology,
} from "../models.js";
import { TOPOLOGY } from "../topology.js";
import { handColor, palette, skeletonColor, type Palette } from "./colors.js";

/** The part of `CanvasRenderingContext2D` the overlay uses (a real context, an `OffscreenCanvas` one, or a fake). */
export type Context2DLike = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "setTransform"
  | "transform"
  | "clearRect"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "arc"
  | "stroke"
  | "fill"
  | "fillRect"
  | "fillText"
  | "measureText"
  | "setLineDash"
  | "drawImage"
  | "strokeStyle"
  | "fillStyle"
  | "lineWidth"
  | "globalAlpha"
  | "font"
  | "textBaseline"
  | "lineJoin"
  | "lineCap"
> & { canvas?: { width: number; height: number } };

/** Options of an {@link OverlayCanvas}. */
export interface OverlayCanvasOptions {
  /** Canvas size in px when the context has no `canvas` (default 960 x 540). */
  width?: number;
  height?: number;
  /** Bones and hand joints for frames (default: the 20.20 topology). */
  topology?: Topology;
  colors?: Partial<Palette>;
  /** Native size of frames without an overlay layer (default 1920 x 1080). */
  nativeWh?: readonly [number, number];
  /** Resolves an image primitive's URL (map rasters) to something `drawImage` takes; images are skipped without it. */
  image?: (url: string) => CanvasImageSource | null | undefined;
  /** Draw labels (default true). */
  labels?: boolean;
}

/** What one `draw` drew. */
export interface DrawStats {
  stones: number;
  polygons: number;
  segments: number;
  circles: number;
  labels: number;
  images: number;
}

type P2 = readonly [number, number] | readonly number[];

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Draws overlays on a 2-D canvas. */
export class OverlayCanvas {
  /** The context drawn on. */
  readonly ctx: Context2DLike;
  /** The colours in use. */
  readonly colors: Palette;
  private readonly options: OverlayCanvasOptions;
  private readonly topology: Topology;
  private stats: DrawStats = OverlayCanvas.zero();

  /** Draws on a canvas (its 2-D context) or on a context. */
  constructor(target: Context2DLike | { getContext(kind: "2d"): unknown }, options: OverlayCanvasOptions = {}) {
    const ctx = "getContext" in target ? (target.getContext("2d") as Context2DLike | null) : target;
    if (!ctx) throw new TypeError("the canvas has no 2-D context");
    this.ctx = ctx;
    this.options = options;
    this.topology = options.topology ?? TOPOLOGY;
    this.colors = palette(this.topology, options.colors);
  }

  private static zero(): DrawStats {
    return { stones: 0, polygons: 0, segments: 0, circles: 0, labels: 0, images: 0 };
  }

  /** The canvas size in px. */
  get size(): { width: number; height: number } {
    return {
      width: this.ctx.canvas?.width ?? this.options.width ?? 960,
      height: this.ctx.canvas?.height ?? this.options.height ?? 540,
    };
  }

  /** Clears the canvas. */
  clear(): void {
    const { width, height } = this.size;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.restore();
  }

  /**
   * Draws an `Overlay2D` (its `primitives` when present, else its shapes) or a frame (world stone outlines, the overlay
   * layer's skeleton and wrists, the focus path), scaled from native px to the canvas. Clears first unless
   * `clear: false`.
   */
  draw(input: Overlay2D | Frame, options: { clear?: boolean } = {}): DrawStats {
    this.stats = OverlayCanvas.zero();
    if (options.clear ?? true) this.clear();
    const isOverlay = "schema" in input && input.schema === "r2d1";
    const [W, H] = isOverlay
      ? [input.native_wh[0] ?? 1920, input.native_wh[1] ?? 1080]
      : ((input as Frame).overlay?.native_wh ?? this.options.nativeWh ?? [1920, 1080]);
    const { width, height } = this.size;
    const lw = clamp(W / 420, 1.2, 3);
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (isOverlay && input.primitives) this.primitives(input.primitives, input.primitives.lw ?? lw);
    else if (isOverlay) this.shapes(input, lw);
    else this.frame(input as Frame, W, H, lw);
    ctx.restore();
    return { ...this.stats };
  }

  // ---- primitives ----------------------------------------------------------------------------------------------------

  private primitives(p: Primitives2D, lw: number): void {
    for (const im of p.images ?? []) this.image(im);
    for (const poly of p.polygons ?? []) this.polygon(poly);
    for (const s of p.segments ?? []) this.segment(s);
    for (const c of p.circles ?? []) this.circle(c);
    if (this.options.labels ?? true) for (const l of p.labels ?? []) this.label(l, lw);
  }

  private image(im: ImagePrimitive): void {
    const source = this.options.image?.(im.url);
    if (!source) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = im.alpha ?? 1;
    if (im.transform) {
      ctx.transform(...im.transform);
      ctx.drawImage(source, 0, 0);
    } else ctx.drawImage(source, im.x, im.y, im.w, im.h);
    ctx.restore();
    this.stats.images++;
  }

  private path(points: readonly P2[], close: boolean): void {
    const ctx = this.ctx;
    ctx.beginPath();
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    if (close) ctx.closePath();
  }

  private polygon(poly: PolygonPrimitive): void {
    if (poly.points.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    const alpha = poly.alpha ?? 1;
    this.path(poly.points, true);
    if (poly.fill) {
      ctx.globalAlpha = alpha * (poly.fill_alpha ?? 1);
      ctx.fillStyle = poly.fill;
      ctx.fill();
    }
    if (poly.stroke) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = poly.stroke;
      ctx.lineWidth = poly.width ?? 1;
      ctx.setLineDash(poly.dash ?? []);
      ctx.stroke();
    }
    ctx.restore();
    this.stats.polygons++;
  }

  private segment(s: SegmentPrimitive): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.strokeStyle = s.color ?? this.colors.skelBody;
    ctx.lineWidth = s.width ?? 1;
    this.path([s.from, s.to], false);
    ctx.stroke();
    ctx.restore();
    this.stats.segments++;
  }

  private circle(c: CirclePrimitive): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.at[0], c.at[1], c.r, 0, 2 * Math.PI);
    if (c.fill) {
      ctx.globalAlpha = c.alpha ?? 1;
      ctx.fillStyle = c.fill;
      ctx.fill();
    }
    if (c.stroke) {
      ctx.globalAlpha = c.alpha ?? 1;
      ctx.strokeStyle = c.stroke;
      ctx.lineWidth = c.width ?? 1;
      ctx.stroke();
    }
    ctx.restore();
    this.stats.circles++;
  }

  private label(l: LabelPrimitive, lw: number): void {
    const ctx = this.ctx;
    const size = Math.round(6 * lw);
    ctx.save();
    ctx.font = `${size}px system-ui, sans-serif`;
    ctx.textBaseline = l.baseline === "middle" ? "middle" : "top";
    if (l.background) {
      const w = ctx.measureText(l.text).width;
      const top = l.baseline === "middle" ? l.at[1] - size / 2 : l.at[1];
      ctx.fillStyle = l.background;
      ctx.fillRect(l.at[0] - 2, top - 2, w + 4, size + 4);
    }
    ctx.fillStyle = l.color ?? "#ffffff";
    ctx.fillText(l.text, l.at[0], l.at[1]);
    ctx.restore();
    this.stats.labels++;
  }

  // ---- shapes --------------------------------------------------------------------------------------------------------

  private stoneStyle(
    style: string,
    side: string | null | undefined,
  ): { stroke: string; fill: string | null; dash: number[] } {
    const c = this.colors;
    if (style === "held" || (side !== null && side !== undefined))
      return { stroke: handColor(side, c), fill: handColor(side, c), dash: [] };
    if (style === "kept") return { stroke: c.kept, fill: null, dash: [] };
    if (style === "raw") return { stroke: c.stoneBox, fill: null, dash: [4, 3] };
    if (style === "model") return { stroke: c.stones, fill: null, dash: [6, 3] };
    return { stroke: c.stones, fill: null, dash: [] };
  }

  private stone(
    outline: readonly P2[],
    style: string,
    side: string | null | undefined,
    alpha: number,
    lw: number,
  ): void {
    if (outline.length < 3) return;
    const s = this.stoneStyle(style, side);
    this.polygon({
      points: outline as [number, number][],
      stroke: s.stroke,
      fill: s.fill,
      fill_alpha: 0.22,
      width: 1.2 * lw,
      dash: s.dash,
      alpha,
    });
    this.stats.polygons--;
    this.stats.stones++;
  }

  private shapes(o: Overlay2D, lw: number): void {
    const c = this.colors;
    for (const box of o.boxes ?? []) {
      const b = box as { kind?: string; x0?: number; y0?: number; x1?: number; y1?: number; label?: string };
      if (b.x0 === undefined || b.y0 === undefined || b.x1 === undefined || b.y1 === undefined) continue;
      const color = b.kind === "person" ? c.personBox : c.stoneBox;
      this.polygon({
        points: [
          [b.x0, b.y0],
          [b.x1, b.y0],
          [b.x1, b.y1],
          [b.x0, b.y1],
        ],
        stroke: color,
        width: lw,
        dash: [6, 4],
        alpha: 0.95,
      });
      if (b.label && (this.options.labels ?? true)) {
        this.label({ at: [b.x0 + 5, b.y0 + 3], text: b.label, color, background: "rgba(0,0,0,.6)" }, lw);
      }
    }
    for (const s of o.stones ?? []) this.drawStone2D(s, lw);
    for (const bone of o.skeleton?.bones ?? []) {
      const b = bone as { from?: P2; to?: P2; side?: string; alpha?: number };
      if (!b.from || !b.to) continue;
      this.segment({
        from: b.from as [number, number],
        to: b.to as [number, number],
        color: skeletonColor(b.side, c),
        width: 1.15 * lw,
        alpha: b.alpha ?? 1,
      });
    }
    for (const joint of o.skeleton?.joints ?? []) {
      const j = joint as { at?: P2; side?: string; alpha?: number };
      if (!j.at) continue;
      this.circle({ at: j.at as [number, number], r: 1.3 * lw, fill: skeletonColor(j.side, c), alpha: j.alpha ?? 1 });
    }
    for (const wrist of o.wrists ?? []) {
      const w = wrist as { at?: P2; side?: string; filled?: boolean; ring?: boolean; visible?: boolean };
      if (!w.at || w.visible === false) continue;
      this.wrist(w.at, w.side, w.filled ?? false, w.ring ?? true, lw);
    }
    const focus = o.focus as { outline?: P2[] } | null | undefined;
    if (focus?.outline && focus.outline.length >= 3) {
      this.polygon({ points: focus.outline as [number, number][], stroke: c.focus, width: 2 * lw, alpha: 1 });
    }
  }

  private drawStone2D(s: DrawStone2D, lw: number): void {
    this.stone(s.outline, s.style, s.side, s.alpha, lw);
  }

  private wrist(at: P2, side: string | undefined, filled: boolean, ring: boolean, lw: number): void {
    const color = handColor(side, this.colors);
    if (filled) this.circle({ at: at as [number, number], r: 3 * lw, fill: color, alpha: 0.85 });
    if (ring) this.circle({ at: at as [number, number], r: 5 * lw, stroke: color, width: lw, alpha: 1 });
  }

  // ---- frames --------------------------------------------------------------------------------------------------------

  private frame(f: Frame, W: number, H: number, lw: number): void {
    for (const s of f.world?.stones ?? []) this.worldStone(s, lw);
    const joints = f.overlay?.joints ?? [];
    const px = (j: readonly number[] | null | undefined): [number, number] | null =>
      j && j.length >= 2 ? uvToPx(j[0] as number, j[1] as number, W, H) : null;
    for (const [a, b] of this.topology.bones) {
      const pa = px(joints[a]);
      const pb = px(joints[b]);
      if (!pa || !pb) continue;
      this.segment({
        from: pa,
        to: pb,
        color: skeletonColor(this.jointSide(Math.max(a, b)), this.colors),
        width: 1.15 * lw,
        alpha: 0.95,
      });
    }
    for (const side of ["left", "right"] as const) {
      const w = f.overlay?.wrists[side];
      if (!w?.uv || !w.visible) continue;
      this.wrist(uvToPx(w.uv[0], w.uv[1], W, H), side, w.filled, w.ring, lw);
    }
    const path = f.world?.focus?.path2d ?? [];
    if (path.length >= 2) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = this.colors.focus;
      ctx.lineWidth = 1.5 * lw;
      this.path(path, false);
      ctx.stroke();
      ctx.restore();
      this.stats.segments++;
    }
  }

  private worldStone(s: StoneView, lw: number): void {
    const style = s.side ? "held" : s.mode === "placed" ? "placed" : s.detected ? "detected" : "kept";
    this.stone(s.outline, style, s.side, s.uncertain ? 0.55 : 1, lw);
  }

  private jointSide(j: number): "left" | "right" | "body" {
    for (const side of ["left", "right"] as const) {
      const wrist = this.topology.wrist[side];
      const tips = this.topology.tips[side] ?? [];
      if (wrist === undefined || tips.length === 0) continue;
      if (j >= Math.min(wrist, ...tips) && j <= Math.max(wrist, ...tips)) return side;
    }
    return "body";
  }
}
