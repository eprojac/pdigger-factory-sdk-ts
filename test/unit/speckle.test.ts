/**
 * The unit's speckle answers (SDK-DESIGN.md 4.6.12): read by value, the tray stones that hold them, the answer that
 * comes after its tray left, and the answers as JSON. The golden tests compare every answer read (`speckle.txt`).
 */
import { describe, expect, it } from "vitest";
import { Replay, type SpeckleSide, type StoneSpeckle, type TraySpeckle, type WorldLayer } from "pdigger-factory-sdk";
import { cleanWorld } from "../../src/internal/looks.js";
import { readBytes } from "../helpers/fixtures.js";

/** A well-formed answer: finds without at, score or second still fit. */
const ANSWER = {
  v: 1,
  tray: 2,
  ref: { g: 4, t: 0.8 },
  at: { g: 20, t: 4 },
  device: "d",
  gpu_ms: 1.5,
  wall_ms: 2,
  stones: [{ id: 1, at: null, score: null, second: null }, { id: 2 }],
  refs: [{ id: 3, at: 4, score: 0.5, second: -1 }],
  pairs: [[1, 3]],
};

const world = (speckle: unknown): WorldLayer => cleanWorld({ g: 7, stones: [], speckle }) as unknown as WorldLayer;

/** The answer with `members` replaced (a member given as undefined is left out). */
const changed = (members: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = structuredClone(ANSWER);
  for (const [k, v] of Object.entries(members)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
};

describe("the unit's speckle answers", () => {
  it("reads an answer by value", () => {
    expect(world(ANSWER).speckle).toEqual(ANSWER);
  });

  it.each([
    null,
    5,
    "x",
    [],
    {},
    changed({ v: 2 }),
    changed({ v: true }),
    changed({ tray: "2" }),
    changed({ tray: 1.5 }),
    changed({ ref: { g: 4 } }),
    changed({ at: { g: 1.5, t: 0 } }),
    changed({ at: 3 }),
    changed({ device: 5 }),
    changed({ gpu_ms: "1" }),
    changed({ wall_ms: undefined }),
    changed({ stones: {} }),
    changed({ stones: [5] }),
    changed({ refs: [{ id: 1.5 }] }),
    changed({ refs: [{ id: 1, at: "x" }] }),
    changed({ refs: [{ id: 1, score: 0.5 }] }),
    changed({ refs: [{ id: 1, score: 0.5, second: "x" }] }),
    changed({ pairs: [[1]] }),
    changed({ pairs: [5] }),
    changed({ pairs: [[1, 2.5]] }),
    changed({ pairs: {} }),
  ])("drops an answer that does not fit: %j", (bad) => {
    const w = world(bad);
    expect("speckle" in w).toBe(false);
    expect(w.g).toBe(7);
  });

  it("gives each tray stone the newest answer read while its tray was on", () => {
    const replay = Replay.fromBytes(readBytes("recordings/trays-speckle-synthetic.ndjson.gz"));
    const ups = [...replay.updatesSync()];
    // tray 3's leaving answer comes in its first moving frame, g 123 (4.6.13)
    expect(ups.flatMap((u) => u.speckle.map((a) => a.g))).toEqual([24, 30, 32, 36, 46, 50, 123]);
    const revised = ups.filter((u) => u.isRevision && u.frame?.world?.speckle !== undefined);
    expect(revised.map((u) => u.speckle)).toEqual([[]]); // a revision's answer is not read again
    const core = replay.core;
    if (core === null) throw new Error("no pass");
    const trays = core.trays();
    const one = "20261118T000000.8Z-1-";
    const two = "20261118T000007.8Z-2-";
    const held = (tray: number, id: string): StoneSpeckle => {
      const s = trays[tray]?.stones.find((x) => x.id === id)?.speckle;
      if (s === null || s === undefined) throw new Error(`no answer for ${id}`);
      return s;
    };
    expect(held(0, `${one}1`)).toMatchObject({ found: null, foundWorld: 1, clean: true }); // g 32's
    expect(held(0, `${one}2`)).toMatchObject({ score: 0.8, same: true }); // g 36's: the tray was still on
    expect(held(0, `${one}4`)).toMatchObject({ pair: `${one}5`, same: false, score: 0.5 }); // g 30's, not g 46's
    expect(held(1, `${two}13`)).toMatchObject({ side: "later" satisfies SpeckleSide, found: `${two}13` });
    expect(held(1, `${two}12`)).toMatchObject({ pair: null, clean: false });
    const answers = core.speckle();
    const late = answers[4] as TraySpeckle;
    expect([answers.length, late.g, late.tray, late.unitTray]).toEqual([7, 46, 1, 1]);
    expect(late.stone(`${one}4`)).not.toBeNull();
    expect(late.stone(`${one}1`)).toBeNull();
    expect(late.wall).not.toBeNull();
    const json = JSON.parse(JSON.stringify(late)) as { stones: { side: string }[]; ref: unknown };
    expect(json.stones[0]?.side).toBe("arrival");
    expect(json.ref).toEqual({ g: 4, t: 0.8 });
    const stones = JSON.parse(JSON.stringify(trays[0]?.stones)) as { speckle: unknown }[];
    expect(stones.every((s) => s.speckle !== null)).toBe(true);
    expect(JSON.parse(JSON.stringify(trays[1]?.stones))[0]).toHaveProperty("speckle");
  });
});
