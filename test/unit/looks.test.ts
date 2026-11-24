/**
 * The look score (SDK-DESIGN.md 4.6.2) against the reference, on the synthetic looks of fixtures/looks: the same double,
 * pair count and permille for every pair, and no score where the reference has none; which looks fit `StoneLook` by
 * value, which read and which the tray rules use (4.6.3).
 */
import { describe, expect, it } from "vitest";
import {
  FactoryClient,
  InterpreterCore,
  LOOK_CELLS,
  lookPairing,
  lookPermille,
  lookScore,
  usableLook,
  type StoneLook,
  type StoneView,
} from "pdigger-factory-sdk";
import { InstantClock } from "pdigger-factory-sdk/testing";
import { cleanFrame, cleanStone, cleanWorld } from "../../src/internal/looks.js";
import { fitsLook, readLook } from "../../src/interpreter/looks.js";
import { classifyLine } from "../../src/recording.js";
import { readJson } from "../helpers/fixtures.js";
import { mkFrame, stone } from "../helpers/frames.js";

interface Vectors {
  looks: Record<string, unknown>;
  unreadable: string[];
  tray_unusable: string[];
  model_none: string[];
  /** [a, b, the score as text, the pairs of the placement that gave it, its permille]; null: no score. */
  scores: [string, string, string | null, number | null, number | null][];
}

const vectors = (): Vectors => readJson<Vectors>("looks/looks-synthetic.json");

describe("look score", () => {
  it("matches the reference on every synthetic pair", () => {
    const v = vectors();
    const look = (name: string): StoneLook => v.looks[name] as StoneLook;
    expect(v.scores.length).toBeGreaterThanOrEqual(300);
    expect(v.unreadable.length).toBeGreaterThanOrEqual(6);
    expect(v.model_none.length).toBeGreaterThanOrEqual(8);
    for (const name of Object.keys(v.looks)) {
      const none = v.model_none.includes(name); // the other languages' models drop it
      const unread = none || v.unreadable.includes(name);
      expect(fitsLook(v.looks[name]), name).toBe(!none);
      expect(readLook(v.looks[name]) === null, name).toBe(unread);
      expect(usableLook(look(name)), name).toBe(!unread && !v.tray_unusable.includes(name));
    }
    for (const name of v.unreadable) expect(lookScore(look(name), look(name)), name).toBeNull();
    let scored = 0;
    for (const [a, b, want, n, p] of v.scores) {
      const got = lookScore(look(a), look(b));
      const pair = lookPairing(look(a), look(b));
      if (want === null) {
        expect([got, pair, n, p], `${a} against ${b}`).toEqual([null, null, null, null]);
        continue;
      }
      expect(got, `${a} against ${b}`).toBe(Number(want));
      expect(pair, `${a} against ${b}`).toEqual([got, n]);
      expect(lookPermille(Number(want)), `${a} against ${b}`).toBe(p);
      scored++;
    }
    expect(scored).toBeGreaterThanOrEqual(150);
  });

  it("reads a look by value", () => {
    const v = vectors();
    const whole = v.looks["type-nu-whole-float"] as StoneLook; // nu 18.0 in the file
    expect([fitsLook(whole), whole.nu, readLook(whole) !== null]).toEqual([true, 18, true]);
    const big = v.looks["type-over-4096-cells"] as StoneLook;
    expect(fitsLook(big)).toBe(true);
    expect(big.nu * big.nv).toBeGreaterThan(LOOK_CELLS);
    expect(readLook(big)).toBeNull();
    const good = v.looks["brick-b"] as StoneLook;
    expect(fitsLook({ ...good, sp: Number.POSITIVE_INFINITY })).toBe(false);
    expect(fitsLook([1, 2])).toBe(false);
    expect(fitsLook(null)).toBe(false);
  });

  it("a bad look leaves its stone on the tray, without a look", () => {
    const v = vectors();
    const core = new InterpreterCore();
    const bricks = v.model_none.map((name, i) =>
      stone(i + 1, [0.4 * i, 0, 0.05], { look: v.looks[name] as StoneLook }),
    );
    const stats = { stones: bricks.length, confirmed: bricks.length };
    for (let g = 0; g < 20; g++) core.feed(mkFrame(g, { stones: bricks, stats }));
    const tray = core.state.tray;
    expect(tray?.stones.map((s) => [s.worldId, s.status, s.sure, s.looks.length])).toEqual(
      bricks.map((b) => [b.id, "on", true, 0]),
    );
    expect(tray?.tId).toBeNull(); // the tray took no look
  });

  it("the public readers drop a look that does not fit, and keep its stone", async () => {
    const good = vectors().looks["brick-b"] as StoneLook;
    const stones = (): StoneView[] => [
      stone(7, [0, 0, 0.05], { look: {} as StoneLook }),
      stone(8, [0.4, 0, 0.05], { look: good }),
      stone(9),
    ];
    const frame = (): unknown => JSON.parse(JSON.stringify(mkFrame(3, { stones: stones() })));
    const looks = (ss: readonly StoneView[] | undefined): [number, boolean][] =>
      (ss ?? []).map((s) => [s.id, s.look !== undefined]);
    const want = [
      [7, false],
      [8, true],
      [9, false],
    ];
    const line = classifyLine(frame(), true); // a recording's frame
    expect(line.kind === "frame" ? looks(line.frame.world?.stones) : null).toEqual(want);
    const replies: Record<string, unknown> = {
      "/api/v2/session/world": (frame() as { world: unknown }).world,
      "/api/v2/session/frames/3": frame(),
      "/api/v2/session/frames": { cursor: 4, frames: [frame()] },
      "/api/v2/session/world/stones/7": { id: 7, stone: stones()[0] },
      "/api/v2/session/world/stones/8": { id: 8, stone: null },
    };
    let empty = false; // a poll reply without frames
    const factory = new FactoryClient("http://unit.test", {
      clock: new InstantClock(),
      fetch: (input) => {
        const path = new URL(String(input)).pathname;
        const body = path === "/api/v2/session/frames" && empty ? { cursor: 4 } : replies[path];
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      },
    });
    expect(looks((await factory.api.getWorld()).stones)).toEqual(want);
    expect(looks((await factory.api.getFrame(3)).world?.stones)).toEqual(want);
    expect(looks((await factory.api.pollFrames()).frames[0]?.world?.stones)).toEqual(want);
    empty = true;
    expect((await factory.api.pollFrames()).frames).toBeUndefined();
    const track = await factory.api.getStone(7);
    expect([track.stone?.id, track.stone?.look]).toEqual([7, undefined]);
    expect((await factory.api.getStone(8)).stone).toBeNull();
    // what is not a frame, a world or a stone is left as it is
    expect([cleanFrame(null), cleanFrame({ g: 1 }), cleanWorld({ g: 1 }), cleanStone(5)]).toEqual([
      null,
      { g: 1 },
      { g: 1 },
      5,
    ]);
  });

  it("decodes a look only when its cells have the length of nu x nv bytes", () => {
    const one = { ...(vectors().looks["brick-b"] as StoneLook), nu: 1, nv: 1 };
    expect(readLook({ ...one, d: "AA==" })).not.toBeNull(); // one cell: 4 characters
    expect(readLook({ ...one, d: "A".repeat(4_000_000) })).toBeNull(); // far too long: never decoded
    expect(readLook({ ...one, d: "AAA" })).toBeNull();
    // the shape check and the length check read `d`; only cells of the right length are read once more, to decode
    const reads = (d: string): number => {
      let n = 0;
      readLook({
        ...one,
        get d() {
          n++;
          return d;
        },
      });
      return n;
    };
    expect(["A".repeat(4_000_000), "AA==AA==", "A", ""].map(reads)).toEqual([2, 2, 2, 2]);
    expect([reads("AAA="), reads("AA==")]).toEqual([3, 3]); // the right length: decoded (to two bytes, then one)
  });

  it("refuses what is not a look", () => {
    const v = vectors();
    const good = v.looks["brick-b"] as StoneLook;
    expect(lookScore(null, good)).toBeNull();
    expect(lookScore(good, undefined)).toBeNull();
    expect(lookPairing(null, null)).toBeNull();
    expect(usableLook(undefined)).toBe(false);
    expect(readLook({ ...good, nu: 0 })).toBeNull();
    expect(readLook({ ...good, d: "gBAg8OAw0MAA9y" })).toBeNull();
    expect(readLook({ ...good, d: 7 as unknown as string })).toBeNull();
    expect(lookScore(good, good)).toBe(1);
  });
});
