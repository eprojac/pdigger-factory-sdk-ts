import { describe, expect, it } from "vitest";
import { InterpreterCore, type StoneView, type Tray, type WorldEvent } from "pdigger-factory-sdk";
import { mkFrame, stone } from "../helpers/frames.js";

// Version 4 of the tray rules (SDK-DESIGN.md 4.6.1): a certain removal needs a hand on the stone, and a visit continues
// the open tray only when nine tenths of its first frame's stones were seen on it.

type Ev = Partial<WorldEvent>;
const TOUCH = { left: { state: "touch" as const, stone: null }, right: { state: "free" as const, stone: null } };

interface Step {
  stones: StoneView[];
  events?: Ev[];
  touch?: boolean;
  moving?: boolean;
}

function play(steps: Step[]): Tray[] {
  const core = new InterpreterCore();
  steps.forEach((s, g) => {
    const f = mkFrame(g, {
      stones: s.stones,
      stats: { stones: s.stones.length, confirmed: s.stones.length },
      events: s.events ?? [],
      ...(s.touch === true ? { hands: TOUCH } : {}),
    });
    if (s.moving === true && f.world) f.world.motion = "moving";
    core.feed(f);
  });
  core.end();
  return core.trays();
}

const one = stone(1, [-0.6, 0, 0.05]);
const two = stone(2, [0.6, 0, 0.05]);

/**
 * Stones 1 and 2 arrive; `touch` lands on stone 2 at `touchG`; stone 2 leaves the world at `lossG` with `loss`; a hand
 * works away from the stones at g20 and g40, so a calm moment follows at g43, more than 3 s after the loss.
 */
function removal(touch: Ev[] | null, touchG: number, loss: Ev, lossG: number): Tray {
  const steps: Step[] = [];
  for (let g = 0; g < 50; g++) {
    const gone = g >= lossG;
    const stones = gone ? [one] : [one, two];
    if (g === touchG && touch !== null) steps.push({ stones, events: touch, touch: true });
    else if (g === lossG) steps.push({ stones, events: [loss] });
    else steps.push({ stones, touch: g === 20 || g === 40 });
  }
  return play(steps)[0]!;
}

const removed = (tray: Tray) => tray.facts.filter((f) => f.kind === "removed").map((f) => [f.certain, f.g]);

describe("a certain removal needs a hand on the stone", () => {
  it.each<[string, Ev, boolean]>([
    ["drop", { type: "drop", id: 2, side: "right", why: "t-release" }, true],
    ["gone", { type: "gone", id: 2, side: "right" }, true],
    ["delete by a hand", { type: "delete", id: 2, why: "hand" }, true],
    ["delete carried away", { type: "delete", id: 2, why: "carried-away" }, true],
    ["delete absent", { type: "delete", id: 2, why: "absent" }, false],
  ])("a loss by %s is a hand touch: %s", (_name, loss, touched) => {
    expect(removed(removal(null, -1, loss, 30))).toEqual([touched ? [true, 43] : [false, 49]]);
  });

  it.each<[string, Ev, boolean]>([
    ["lift", { type: "lift", id: 2, side: "right" }, true],
    ["push with a side", { type: "push", id: 2, side: "left" }, true],
    ["push without a side", { type: "push", id: 2, why: "reseat" }, false],
    ["freeze", { type: "freeze", id: 2 }, false],
  ])("a %s before a silent loss is a hand touch: %s", (_name, touch, touched) => {
    const tray = removal([touch], 24, { type: "delete", id: 2, why: "absent" }, 28);
    expect(removed(tray)).toEqual([touched ? [true, 43] : [false, 49]]);
  });

  it("names the open removal no_hand when no hand touched it", () => {
    const tray = removal(null, -1, { type: "delete", id: 2, why: "absent" }, 30);
    expect(tray.facts.filter((f) => f.kind === "removed").map((f) => f.code)).toEqual(["not_found"]);
    expect(tray.facts.at(-1)?.open?.map((o) => [o.kind, o.cause])).toEqual([["removed", "no_hand"]]);
  });

  it("does not count a touch before both the last calm moment and the three seconds before the last sight", () => {
    // pushed at g5 (t 1.0); a calm moment at g23 (t 4.6); lost silently at g30 (t 6.0), last seen at g29: the window
    // starts at min(4.6, 5.8 - 3.0) = 2.8, after the push
    const tray = removal([{ type: "push", id: 2, side: "left" }], 5, { type: "delete", id: 2, why: "absent" }, 30);
    expect(removed(tray)).toEqual([[false, 49]]);
  });

  it("counts a touch after the last calm moment while hands keep working until the loss", () => {
    // a calm moment at g23 (t 4.6); pushed at g25 (t 5.0); hands work until stone 2 is lost silently at g44 (t 8.8),
    // last seen at g43: the window starts at min(4.6, 8.6 - 3.0) = 4.6, so the push counts
    const steps: Step[] = [];
    for (let g = 0; g < 66; g++) {
      const stones = g >= 44 ? [one] : [one, two];
      if (g === 25) steps.push({ stones, events: [{ type: "push", id: 2, side: "left" }], touch: true });
      else if (g === 44) steps.push({ stones, events: [{ type: "delete", id: 2, why: "absent" }], touch: true });
      else steps.push({ stones, touch: g === 20 || (g > 25 && g < 44) || g === 55 });
    }
    expect(removed(play(steps)[0]!)).toEqual([[true, 58]]);
  });
});

/** Ten stones arrive; the conveyor moves; then a board whose first frame shows `known` of them and 10 - `known` new. */
function board(known: number): Tray[] {
  const first = Array.from({ length: 10 }, (_, i) => stone(i, [-0.9 + 0.2 * i, 0, 0.05]));
  const next = first.map((s, i) => (i < known ? s : stone(100 + i, [-0.9 + 0.2 * i, 0, 0.05])));
  const steps: Step[] = [];
  for (let g = 0; g < 12; g++) steps.push({ stones: first });
  for (let g = 0; g < 3; g++) steps.push({ stones: first, moving: true });
  const news = next.slice(known).map((s): Ev => ({ type: "new", id: s.id }));
  steps.push({ stones: next, events: news });
  for (let g = 0; g < 11; g++) steps.push({ stones: next });
  return play(steps);
}

describe("a visit continues the open tray only when nine tenths of its stones were seen", () => {
  it("goes on with nine of ten", () => {
    expect(board(9).map((t) => t.n)).toEqual([1]);
  });

  it("opens a new tray with eight of ten", () => {
    const trays = board(8);
    expect(trays.map((t) => t.n)).toEqual([1, 2]);
    expect(trays.map((t) => t.stones.filter((s) => s.status === "on").length)).toEqual([10, 10]);
  });
});
