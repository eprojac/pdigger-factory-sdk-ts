import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FactoryError, codec, type Frame, type Scene3D, type Topology } from "pdigger-factory-sdk";
import { readJson } from "../helpers/fixtures.js";

const frame = readJson<Frame>("frames/dry1-carry-full.json");
const scene = readJson<Scene3D>("api/renderScene3d.json");
const topology = readJson<Topology>("api/getTopology.json");
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

describe("codec on real 20.20 data (dry1, g 1512)", () => {
  it("decodes the overlay maps and the redacted ones as null", () => {
    const r = frame.overlay!.regions;
    const tray = codec.decodeU8Map(r.tray, r.rows, r.cols)!;
    expect(tray.length).toBe(40 * 64);
    expect(Math.max(...tray)).toBeGreaterThan(0);
    expect(codec.decodeU8Map(r.human, r.rows, r.cols)).toBeNull();
    expect(() => codec.decodeU8Map(r.tray, 10, 10)).toThrow(FactoryError);
  });

  it("decodes sip1 zlib maps", () => {
    const maps = frame.raw!.maps as unknown as Record<string, string | number[]>;
    const name = Object.keys(maps).find((k) => typeof maps[k] === "string" && k !== "human")!;
    const grid = maps.grid as number[];
    const m = codec.decodeZlibMap(maps[name] as string, grid[0]!, grid[1]!)!;
    expect(m.length).toBe(grid[0]! * grid[1]!);
    expect(codec.decodeZlibMap(undefined, 1, 1)).toBeNull();
    expect(codec.decodeZlibMap(b64(deflateSync(new Uint8Array([1, 2, 3, 4]))), 2, 2)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("decodes bitsets and depth", () => {
    const s = frame.scene!.surface;
    const flat = codec.decodeBitset(s.flat, s.rows * s.cols)!;
    expect(flat).toHaveLength(2560);
    expect(flat.some(Boolean)).toBe(true);
    const quads = codec.decodeBitset(s.quads.raw, (s.rows - 1) * (s.cols - 1))!;
    expect(quads.filter(Boolean).length).toBeGreaterThan(2000);
    expect(codec.decodeBitset(null, 3)).toBeNull();
    expect(() => codec.decodeBitset("AA==", 9)).toThrow(FactoryError);
    expect(codec.decodeBitset(b64(new Uint8Array([0b101])), 3)).toEqual([true, false, true]);
    expect(codec.depthLogZ(0, -1, 1, 2, 3)).toBe(1);
    expect(codec.depthLogZ(255, -1, 1, 2, 3)).toBe(5);
    expect(codec.depthZ(255, -1, 1, 2, 3)).toBeCloseTo(Math.exp(5));
    const z = codec.decodeDepth(new Uint8Array([0, 255]), s.lo, s.hi, s.a, s.b);
    expect(z[0]).toBeCloseTo(Math.exp(s.a * s.lo + s.b), 4);
    expect(z[1]).toBeCloseTo(Math.exp(s.a * s.hi + s.b), 4);
  });

  it("decodes the surface mesh of a render-ready scene", () => {
    const mesh = codec.decodeSurfaceMesh(scene.surface)!;
    expect(mesh.rows).toBe(40);
    expect(mesh.positions.length).toBe(40 * 64 * 3);
    expect(mesh.indices.length % 3).toBe(0);
    expect(Math.max(...mesh.indices)).toBeLessThan(40 * 64);
    expect(codec.decodeSurfaceMesh(null)).toBeNull();
    expect(codec.decodeSurfaceMesh({ form: "compact", rows: 1, cols: 1 })).toBeNull();
    expect(codec.decodeSurfaceMesh({ form: "vertices", rows: 1, cols: 1 })).toBeNull();
    expect(() => codec.decodeF32le("AAA=")).toThrow(FactoryError);
    expect(() => codec.decodeU16le("AA==")).toThrow(FactoryError);
    expect([...codec.decodeU16le(b64(new Uint8Array([1, 0, 0, 1])))]).toEqual([1, 256]);
  });

  it("reads joints and stone tuples", () => {
    const joints = codec.toJoints(frame.overlay!.joints);
    expect(joints).toHaveLength(70);
    const j = joints.find((x) => x !== null)!;
    expect(Object.keys(j)).toEqual(["u", "v", "vis", "x", "y", "z"]);
    expect(codec.toJoint(null)).toBeNull();
    expect(codec.toJoint([1, 2])).toBeNull();
    expect(codec.toJoints(null)).toEqual([]);
    const item = codec.toStoneItem(frame.overlay!.items[0]!.t);
    expect(item.score).toBeGreaterThan(0);
    expect(Object.keys(item)).toEqual(["u", "v", "w", "h", "score", "X", "Y", "Z", "wM", "hM", "yaw"]);
    expect(() => codec.toStoneItem([1, 2, 3])).toThrow(FactoryError);
  });

  it("converts coordinates", () => {
    expect(codec.uvToPx(0.5, 0.5, 1920, 1080)).toEqual([959.5, 539.5]);
    expect(codec.pxToUv(959.5, 539.5, 1920, 1080)).toEqual([0.5, 0.5]);
    expect(codec.sceneToThree([1, 2, 3])).toEqual([1, 3, -2]);
    expect(codec.threeToScene([1, 3, -2])).toEqual([1, 2, 3]);
    expect(codec.quatToYaw([0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)])).toBeCloseTo(Math.PI / 4);
  });

  it("reads the topology", () => {
    expect(codec.bonesOf(topology).length).toBe(topology.bones.length);
    expect(codec.wristJoint(topology, "left")).toBe(62);
    expect(codec.wristJoint({ ...topology, wrist: {} }, "right")).toBeNull();
    expect(codec.tipJoints(topology, "right").length).toBe(5);
    expect(codec.tipJoints({ ...topology, tips: {} }, "left")).toEqual([]);
  });
});
