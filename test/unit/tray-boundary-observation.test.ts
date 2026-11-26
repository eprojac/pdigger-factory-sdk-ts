import { describe, expect, it } from "vitest";
import { InterpreterCore, type StoneView, type WorldEvent } from "pdigger-factory-sdk";
import { mkFrame, stone } from "../helpers/frames.js";

const rejected = [
  "one earlier sight",
  "gap",
  "hand",
  "replacement",
  "drift after",
  "drift before",
  "size after",
  "size before",
  "new rival after",
  "new rival before",
  "overlap after",
  "overlap before",
  "unfrozen before",
  "unfrozen at sight",
  "unfrozen after",
  "ended",
  "new calm",
  "expired",
  "time before sight",
] as const;
type Case =
  (typeof rejected)[number] | "observed" | "stable neighbour" | "latest positive" | "detected at the leaving point";

function solid(id: number, x: number, detected = true, frozen = true, long = 0.09): StoneView {
  return stone(id, [x, 0, 0.05], {
    shape: frozen ? "frozen" : "model",
    detected,
    mode: detected ? "seen" : "kept",
    solid: { pos: [x, 0, 0.05], dims: [long, 0.05, 0.046], q: [0, 0, 0, 1] },
  });
}

/** Track 3 was unidentified, then kept at the calm point. Frame 15 sees it while track 1 is briefly missing. */
function account(variant: Case) {
  const core = new InterpreterCore();
  const last = variant === "expired" ? 32 : variant === "new calm" ? 21 : 17;
  for (let g = 0; g <= last; g++) {
    const stones = g === 15 ? [solid(2, 0.6)] : [solid(1, -0.6), solid(2, 0.6)];
    if (g >= 10) {
      const detected =
        g === 10 ||
        (g === 11 && variant !== "one earlier sight") ||
        g === 15 ||
        (g === 16 && variant === "latest positive") ||
        (g === 14 && variant === "detected at the leaving point");
      const x =
        variant === "latest positive" && g >= 16
          ? 0.06
          : (variant === "drift after" && g >= 16) || (variant === "drift before" && g === 15)
            ? 0.31
            : 0;
      const frozen = !(
        (variant === "unfrozen after" && g >= 16) ||
        (variant === "unfrozen at sight" && g === 15) ||
        (variant === "unfrozen before" && g === 14)
      );
      const long = (variant === "size after" && g >= 16) || (variant === "size before" && g === 15) ? 0.4 : 0.09;
      stones.push(solid(variant === "replacement" && g >= 16 ? 4 : 3, x, detected, frozen, long));
      const when = variant === "new rival after" || variant === "overlap after" ? 16 : 15;
      if (
        variant === "stable neighbour" ||
        ((variant.startsWith("new rival") || variant.startsWith("overlap")) && g >= when)
      )
        stones.push(solid(5, variant.startsWith("overlap") ? 0.01 : 0.13, false));
    }
    const events: WorldEvent[] = [];
    if (g === 16 || (variant === "expired" && g > 16)) events.push({ type: "new", id: 100 });
    if (g === 16 && variant === "ended") events.push({ type: "delete", id: 3, why: "absent" });
    if (g === 16 && variant === "hand") events.push({ type: "place", id: 2, side: "left" });
    if (g === 16 && variant === "gap") core.gap();
    // Frame 15 supplies the sight at 3.0 s. Frame 16 can invalidate it even if frame 17 catches up.
    const t = variant === "time before sight" && g === 16 ? 2.9 : g / 5;
    core.feed(mkFrame(g, { t, stones, events, stats: { stones: stones.length, confirmed: stones.length } }));
  }
  core.end();
  return core.trays()[0]!;
}

describe("a late positive sighting of a kept departure track", () => {
  it.each(["observed", "stable neighbour"] as const)("counts occupancy with uncertain origin (%s)", (variant) => {
    const tray = account(variant);
    // the stable neighbour, kept at the leaving point with less than 0.30 of its box under another unheld stone's, is a
    // possible addition too (version 7)
    const n = variant === "stable neighbour" ? 2 : 1;
    expect(tray.facts.at(-1)).toMatchObject({ g: 14, stones: 2 + n, sure: 2, added: 0, unclear: n });
    expect(tray.stones.find((s) => s.worldId === 3)).toMatchObject({
      added: true,
      certain: false,
      sure: false,
      leftPlace: null,
      place: [0, 0],
    });
    expect(tray.report()?.added.map((c) => [c.certain, c.code])).toEqual(
      Array.from({ length: n }, () => [false, "not_recognised"]),
    );
  });
  it("uses the last positive position without claiming a sight at the leaving frame", () => {
    const tray = account("latest positive");
    expect(tray.stones.find((s) => s.worldId === 3)).toMatchObject({ leftPlace: null, place: [0.06, 0], sure: false });
    expect(tray.report()!.added[0]!.place).toEqual([0.06, 0]);
  });
  it("counts a kept track detected at the leaving point, at its place there", () => {
    // no hand worked after the leaving point (g 14): the track is on the tray that leaves, of unclear origin
    const tray = account("detected at the leaving point");
    expect(tray.facts.at(-1)).toMatchObject({ g: 14, stones: 3, sure: 2, added: 0, unclear: 1 });
    expect(tray.stones.find((s) => s.worldId === 3)).toMatchObject({
      added: true,
      certain: false,
      sure: false,
      leftPlace: [0, 0],
      place: [0, 0],
    });
  });
  it.each(rejected.filter((v) => v !== "replacement"))(
    "counts a kept track the sight cannot place at its place at the leaving point (%s)",
    (variant) => {
      // the sight fails, but the leaving point's world kept the track, not held, with less than 0.30 of its box under
      // another unheld stone's: it is counted there, at the world's place for it, never at the sight's (version 7)
      expect(account(variant).stones.filter((s) => s.worldId === 3 && s.added)).toMatchObject([
        { certain: false, sure: false, leftPlace: null, place: [0, 0] },
      ]);
    },
  );
  it("withholds a track the last world no longer has (replacement)", () => {
    expect(account("replacement").stones.some((s) => s.worldId === 3 && s.added)).toBe(false);
  });
});
