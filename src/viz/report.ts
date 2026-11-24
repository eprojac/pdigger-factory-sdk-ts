/**
 * `TrayReportView` (SDK-DESIGN.md sections 4.7 and 11): a tray's report as a picture. Two {@link SceneView}s side by
 * side, the tray as it arrived on the left and as it left on the right, every stone coloured by what the report says of
 * it ({@link reportMarks}, {@link REPORT_COLORS}), and on the right a dashed red outline where each removed stone was
 * taken from. Like SceneView it only builds the scene graph: it needs no WebGL, and it is tested in Node.
 *
 * @module
 */
import * as THREE from "three";
import type { Tray, TrayChange, TrayReport, TrayStone } from "../interpreter/trays.js";
import type { DrawStone3D, Rect, Scene3D } from "../models.js";
import { SceneView, stonesOf, type CameraPreset, type SceneInput, type SceneViewOptions } from "./scene.js";

/** What a tray's report says of a stone: removed, added or moved; else whether the SDK is sure of it. */
export type ReportRole = "removed" | "added" | "moved" | "sure" | "unsure";

/** The two sides of a report view: the tray as it arrived (`before`) and as it left (`after`). */
export type ReportSide = "before" | "after";

/** A stone of one side of a report view. */
export interface ReportMark {
  /** The tray stone's id. */
  stone: string;
  /** What the report says of it. */
  role: ReportRole;
  /** False only for a removal or an addition that is unclear (a move is always certain). */
  certain: boolean;
  /**
   * For removed, added and moved: the tray stone's id after the tray's number, the world id it was first seen under
   * (with `-2`, `-3`, ... for a second or third stone of the tray first seen under it in the same tenth of a second);
   * else "".
   */
  label: string;
}

/** The marks of a report's two sides, by world id. */
export interface ReportMarks {
  /** Every stone the tray arrived with, by the world id it was first seen under (in its id, after the tray's number). */
  before: Map<number, ReportMark>;
  /** Every stone on the tray as it left, by the world id it stands for then (its `worldId`). */
  after: Map<number, ReportMark>;
}

/**
 * The colours of the roles, the same as the Rust viewer's: red removed, blue added, violet moved, green sure, amber
 * not sure.
 */
export const REPORT_COLORS: Readonly<Record<ReportRole, string>> = Object.freeze({
  removed: "#D8432E",
  added: "#1E96C8",
  moved: "#6E48B9",
  sure: "#0E8A72",
  unsure: "#DE7C34",
});

/** A world stone without a mark (not on the tray at that point) is drawn dimmed grey. */
const DIM_COLOR = "#7d8790";
const DIM_OPACITY = 0.3;
/** An unclear removal or addition is drawn translucent. */
const UNCLEAR_OPACITY = 0.45;
/** The default gap between the two sides, in scene units. */
const GAP = 0.3;
/** How much room `applyCamera` leaves around the two sides. */
const FIT = 1.04;
/** The height of the removed stones' outlines over the board (they are drawn over everything). */
const PLACE_Z = 0.002;
/** The outlines' dashes, gaps and width, in scene units (as thin quads: WebGL draws lines one pixel wide). */
const DASH = 0.04;
const DASH_GAP = 0.03;
const DASH_WIDTH = 0.009;

/**
 * A dashed outline of the rectangle `[x0, x1] x [y0, y1]` at height `z`: thin quads along its edges, inside them, each
 * edge starting with a dash at its corner.
 */
function dashedOutline(x0: number, y0: number, x1: number, y1: number, z: number): THREE.BufferGeometry {
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const positions: number[] = [];
  corners.forEach(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % 4] as [number, number];
    const length = Math.hypot(bx - ax, by - ay);
    const [ux, uy] = [(bx - ax) / length, (by - ay) / length];
    const [nx, ny] = [-uy * DASH_WIDTH, ux * DASH_WIDTH]; // inwards: the corners go anticlockwise
    const n = Math.max(1, Math.round(length / (DASH + DASH_GAP)));
    const period = length / n;
    for (let k = 0; k < n; k++) {
      const [s, e] = [k * period, k * period + (period * DASH) / (DASH + DASH_GAP)];
      const [px, py, qx, qy] = [ax + ux * s, ay + uy * s, ax + ux * e, ay + uy * e];
      positions.push(px, py, z, qx, qy, z, qx + nx, qy + ny, z, px, py, z, qx + nx, qy + ny, z, px + nx, py + ny, z);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

/**
 * A tray stone's id after its tray's number (section 4.6): the world id it was first seen under, then `-2`, `-3`, ...
 * when another stone of the tray was first seen under that world id in the same tenth of a second.
 */
function idTail(id: string, tray: number): string {
  const head = `-${tray}-`;
  return id.slice(id.indexOf(head) + head.length);
}

/** The world id a tray stone was first seen under, from its id. */
function firstWorldId(id: string, tray: number): number {
  return Number.parseInt(idTail(id, tray), 10);
}

function marksOf(tray: Tray, report: TrayReport): ReportMarks {
  const byStone = (changes: readonly TrayChange[]): Map<string, TrayChange> =>
    new Map(changes.map((c) => [c.stone, c]));
  const removed = byStone(report.removed);
  const added = byStone(report.added);
  const moved = byStone(report.moved);
  const mark = (s: TrayStone, change: TrayChange | undefined): ReportMark =>
    change === undefined
      ? { stone: s.id, role: s.sure ? "sure" : "unsure", certain: true, label: "" }
      : { stone: s.id, role: change.kind, certain: change.certain, label: idTail(s.id, tray.n) };
  const before = new Map<number, ReportMark>();
  const after = new Map<number, ReportMark>();
  for (const s of tray.stones) {
    if (!s.added) before.set(firstWorldId(s.id, tray.n), mark(s, removed.get(s.id) ?? moved.get(s.id)));
    if (s.status === "on" && s.worldId !== null) after.set(s.worldId, mark(s, added.get(s.id) ?? moved.get(s.id)));
  }
  return { before, after };
}

/**
 * The marks of a tray's report (section 4.7) for the two sides of a {@link TrayReportView}, by world id; null for a tray
 * without a report (it has not left, or it never arrived).
 *
 * - `before`: every stone the tray arrived with, by the world id it was first seen under (in its id, after the tray's
 *   number):
 *   `removed` for a stone the report removes (certain as its change), `moved` for one it reports moved, else `sure` or
 *   `unsure` by the stone's `sure`;
 * - `after`: every stone on the tray as it left (`status` on), by the world id it stands for then: `added` for a stone
 *   the report adds (certain as its change), `moved`, else `sure` or `unsure`.
 *
 * The label of a removed, added or moved stone is its id after the tray's number: the world id it was first seen under,
 * with `-2`, `-3`, ... for a second or third stone first seen under it in the same tenth of a second. Sure and unsure
 * stones have none.
 */
export function reportMarks(tray: Tray): ReportMarks | null {
  const report = tray.report();
  return report === null ? null : marksOf(tray, report);
}

/** Options of a {@link TrayReportView}. */
export interface TrayReportViewOptions {
  /**
   * Options of its two SceneViews (`topology`, `colors`, `board`, `surface`). The skeleton is always left out, and the
   * observed surface of a `Scene3D` unless `surface` is true.
   */
  scene?: Omit<SceneViewOptions, "skeleton">;
  /** The gap between the two sides, in scene units (default 0.3). */
  gap?: number;
}

/** A labelled stone of a {@link TrayReportView}, for a page to put an HTML label on. */
export interface ReportLabel {
  /** The label: the tray stone's id after the tray's number, the world id it was first seen under (section 4.6). */
  text: string;
  /** Its role's colour ({@link REPORT_COLORS}). */
  color: string;
  /** The stone's top centre, in the coordinates of {@link TrayReportView.group}. */
  position: THREE.Vector3;
  /** The side it is on. */
  side: ReportSide;
  /** The stone's mark. */
  mark: ReportMark;
}

/** The board of an input as {@link SceneView.update} reads it, or null. */
function boardOf(input: SceneInput): Rect | null {
  if ("cursor" in input) return input.world?.draw?.board ?? null; // a frame
  if (input.schema === "r3d1") return input.board; // a render-ready scene
  return input.draw?.board ?? null; // a world layer
}

/** Draw the leaving account. The two observations supply the appearance of a stone when it was visible. */
function leavingScene(tray: Tray, report: TrayReport, before: SceneInput, after: SceneInput): Scene3D {
  const arrival = new Map(stonesOf(before).map((s) => [s.id, s]));
  const leaving = new Map(stonesOf(after).map((s) => [s.id, s]));
  const stones: DrawStone3D[] = [];
  for (const s of tray.stones) {
    if (s.status !== "on" || s.worldId === null) continue;
    const solid = leaving.get(s.worldId) ?? (s.added ? undefined : arrival.get(firstWorldId(s.id, tray.n)));
    const [x, y] = s.leftPlace ?? s.place;
    const long = Math.max(0.001, s.size[0]);
    const short = Math.max(0.001, s.size[1]);
    const h = solid?.dims[2] ?? short * 0.3;
    const longAlongY = solid !== undefined && solid.dims[1]! > solid.dims[0]!;
    stones.push({
      id: s.worldId,
      family: solid?.family ?? "box",
      pos: [x, y, solid?.pos[2] ?? h / 2],
      q: solid ? [...solid.q] : [0, 0, 0, 1],
      dims: longAlongY ? [short, long, h] : [long, short, h],
      alpha: 1,
    });
  }
  if ("schema" in after && after.schema === "r3d1") return { ...after, stones };
  return {
    schema: "r3d1",
    session: after.session,
    video: after.video,
    g: report.left.g,
    t: report.left.t,
    f: 0,
    mode: "stable",
    plane: {},
    board: boardOf(after),
    skeleton: {},
    stones,
  };
}

/** Whether a world stone's long side lies nearer the scene's y axis than its x axis (false without the stone). */
function longSideAlongY(mesh: THREE.Mesh | undefined): boolean {
  if (mesh === undefined) return false;
  const axis = mesh.scale.x >= mesh.scale.y ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  axis.applyQuaternion(mesh.quaternion);
  return Math.abs(axis.y) > Math.abs(axis.x);
}

/** The extent of a side in scene coordinates: its board and its stones (a unit square when it has neither). */
function sceneExtent(view: SceneView, board: Rect | null): THREE.Box3 {
  const box = new THREE.Box3();
  if (board !== null) {
    const c = Math.abs(Math.cos(board.theta));
    const s = Math.abs(Math.sin(board.theta));
    const ex = c * board.hw + s * board.hh;
    const ey = s * board.hw + c * board.hh;
    box.expandByPoint(new THREE.Vector3(board.cx - ex, board.cy - ey, 0));
    box.expandByPoint(new THREE.Vector3(board.cx + ex, board.cy + ey, 0));
  }
  for (const child of view.stones.children) {
    const mesh = child as THREE.Mesh;
    mesh.updateMatrix();
    if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
    box.union((mesh.geometry.boundingBox as THREE.Box3).clone().applyMatrix4(mesh.matrix));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0));
  return box;
}

/** A box in scene coordinates (z up) as a box in the report group's (y up), for a side placed at `offset`. */
function inGroup(box: THREE.Box3, offset: THREE.Vector3): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(box.min.x + offset.x, box.min.z + offset.y, -box.max.y + offset.z),
    new THREE.Vector3(box.max.x + offset.x, box.max.z + offset.y, -box.min.y + offset.z),
  );
}

/**
 * A tray's report as a three.js picture: the tray as it arrived ({@link before}, on the left) and as it left
 * ({@link after}, on the right), side by side along x with a gap between, each a {@link SceneView} without the
 * skeleton. {@link show} colours every stone by its {@link reportMarks} role ({@link REPORT_COLORS}; an unclear removal
 * or addition translucent; an unmarked stone in the arrival frame dimmed grey) and
 * draws, on the after side, a dashed red outline where each removed stone was taken from. {@link labels} gives where to
 * put the labels of the removed, added and moved stones, {@link applyCamera} frames both sides.
 */
export class TrayReportView {
  /** The root: add it to your `THREE.Scene`, at its origin for {@link applyCamera}. */
  readonly group = new THREE.Group();
  /** The tray as it arrived, on the left. */
  readonly before: SceneView;
  /** The tray as it left, on the right. */
  readonly after: SceneView;
  /**
   * The dashed outlines of the places the removed stones were taken from, inside the after side's `world` (scene
   * coordinates): one mesh of thin quads each, named `removed-{stone}`, with its `TrayChange` as `userData.change`.
   */
  readonly removedPlaces = new THREE.Group();
  /** The report of the tray shown, null before {@link show}. */
  report: TrayReport | null = null;
  /** The marks of the tray shown, null before {@link show}. */
  marks: ReportMarks | null = null;
  private readonly gap: number;
  private readonly materials = new Map<string, THREE.Material>();
  private readonly dashed = new THREE.MeshBasicMaterial({
    color: REPORT_COLORS.removed,
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  private extents: Record<ReportSide, THREE.Box3> = { before: new THREE.Box3(), after: new THREE.Box3() };

  constructor(options: TrayReportViewOptions = {}) {
    const scene: SceneViewOptions = { surface: false, ...options.scene, skeleton: false };
    this.before = new SceneView(scene);
    this.after = new SceneView(scene);
    this.gap = options.gap ?? GAP;
    this.group.name = "pdigger-tray-report";
    this.before.group.name = "before";
    this.after.group.name = "after";
    this.removedPlaces.name = "removed-places";
    this.after.world.add(this.removedPlaces);
    this.group.add(this.before.group, this.after.group);
    this.layout(null, null);
  }

  /**
   * Shows a tray that has left. `before` and `after` are what {@link SceneView.update} takes (a frame, its world, or a
   * `Scene3D`) at the tray's arrival point (`tray.arrived.g`) and at its leaving point (`tray.leaving.g`). Each side's
   * stones are coloured by their marks. The after side draws the final account at its recorded places. Each removed stone's final place (`TrayChange.place` and
   * `size`) is outlined, axis-aligned, its long side along x, or along y when its world stone lay that way as the tray
   * arrived. Throws a `TypeError` for a tray without a report.
   */
  show(tray: Tray, before: SceneInput, after: SceneInput): void {
    const report = tray.report();
    if (report === null) throw new TypeError(`tray ${tray.n} has no report: it has not left, or it never arrived`);
    this.report = report;
    this.marks = marksOf(tray, report);
    this.before.update(before);
    this.after.update(leavingScene(tray, report, before, after));
    this.paint(this.before, this.marks.before);
    this.paint(this.after, this.marks.after);
    this.drawRemovedPlaces(report.removed, report.tray);
    this.layout(boardOf(before), boardOf(after));
  }

  /**
   * A label for every stone drawn with a labelled mark (removed and moved on the before side, added and moved on the
   * after side): its text, its role's colour and the stone's top centre in the group's coordinates. Project a
   * position with the camera (`position.clone().project(camera)`) to place an HTML label over the canvas.
   */
  labels(): ReportLabel[] {
    const out: ReportLabel[] = [];
    if (this.marks === null) return out;
    this.group.updateWorldMatrix(true, true);
    for (const side of ["before", "after"] as const) {
      for (const [id, mark] of this.marks[side]) {
        const mesh = this[side].stone(id);
        if (mark.label === "" || mesh === undefined) continue;
        const position = this.group.worldToLocal(mesh.localToWorld(new THREE.Vector3(0, 0, 0.5)));
        out.push({ text: mark.label, color: REPORT_COLORS[mark.role], position, side, mark });
      }
    }
    return out;
  }

  /** The extent of one side, or of both, in the coordinates of {@link group}: its board and its stones. */
  bounds(side?: ReportSide): THREE.Box3 {
    if (side !== undefined) return this.extents[side].clone();
    return this.extents.before.clone().union(this.extents.after);
  }

  /**
   * Points `camera` at both sides so that they fill its view (for the group at the scene's origin): `top` straight down
   * on them (the default; x right and the scene's y up, as the camera sees the tray), `three` from the front, tilted.
   */
  applyCamera(camera: THREE.PerspectiveCamera, preset: Exclude<CameraPreset, "source"> = "top"): void {
    const box = this.bounds();
    const centre = box.getCenter(new THREE.Vector3());
    // the camera's axes: `back` from the centre to the camera, `right` and `up` on the screen
    const top = preset === "top";
    const back = top ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0.75, 0.8).normalize();
    const up = top ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, back).normalize();
    const screenUp = new THREE.Vector3().crossVectors(back, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * camera.aspect;
    // the nearest distance at which every corner of the two sides is inside the view, with room around them
    let distance = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).sub(centre);
      const across = Math.max(Math.abs(p.dot(right)) / tanH, Math.abs(p.dot(screenUp)) / tanV);
      distance = Math.max(distance, p.dot(back) + FIT * across);
    }
    camera.position.copy(centre).addScaledVector(back, distance);
    camera.up.copy(up);
    camera.lookAt(centre);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /** Frees every geometry and material of both sides and of the outlines, and empties the group. */
  dispose(): void {
    this.clearRemovedPlaces();
    this.dashed.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.before.dispose();
    this.after.dispose();
    this.group.clear();
    this.report = null;
    this.marks = null;
  }

  // ---- parts ---------------------------------------------------------------------------------------------------------

  private material(color: string, opacity: number): THREE.Material {
    const key = `${color}|${opacity}`;
    let m = this.materials.get(key);
    if (m === undefined) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, transparent: opacity < 1, opacity });
      this.materials.set(key, m);
    }
    return m;
  }

  private paint(view: SceneView, marks: ReadonlyMap<number, ReportMark>): void {
    view.focusPath.visible = false; // not part of the report
    for (const child of view.stones.children) {
      const mesh = child as THREE.Mesh;
      const id = mesh.userData.id as number | null;
      const mark = id === null ? undefined : marks.get(id);
      mesh.material =
        mark === undefined
          ? this.material(DIM_COLOR, DIM_OPACITY)
          : this.material(REPORT_COLORS[mark.role], mark.certain ? 1 : UNCLEAR_OPACITY);
      mesh.userData.mark = mark ?? null;
    }
  }

  private clearRemovedPlaces(): void {
    for (const child of this.removedPlaces.children) (child as THREE.Mesh).geometry.dispose();
    this.removedPlaces.clear();
  }

  private drawRemovedPlaces(changes: readonly TrayChange[], tray: number): void {
    this.clearRemovedPlaces();
    for (const c of changes) {
      const [long, short] = c.size.map((v) => Math.max(v, 0.001)) as [number, number];
      const upright = longSideAlongY(this.before.stone(firstWorldId(c.stone, tray)));
      const hx = (upright ? short : long) / 2;
      const hy = (upright ? long : short) / 2;
      const [x, y] = c.place;
      const outline = new THREE.Mesh(dashedOutline(x - hx, y - hy, x + hx, y + hy, PLACE_Z), this.dashed);
      outline.name = `removed-${c.stone}`;
      outline.renderOrder = 10;
      outline.userData = { change: c };
      this.removedPlaces.add(outline);
    }
  }

  private layout(before: Rect | null, after: Rect | null): void {
    const b = sceneExtent(this.before, before);
    const a = sceneExtent(this.after, after);
    // scene x is three.js x and scene y three.js -z: the sides go along x, the before side's right edge and the after
    // side's left edge half a gap from x = 0, each centred on z = 0
    this.before.group.position.set(-this.gap / 2 - b.max.x, 0, (b.min.y + b.max.y) / 2);
    this.after.group.position.set(this.gap / 2 - a.min.x, 0, (a.min.y + a.max.y) / 2);
    this.extents = { before: inGroup(b, this.before.group.position), after: inGroup(a, this.after.group.position) };
  }
}
