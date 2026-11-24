/**
 * Decoders of the low-level layers (SDK-DESIGN.md section 7): maps, bitsets, depth, surface buffers, joints, stone
 * tuples, and coordinate helpers. All synchronous and dependency free. Fields that public recordings redact are
 * absent there: the map decoders return null for an absent map.
 *
 * @module
 */
import { FactoryError } from "./errors.js";
import { base64ToBytes } from "./internal/bytes.js";
import { inflateZlib } from "./internal/inflate.js";
import type { JointTuple, Point2, Point3, StoneTuple, SurfaceMesh, Topology } from "./models.js";

function sized(bytes: Uint8Array, rows: number, cols: number, what: string): Uint8Array {
  if (bytes.length !== rows * cols) {
    throw new FactoryError({ code: "decode", message: `${what}: ${bytes.length} bytes, expected ${rows} x ${cols}` });
  }
  return bytes;
}

/** An overlay map: base64 of u8 row-major, `rows x cols`. Null for an absent (redacted) map. */
export function decodeU8Map(b64: string | null | undefined, rows: number, cols: number): Uint8Array | null {
  if (b64 == null) return null;
  return sized(base64ToBytes(b64), rows, cols, "u8 map");
}

/** A sip1 map: base64 of zlib of u8 row-major, `rows x cols`. Null for an absent (redacted) map. */
export function decodeZlibMap(b64: string | null | undefined, rows: number, cols: number): Uint8Array | null {
  if (b64 == null) return null;
  return sized(inflateZlib(base64ToBytes(b64)), rows, cols, "zlib map");
}

/** A bitset of `n` booleans, LSB-first within each byte. Null for an absent bitset. */
export function decodeBitset(b64: string | null | undefined, n: number): boolean[] | null {
  if (b64 == null) return null;
  const bytes = base64ToBytes(b64);
  if (bytes.length * 8 < n) {
    throw new FactoryError({ code: "decode", message: `bitset: ${bytes.length} bytes for ${n} bits` });
  }
  const out = new Array<boolean>(n);
  for (let i = 0; i < n; i++) out[i] = (((bytes[i >> 3] as number) >> (i & 7)) & 1) === 1;
  return out;
}

/** `logZ = a * (lo + q / 255 * (hi - lo)) + b` of one quantised depth value. */
export function depthLogZ(q: number, lo: number, hi: number, a: number, b: number): number {
  return a * (lo + (q / 255) * (hi - lo)) + b;
}

/** `Z = exp(logZ)` of one quantised depth value. */
export function depthZ(q: number, lo: number, hi: number, a: number, b: number): number {
  return Math.exp(depthLogZ(q, lo, hi, a, b));
}

/** Depth `Z` of every cell of a quantised map (`q` bytes, e.g. `decodeU8Map(scene.surface.q, rows, cols)`). */
export function decodeDepth(q: Uint8Array, lo: number, hi: number, a: number, b: number): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = depthZ(q[i] as number, lo, hi, a, b);
  return out;
}

function aligned(b64: string, size: number, what: string): DataView {
  const bytes = base64ToBytes(b64);
  if (bytes.length % size !== 0) {
    throw new FactoryError({ code: "decode", message: `${what}: ${bytes.length} bytes is not a multiple of ${size}` });
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** base64 of little-endian float32 (surface positions, xyz triplets). */
export function decodeF32le(b64: string): Float32Array {
  const view = aligned(b64, 4, "f32le");
  const out = new Float32Array(view.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** base64 of little-endian uint16 (triangle indices). */
export function decodeU16le(b64: string): Uint16Array {
  const view = aligned(b64, 2, "u16le");
  const out = new Uint16Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

/** The explicit surface mesh of a `Scene3D` (`surface=vertices`), or null for another form or an absent one. */
export function decodeSurfaceMesh(
  mesh: SurfaceMesh | null | undefined,
): { positions: Float32Array; indices: Uint16Array; rows: number; cols: number } | null {
  if (!mesh || mesh.form !== "vertices" || mesh.positions === undefined || mesh.indices === undefined) return null;
  return {
    positions: decodeF32le(mesh.positions),
    indices: decodeU16le(mesh.indices),
    rows: mesh.rows,
    cols: mesh.cols,
  };
}

/** A sip1 joint: content units `u, v`, visibility, camera-frame template metres `x, y, z`. */
export interface Joint {
  u: number;
  v: number;
  vis: number;
  x: number;
  y: number;
  z: number;
}

/** A joint from `[u, v, vis, x, y, z]`, or null. */
export function toJoint(t: JointTuple | readonly number[] | null | undefined): Joint | null {
  if (!t || t.length < 6) return null;
  return {
    u: t[0],
    v: t[1],
    vis: t[2],
    x: t[3],
    y: t[4],
    z: t[5],
  };
}

/** Every joint of a list (nulls stay null). */
export function toJoints(list: readonly (JointTuple | null)[] | null | undefined): (Joint | null)[] {
  return (list ?? []).map((t) => toJoint(t));
}

/** A sip1 stone detection. */
export interface StoneItem {
  u: number;
  v: number;
  w: number;
  h: number;
  score: number;
  X: number;
  Y: number;
  Z: number;
  wM: number;
  hM: number;
  yaw: number;
}

/** A stone item from `[u, v, w, h, score, X, Y, Z, w_m, h_m, yaw]`. */
export function toStoneItem(t: StoneTuple | readonly number[]): StoneItem {
  if (t.length < 11)
    throw new FactoryError({ code: "decode", message: `stone item of ${t.length} values, expected 11` });
  const n = (i: number): number => t[i] as number;
  return { u: n(0), v: n(1), w: n(2), h: n(3), score: n(4), X: n(5), Y: n(6), Z: n(7), wM: n(8), hM: n(9), yaw: n(10) };
}

/** Content units to native px (pixel centres at integers): `px = u * W - 0.5`. */
export function uvToPx(u: number, v: number, W: number, H: number): Point2 {
  return [u * W - 0.5, v * H - 0.5];
}

/** Native px to content units: `u = (px + 0.5) / W`. */
export function pxToUv(x: number, y: number, W: number, H: number): Point2 {
  return [(x + 0.5) / W, (y + 0.5) / H];
}

/** Scene world (z up) to three.js (y up): `[x, y, z] -> [x, z, -y]`. */
export function sceneToThree(p: readonly number[]): Point3 {
  return [p[0] as number, p[2] as number, -(p[1] as number)];
}

/** three.js to the scene world: `[x, y, z] -> [x, -z, y]`. */
export function threeToScene(p: readonly number[]): Point3 {
  return [p[0] as number, -(p[2] as number), p[1] as number];
}

/** The yaw (rotation about the scene's z axis, radians) of a quaternion `[x, y, z, w]`. */
export function quatToYaw(q: readonly number[]): number {
  const [x, y, z, w] = q as [number, number, number, number];
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

/** The skeleton's bones `[a, b]` from the topology. */
export function bonesOf(topology: Topology): [number, number][] {
  return topology.bones.map(([a, b]) => [a, b]);
}

/** The wrist joint of a side, or null. */
export function wristJoint(topology: Topology, side: "left" | "right"): number | null {
  return topology.wrist[side] ?? null;
}

/** The finger tip joints of a side. */
export function tipJoints(topology: Topology, side: "left" | "right"): number[] {
  return [...(topology.tips[side] ?? [])];
}
