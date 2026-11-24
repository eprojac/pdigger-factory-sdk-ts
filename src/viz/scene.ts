/**
 * `SceneView` (SDK-DESIGN.md section 11): a `THREE.Group` built from a render-ready `Scene3D` or from a world frame,
 * updated in place frame after frame. It needs no WebGL: it only builds the scene graph, so it is tested in Node.
 *
 * The scene world is z up; three.js is y up. The view's {@link SceneView.group} holds a `world` group rotated so that
 * scene `[x, y, z]` shows at three.js `[x, z, -y]` (the codec's `sceneToThree`), and everything inside it is built in
 * scene coordinates.
 *
 * @module
 */
import * as THREE from "three";
import { decodeSurfaceMesh, sceneToThree } from "../codec.js";
import type {
  Camera,
  DrawStone3D,
  Frame,
  Rect,
  ResolvedFocus,
  Ring,
  Scene3D,
  StoneTrack,
  StoneView,
  SurfaceMesh,
  Topology,
  WorldLayer,
} from "../models.js";
import { TOPOLOGY } from "../topology.js";
import { handColor, palette, skeletonColor, type Palette } from "./colors.js";

/** What {@link SceneView.update} accepts. */
export type SceneInput = Scene3D | Frame | WorldLayer;

/** Options of a {@link SceneView}. */
export interface SceneViewOptions {
  /** Bones and hand joints (default: the 20.20 topology). */
  topology?: Topology;
  /** Colour overrides (default: the topology's palette). */
  colors?: Partial<Palette>;
  /** Draw the observed surface mesh of a `Scene3D` (`surface=vertices`). Default true. */
  surface?: boolean;
  /** Draw the skeleton. Default true. */
  skeleton?: boolean;
  /** Draw the board. Default true. */
  board?: boolean;
}

/** A stone as the view draws it. */
interface StoneSpec {
  id: number | null;
  family: DrawStone3D["family"];
  pos: readonly number[];
  q: readonly number[];
  dims: readonly number[];
  side: string | null;
  alpha: number;
  uncertain: boolean;
}

/** Camera presets: `source` (the recording camera's pose), `three` (a three-quarter view), `top` (straight down). */
export type CameraPreset = "source" | "three" | "top";

const DOGBONE = dogboneShape();

/** The 12-vertex dogbone outline of a unit stone (L = W = 1), centred. */
function dogboneShape(): THREE.Shape {
  const a = 0.25;
  const b = 0.15;
  const n = 0.36;
  const pts: [number, number][] = [
    [-0.5, -0.5],
    [-a, -0.5],
    [-b, -n],
    [b, -n],
    [a, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [a, 0.5],
    [b, n],
    [-b, n],
    [-a, 0.5],
    [-0.5, 0.5],
  ];
  return new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
}

/** The solids in a frame, world layer or render-ready scene. */
export function stonesOf(input: SceneInput): StoneSpec[] {
  if ("schema" in input && input.schema === "r3d1") {
    return input.stones.map((s: DrawStone3D) => ({
      id: s.id ?? null,
      family: s.family,
      pos: s.pos,
      q: s.q,
      dims: s.dims,
      side: s.side ?? null,
      alpha: s.alpha,
      uncertain: s.uncertain ?? false,
    }));
  }
  const world = worldOf(input);
  return (world?.stones ?? [])
    .filter((s: StoneView) => s.solid !== undefined && s.solid !== null)
    .map((s: StoneView) => ({
      id: s.id,
      family: s.family,
      pos: s.solid.pos,
      q: s.solid.q,
      dims: s.solid.dims,
      side: s.side,
      alpha: 1,
      uncertain: s.uncertain,
    }));
}

function worldOf(input: SceneInput): WorldLayer | null {
  if ("schema" in input && input.schema === "stw1") return input;
  if ("cursor" in input) return input.world ?? null;
  return null;
}

/** Builds and updates a three.js scene graph of the line: board, stones, skeleton, wrist rings, surface, focus path. */
export class SceneView {
  /** The root: add it to your `THREE.Scene`. */
  readonly group = new THREE.Group();
  /** Everything in scene coordinates (z up), rotated into three.js axes. */
  readonly world = new THREE.Group();
  /** The board plane and its outline. */
  readonly board = new THREE.Group();
  /** One mesh per stone. */
  readonly stones = new THREE.Group();
  /** The skeleton bones (line segments). */
  readonly skeleton: THREE.LineSegments;
  /** One torus per wrist ring. */
  readonly rings = new THREE.Group();
  /** The observed surface mesh. */
  readonly surface: THREE.Mesh;
  /** The focused stone's path. */
  readonly focusPath: THREE.Line;
  /** The colours in use. */
  readonly colors: Palette;
  /** The frame (`g`) of the newest update, or null. */
  g: number | null = null;
  private readonly topology: Topology;
  private readonly options: Required<Pick<SceneViewOptions, "surface" | "skeleton" | "board">>;
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly boxEdges = new THREE.EdgesGeometry(this.boxGeometry);
  private readonly dogboneGeometry: THREE.ExtrudeGeometry;
  private readonly dogboneEdges: THREE.EdgesGeometry;
  private readonly ringGeometry = new THREE.TorusGeometry(0.05, 0.008, 8, 32);
  private readonly materials = new Map<string, THREE.Material>();

  constructor(options: SceneViewOptions = {}) {
    this.topology = options.topology ?? TOPOLOGY;
    this.colors = palette(this.topology, options.colors);
    this.options = {
      surface: options.surface ?? true,
      skeleton: options.skeleton ?? true,
      board: options.board ?? true,
    };
    const dogbone = new THREE.ExtrudeGeometry(DOGBONE, { depth: 1, bevelEnabled: false });
    dogbone.translate(0, 0, -0.5);
    this.dogboneGeometry = dogbone;
    this.dogboneEdges = new THREE.EdgesGeometry(dogbone);
    this.world.name = "world";
    this.world.rotation.x = -Math.PI / 2;
    this.group.name = "pdigger-scene";
    this.board.name = "board";
    this.stones.name = "stones";
    this.rings.name = "rings";
    this.skeleton = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }),
    );
    this.skeleton.name = "skeleton";
    this.skeleton.frustumCulled = false;
    this.surface = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({
        color: this.colors.surface,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        roughness: 1,
        depthWrite: false,
      }),
    );
    this.surface.name = "surface";
    this.surface.visible = false;
    this.focusPath = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: this.colors.focus, linewidth: 2 }),
    );
    this.focusPath.name = "focus-path";
    this.focusPath.visible = false;
    this.focusPath.frustumCulled = false;
    this.buildBoard();
    this.world.add(this.board, this.stones, this.skeleton, this.rings, this.surface, this.focusPath);
    this.group.add(this.world);
  }

  /** The mesh of a stone by id, or undefined. */
  stone(id: number): THREE.Mesh | undefined {
    return this.meshes.get(String(id));
  }

  /** Stones drawn now. */
  get stoneCount(): number {
    return this.stones.children.length;
  }

  /**
   * Updates the view from a render-ready `Scene3D` (`renderScene3d`), a frame with a world layer (and a scene layer for
   * the skeleton), or a world layer. Inputs without a world leave the view as it was.
   */
  update(input: SceneInput): void {
    const isScene = "schema" in input && input.schema === "r3d1";
    const world = worldOf(input);
    if (!isScene && world === null) return;
    this.g = isScene ? input.g : (world as WorldLayer).g;
    this.updateStones(stonesOf(input));
    const board = isScene ? input.board : (world?.draw?.board ?? null);
    this.setBoard(board ?? null);
    if (isScene) {
      this.setSkeleton(input.skeleton.joints ?? [], input.skeleton.bones);
      this.setRings(input.skeleton.rings ?? []);
      this.setSurface(input.surface ?? null);
    } else {
      const scene = "cursor" in input ? input.scene : undefined;
      this.setSkeleton(scene?.skeleton.world ?? [], undefined);
      this.setRings(scene?.rings ?? []);
      this.setSurface(null);
      if (world?.focus !== undefined) this.setFocusPath(world.focus);
    }
  }

  /** Shows a focus path: a `StoneTrack` or `ResolvedFocus` (its `path3d`), points in scene coordinates, or null to hide. */
  setFocusPath(path: StoneTrack | ResolvedFocus | readonly (readonly number[])[] | null): void {
    const points: readonly (readonly number[])[] = path === null ? [] : "path3d" in path ? path.path3d : path;
    const flat: number[] = [];
    for (const p of points) if (p.length >= 3) flat.push(p[0] as number, p[1] as number, p[2] as number);
    this.focusPath.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
    this.focusPath.geometry = geometry;
    this.focusPath.visible = flat.length >= 6;
  }

  /**
   * Points `camera` at the line: `source` from the recording camera (`VideoEntry.camera` or a `Camera`: K, R_c2w,
   * t_c2w), `three` a three-quarter view of the board, `top` straight down on it.
   */
  applyCamera(
    camera: THREE.PerspectiveCamera,
    preset: CameraPreset,
    source?: { camera?: Camera; native_wh?: readonly number[] } | Camera | null,
  ): void {
    const b = this.boardRect ?? { cx: 0, cy: 0, theta: 0, hw: 1, hh: 1 };
    const centre = new THREE.Vector3(...sceneToThree([b.cx, b.cy, 0]));
    const span = Math.max(b.hw, b.hh);
    camera.up.set(0, 1, 0);
    if (preset === "top") {
      camera.position.set(centre.x, centre.y + span * 3.2, centre.z);
      camera.up.set(0, 0, -1);
      camera.lookAt(centre);
    } else if (preset === "three") {
      camera.position.set(centre.x + span * 1.6, centre.y + span * 2.0, centre.z + span * 2.4);
      camera.lookAt(centre);
    } else {
      const cam = source && "camera" in source ? source.camera : (source as Camera | null | undefined);
      const wh = source && "native_wh" in source ? source.native_wh : undefined;
      if (!cam?.R_c2w || !cam.t_c2w) throw new TypeError("the source preset needs a camera with R_c2w and t_c2w");
      const R = cam.R_c2w;
      const r = (i: number, j: number): number => (R[i] as number[])[j] as number;
      // OpenCV camera (x right, y down, z forward) to three.js camera (x right, y up, looking down -z), in the scene.
      // prettier-ignore
      const m = new THREE.Matrix4().set(
        r(0, 0), -r(0, 1), -r(0, 2), 0,
        r(1, 0), -r(1, 1), -r(1, 2), 0,
        r(2, 0), -r(2, 1), -r(2, 2), 0,
        0, 0, 0, 1,
      );
      const toThree = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
      camera.quaternion.setFromRotationMatrix(toThree.multiply(m));
      camera.position.set(...sceneToThree(cam.t_c2w));
      const fy = cam.K?.[1]?.[1];
      const h = wh?.[1];
      const w = wh?.[0];
      if (fy !== undefined && h !== undefined && w !== undefined) {
        camera.fov = (2 * Math.atan(h / 2 / fy) * 180) / Math.PI;
        camera.aspect = w / h;
      }
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /** Frees every geometry and material and empties the group. */
  dispose(): void {
    for (const m of this.meshes.values()) this.stones.remove(m);
    this.meshes.clear();
    this.setRings([]);
    const geometries: THREE.BufferGeometry[] = [
      this.boxGeometry,
      this.boxEdges,
      this.dogboneGeometry,
      this.dogboneEdges,
      this.ringGeometry,
      this.skeleton.geometry,
      this.surface.geometry,
      this.focusPath.geometry,
    ];
    this.board.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineLoop) geometries.push(o.geometry as THREE.BufferGeometry);
    });
    for (const g of geometries) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const o of [this.skeleton, this.surface, this.focusPath]) (o.material as THREE.Material).dispose();
    this.board.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineLoop) (o.material as THREE.Material).dispose();
    });
    this.group.clear();
    this.world.clear();
  }

  // ---- parts ---------------------------------------------------------------------------------------------------------

  private boardRect: Rect | null = null;

  private buildBoard(): void {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: this.colors.board, roughness: 1, transparent: true, opacity: 0.85 }),
    );
    plane.name = "board-plane";
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.5, -0.5, 0),
        new THREE.Vector3(0.5, -0.5, 0),
        new THREE.Vector3(0.5, 0.5, 0),
        new THREE.Vector3(-0.5, 0.5, 0),
      ]),
      new THREE.LineBasicMaterial({ color: this.colors.tray }),
    );
    outline.name = "board-outline";
    this.board.add(plane, outline);
    this.board.visible = false;
  }

  private setBoard(rect: Rect | null): void {
    this.boardRect = rect;
    if (rect === null || !this.options.board) {
      this.board.visible = false;
      return;
    }
    this.board.visible = true;
    this.board.position.set(rect.cx, rect.cy, -0.001);
    this.board.rotation.set(0, 0, rect.theta);
    this.board.scale.set(2 * rect.hw, 2 * rect.hh, 1);
  }

  private material(color: string, opacity: number): THREE.Material {
    const key = `${color}|${opacity.toFixed(3)}`;
    let m = this.materials.get(key);
    if (m === undefined) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, transparent: opacity < 1, opacity });
      this.materials.set(key, m);
    }
    return m;
  }

  private edgeMaterial(): THREE.LineBasicMaterial {
    const key = "edges";
    let m = this.materials.get(key);
    if (m === undefined) {
      m = new THREE.LineBasicMaterial({ color: "#1b1f24", transparent: true, opacity: 0.6 });
      this.materials.set(key, m);
    }
    return m as THREE.LineBasicMaterial;
  }

  private updateStones(specs: readonly StoneSpec[]): void {
    const keep = new Set<string>();
    specs.forEach((s, i) => {
      const key = s.id === null ? `anon-${i}` : String(s.id);
      keep.add(key);
      const dogbone = s.family === "dogbone";
      let mesh = this.meshes.get(key);
      if (mesh !== undefined && (mesh.userData.family === "dogbone") !== dogbone) {
        this.stones.remove(mesh);
        mesh = undefined;
      }
      if (mesh === undefined) {
        mesh = new THREE.Mesh(dogbone ? this.dogboneGeometry : this.boxGeometry);
        const edges = new THREE.LineSegments(dogbone ? this.dogboneEdges : this.boxEdges, this.edgeMaterial());
        edges.name = "edges";
        mesh.add(edges);
        mesh.name = `stone-${key}`;
        this.meshes.set(key, mesh);
        this.stones.add(mesh);
      }
      const color = s.side !== null ? handColor(s.side, this.colors) : this.colors.stones;
      const opacity = Math.max(0.05, Math.min(1, s.alpha * (s.uncertain ? 0.45 : 1)));
      mesh.material = this.material(color, opacity);
      mesh.userData = { id: s.id, family: s.family, side: s.side, uncertain: s.uncertain };
      mesh.position.set(s.pos[0] ?? 0, s.pos[1] ?? 0, s.pos[2] ?? 0);
      mesh.quaternion.set(s.q[0] ?? 0, s.q[1] ?? 0, s.q[2] ?? 0, s.q[3] ?? 1);
      mesh.scale.set(s.dims[0] || 1e-3, s.dims[1] || 1e-3, s.dims[2] || 1e-3);
    });
    for (const [key, mesh] of [...this.meshes]) {
      if (keep.has(key)) continue;
      this.stones.remove(mesh);
      this.meshes.delete(key);
    }
  }

  /** The side of a joint: `left` or `right` for the hands' joints (from the topology's wrists and tips), else `body`. */
  private jointSide(j: number): "left" | "right" | "body" {
    for (const side of ["left", "right"] as const) {
      const wrist = this.topology.wrist[side];
      const tips = this.topology.tips[side] ?? [];
      if (wrist === undefined || tips.length === 0) continue;
      const lo = Math.min(wrist, ...tips);
      const hi = Math.max(wrist, ...tips);
      if (j >= lo && j <= hi) return side;
    }
    return "body";
  }

  private setSkeleton(
    joints: readonly (readonly number[] | null)[],
    bones: readonly Record<string, unknown>[] | undefined,
  ): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    if (this.options.skeleton) {
      const list: { a: number; b: number; side: string }[] =
        bones !== undefined && bones.length > 0
          ? bones.map((x) => ({ a: Number(x.a), b: Number(x.b), side: typeof x.side === "string" ? x.side : "body" }))
          : this.topology.bones.map(([a, b]) => ({ a, b, side: this.jointSide(Math.max(a, b)) }));
      for (const { a, b, side } of list) {
        const pa = joints[a];
        const pb = joints[b];
        if (!pa || !pb || pa.length < 3 || pb.length < 3) continue;
        positions.push(
          pa[0] as number,
          pa[1] as number,
          pa[2] as number,
          pb[0] as number,
          pb[1] as number,
          pb[2] as number,
        );
        color.set(skeletonColor(side, this.colors));
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }
    this.skeleton.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.skeleton.geometry = geometry;
    this.skeleton.visible = positions.length > 0;
  }

  private setRings(rings: readonly Ring[]): void {
    for (const child of [...this.rings.children]) this.rings.remove(child);
    for (const ring of this.options.skeleton ? rings : []) {
      const mesh = new THREE.Mesh(this.ringGeometry, this.material(handColor(ring.side, this.colors), 1));
      mesh.name = `ring-${ring.side}`;
      mesh.position.set(ring.pos[0], ring.pos[1], ring.pos[2]);
      this.rings.add(mesh);
    }
  }

  private setSurface(surface: SurfaceMesh | null): void {
    const mesh = this.options.surface ? decodeSurfaceMesh(surface) : null;
    if (mesh === null) {
      this.surface.visible = false;
      return;
    }
    this.surface.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeVertexNormals();
    this.surface.geometry = geometry;
    const opacity = typeof surface?.opacity === "number" ? surface.opacity : 0.5;
    (this.surface.material as THREE.MeshStandardMaterial).opacity = opacity;
    this.surface.visible = true;
  }
}
