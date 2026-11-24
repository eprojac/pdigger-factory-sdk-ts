import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codec, type Sip1Packet } from "pdigger-factory-sdk";
import { readJson } from "../helpers/fixtures.js";

/**
 * The raw packet's 4x stones block (API 2.2, `Sip1Stones`). `test/data/sample-packet-hr-dry1.json` is a packet of the
 * 4x stone head (dry1, g 736), redacted as the published recordings are: no face keypoints, appearance masks or depth
 * texture.
 */
const path = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "sample-packet-hr-dry1.json");
const packet = (): Sip1Packet => JSON.parse(readFileSync(path, "utf8")) as Sip1Packet;
type Stones = Sip1Packet["stones"];
/**
 * Every field the model types: the type checker fails on a key the model lacks, or on one left out here. These are
 * the spec's own (API 2.2.0): the base block and the 4x head's `source`, `centres` and `centre_grid`.
 */
const TYPED: Record<keyof Stones, true> = {
  present: true,
  count: true,
  box: true,
  rot: true,
  grid: true,
  fg: true,
  tray_grid: true,
  tray: true,
  items: true,
  source: true,
  centres: true,
  centre_grid: true,
};
const untyped = (stones: object): string[] => Object.keys(stones).filter((k) => !(k in TYPED));

describe("the 4x stones block (API 2.2)", () => {
  it("types exactly the stones block of the spec", () => {
    const spec = readJson<{
      components: { schemas: { Sip1Packet: { properties: { stones: { properties: Record<string, unknown> } } } } };
    }>("../spec/openapi.json");
    const listed = Object.keys(spec.components.schemas.Sip1Packet.properties.stones.properties);
    expect(Object.keys(TYPED).sort()).toEqual(listed.sort());
  });

  it("types every field and decodes every map on its own grid", () => {
    const s = packet().stones;
    expect(untyped(s)).toEqual([]);
    expect([s.source, s.centres, s.centre_grid]).toEqual(["hr4", "base", [20, 32]]);
    expect([s.grid, s.tray_grid]).toEqual([
      [160, 256],
      [80, 128],
    ]);
    expect([s.count, s.items?.length]).toEqual([39, 39]);
    const [rows, cols] = s.grid as [number, number];
    const fg = codec.decodeZlibMap(s.fg, rows, cols)!;
    expect(fg).toHaveLength(160 * 256);
    expect(fg.some((v) => v > 0)).toBe(true);
    const [trayRows, trayCols] = s.tray_grid as [number, number];
    expect(codec.decodeZlibMap(s.tray, trayRows, trayCols)).toHaveLength(80 * 128);
  });

  it("reads a base block with none of the 4x fields", () => {
    const { source: _source, centres: _centres, centre_grid: _grid, ...base } = packet().stones;
    const s: Stones = base;
    expect([s.source, s.centres, s.centre_grid]).toEqual([undefined, undefined, undefined]);
    expect(untyped(s)).toEqual([]);
  });
});
