import { describe, expect, it } from "vitest";
import { InterpreterCore, type StoneView, type WorldEvent } from "pdigger-factory-sdk";
import { mkFrame, stone } from "../helpers/frames.js";

/**
 * Version 7 of the tray rules (SDK-DESIGN.md 4.6.1, Positive evidence at departure): an unidentified world stone that
 * the leaving point's world keeps (lists, not detected), not held, with less than OVERLAP of its box under one other
 * unheld stone's box there, is counted as an unclear addition at its place there.
 */

// A neighbour 5 of stone 3: its mode from g 12 on, and its place across from 3's (0, 0); its box (0.3 by 0.2, as 3's)
// then covers 6 (y 0.09: 0.24) or 8 (y 0.05: 0.32) of the 25 points of 3's box.
const KEPT = {
  alone: null,
  beside_kept: ["kept", 0.09],
  under_kept: ["kept", 0.05],
  under_seen: ["seen", 0.05],
  under_held: ["carry", 0.05],
  held: null,
  moved_later: null,
  rival_later: ["seen", 0.05],
} as const satisfies Record<string, readonly ["kept" | "seen" | "carry", number] | null>;
type Case = keyof typeof KEPT;

function slab(
  id: number,
  x: number,
  y: number,
  mode: StoneView["mode"],
  detected: boolean,
  dims: [number, number, number] = [0.3, 0.2, 0.092],
): StoneView {
  return stone(id, [x, y, dims[2] / 2], {
    mode,
    shape: "frozen",
    detected,
    solid: { pos: [x, y, dims[2] / 2], q: [0, 0, 0, 1], dims },
  });
}

/**
 * Stones 1 and 2 arrive with the tray; world stone 3 comes at g 10, boxed at g 10 and 11, then kept (held, in case
 * `held`), and in some cases a neighbour 5 comes with it. The tray leaves at its last frame, g 17, a calm one; in the
 * `_later` cases a new event at g 15 makes g 14 the leaving point, after which 3 moves 0.05 or 5 first comes.
 */
function scene(variant: Case) {
  const core = new InterpreterCore();
  for (let g = 0; g <= 17; g++) {
    const later = variant.endsWith("_later") && g >= 15;
    const stones = [slab(1, -0.6, 0, "kept", true), slab(2, 0.6, 0, "kept", true)];
    if (g >= 10) {
      const x = later && variant === "moved_later" ? 0.05 : 0;
      stones.push(slab(3, x, 0, g < 12 ? "seen" : variant === "held" ? "carry" : "kept", g < 12));
      const neighbour = KEPT[variant];
      if (neighbour !== null && (variant !== "rival_later" || later)) {
        const [mode, y] = neighbour;
        stones.push(slab(5, 0.2, y, g < 12 ? "seen" : mode, g < 12 || mode === "seen"));
      }
    }
    const events: WorldEvent[] = later && g === 15 ? [{ type: "new", id: 100 }] : [];
    core.feed(mkFrame(g, { t: g * 0.2, stones, events, stats: { stones: stones.length, confirmed: stones.length } }));
  }
  core.end();
  return core.trays()[0]!;
}

describe("a kept stone at the leaving point (version 7)", () => {
  it.each([
    ["alone", { 3: [0, 0] }],
    ["beside_kept", { 3: [0, 0], 5: [0.2, 0.09] }], // 0.24 of each box under the other
    ["under_kept", {}], // 0.32: a kept stone hides one
    ["under_seen", { 5: [0.2, 0.05] }], // so does a detected one, itself counted by its box on the last frame
    ["under_held", { 3: [0, 0] }], // a held stone hides none, and is not counted itself
    ["held", {}],
    ["moved_later", { 3: [0, 0] }], // its place at the leaving point, not at the last frame
    ["rival_later", { 3: [0, 0] }], // the stones of the leaving point hide it, not the last frame's
  ] as const)("is a possible addition, or hidden (%s)", (variant, counted) => {
    const tray = scene(variant);
    const leaving = tray.facts.at(-1)!;
    expect(leaving.g).toBe(variant.endsWith("_later") ? 14 : 17);
    const added = tray.stones.filter((s) => s.added);
    const n = Object.keys(counted).length;
    expect(Object.fromEntries(added.map((s) => [s.worldId, s.place]))).toEqual(counted);
    for (const s of added) {
      expect([s.sure, s.certain]).toEqual([false, false]);
      expect(tray.facts.filter((f) => f.stone === s.id).map((f) => f.code)).toEqual(["not_recognised"]);
      // only a detected stone has a place seen at the leaving point
      expect(s.leftPlace).toEqual(variant === "under_seen" && s.worldId === 5 ? [0.2, 0.05] : null);
    }
    expect([leaving.stones, leaving.sure, leaving.added, leaving.unclear]).toEqual([2 + n, 2, 0, n]);
  });
});

/** The board of the synthetic tray recording: 2 m by 1.2 m around the origin. */
const BOARD = { cx: 0, cy: 0, theta: 0, hw: 1, hh: 0.6 };

// Where the leaving reads the leaving point's world, and which of its stones hide a kept one: the case, its leaving g,
// its leaving fact's [stones, sure, added, removed, unclear], and each stone counted as a possible addition: its world
// id, [place, size, leftPlace].
type Counted = Record<number, [[number, number], [number, number], [number, number] | null]>;
const LEAVING: Record<string, [number, [number, number, number, number, number], Counted]> = {
  // a hand works at g 15, after the calm g 14: the leaving point is the last frame, g 17, where 3 is kept at x 0.05
  worked: [17, [3, 2, 0, 0, 1], { 3: [[0.05, 0], [0.3, 0.2], null] }],
  // the same, with a stone 5 boxed over 0.32 of 3's box from g 15: 5 is counted (boxed on the last frame), 3 is hidden
  worked_under_seen: [
    17,
    [3, 2, 0, 0, 1],
    {
      5: [
        [0.2, 0.05],
        [0.3, 0.2],
        [0.2, 0.05],
      ],
    },
  ],
  // boxed but held at the leaving point g 14, kept after: neither version 6 nor version 7 counts it
  held_seen: [14, [2, 2, 0, 0, 0], {}],
  // boxed at the leaving point g 14 with 0.32 of its box under a kept 5: version 6 counts it whatever the overlap (and
  // 5, under 3, is hidden)
  seen_under_kept: [
    14,
    [3, 2, 0, 0, 1],
    {
      3: [
        [0, 0],
        [0.3, 0.2],
        [0, 0],
      ],
    },
  ],
  // held only after the leaving point: counted, the leaving point's row decides
  held_later: [14, [3, 2, 0, 0, 1], { 3: [[0, 0], [0.3, 0.2], null] }],
  // its box grows to 0.36 after the leaving point: counted with the leaving point's size
  resized_later: [14, [3, 2, 0, 0, 1], { 3: [[0, 0], [0.3, 0.2], null] }],
  // 0.32 of its box under a tray stone's (stone 1, there since the arrival, itself doubted for the overlap): hidden
  under_linked: [17, [2, 1, 0, 0, 0], {}],
  // 0.40 of its box under the box of a stone off the board (never on the tray): hidden all the same
  under_offboard: [17, [2, 2, 0, 0, 0], {}],
  // 0.32 under a kept 5 at the leaving point g 14 that is gone by the last frame: hidden (and 5 is not on the tray)
  gone_later: [14, [2, 2, 0, 0, 0], {}],
  // kept in another mode (transit, not detected): the world keeps it on the tray all the same
  transit: [14, [3, 2, 0, 0, 1], { 3: [[0, 0], [0.3, 0.2], null] }],
};

/**
 * Stones 1 and 2 arrive with the tray (1 at (0.2, 0.05) in case under_linked); world stone 3 comes at g 10 (at (0.95,
 * 0) in case under_offboard, beside stone 9 off the board), boxed at g 10 and 11, then kept, unless the case says
 * otherwise. A hand event at g 15 (the worked cases) makes the last frame, g 17, the leaving point; a `new` event there
 * (the others but under_linked and under_offboard) makes it the calm g 14; with neither it is g 17, calm too.
 */
function leavingScene(variant: string) {
  const core = new InterpreterCore();
  const worked = variant.startsWith("worked");
  const rock = (id: number, x: number, y = 0, mode: StoneView["mode"] = "seen", detected = mode === "seen") =>
    slab(id, x, y, mode, detected);
  for (let g = 0; g <= 17; g++) {
    const later = g >= 15;
    let events: WorldEvent[] = [];
    if (g === 15 && worked) events = [{ type: "place", side: "left", id: 1 }];
    else if (g === 15 && variant !== "under_linked" && variant !== "under_offboard")
      events = [{ type: "new", id: 100 }];
    const stones = [variant === "under_linked" ? rock(1, 0.2, 0.05) : rock(1, -0.6), rock(2, 0.6)];
    if (g >= 10) {
      let [mode, detected]: [StoneView["mode"], boolean] = g < 12 ? ["seen", true] : ["kept", false];
      if (variant === "held_seen" && g >= 12 && g <= 14) [mode, detected] = ["carry", true];
      if (variant === "seen_under_kept" && g <= 14) [mode, detected] = ["seen", true];
      if (variant === "held_later" && later) [mode, detected] = ["carry", false];
      if (variant === "transit" && g >= 12) [mode, detected] = ["transit", false];
      const x = variant === "under_offboard" ? 0.95 : later && variant === "worked" ? 0.05 : 0;
      const dims: [number, number, number] =
        variant === "resized_later" && later ? [0.36, 0.2, 0.092] : [0.3, 0.2, 0.092];
      stones.push(slab(3, x, 0, mode, detected, dims));
      if (variant === "worked_under_seen" && later) stones.push(rock(5, 0.2, 0.05));
      if (variant === "seen_under_kept" || (variant === "gone_later" && !later))
        stones.push(rock(5, 0.2, 0.05, g < 12 ? "seen" : "kept"));
      if (variant === "under_offboard") stones.push(rock(9, 1.15));
    }
    const n = stones.length;
    core.feed(mkFrame(g, { t: g * 0.2, stones, events, board: BOARD, stats: { stones: n, confirmed: n } }));
  }
  core.end();
  return core.trays()[0]!;
}

describe("the leaving point's world (version 7)", () => {
  it.each(Object.keys(LEAVING))("decides what is counted (%s)", (variant) => {
    const [leaveG, counts, counted] = LEAVING[variant]!;
    const tray = leavingScene(variant);
    const leaving = tray.facts.at(-1)!;
    expect(leaving.g).toBe(leaveG);
    expect([leaving.stones, leaving.sure, leaving.added, leaving.removed, leaving.unclear]).toEqual(counts);
    const added = tray.stones.filter((s) => s.added);
    expect(Object.fromEntries(added.map((s) => [s.worldId, [s.place, s.size, s.leftPlace ?? null]]))).toEqual(counted);
    for (const s of added) {
      expect([s.sure, s.certain]).toEqual([false, false]);
      expect(tray.facts.filter((f) => f.stone === s.id).map((f) => f.code)).toEqual(["not_recognised"]);
    }
  });
});

describe("a second stop's nominated clean frame (version 7)", () => {
  /**
   * Motion at g 13 separates two visits; at the second stop a silent absence of stone 2 at g 23 interrupts its one
   * three-frame quiet run, so the tray leaves at its nominated clean frame, g 22. An unidentified stone 5, boxed at
   * (0.30, 0.30) in the first visit, kept at (0.32, 0.30) through g 22 and at (0.36, 0.30) after, is counted at its
   * place there (version 7); boxed there, with that place as its leftPlace too (version 6); under a kept stone 6 that
   * comes at g 21, it is not, and nor is 6.
   */
  function secondStop(variant: "kept" | "seen" | "hidden") {
    const core = new InterpreterCore();
    const small = (id: number, x: number, y: number, seen: boolean) =>
      slab(id, x, y, seen ? "seen" : "kept", seen, [0.05, 0.04, 0.03]);
    for (let g = 0; g <= 25; g++) {
      const positions: [number, number][] = [
        [1, g <= 22 ? -0.5 : -0.48],
        [2, 0],
        [3, 0.6],
      ];
      const stones = positions
        .filter(([id]) => id !== 2 || g !== 23)
        .map(([id, x]) => small(id, x, 0, id !== 3 || g < 21));
      if (g >= 8) {
        const seen = g <= 12 || (variant === "seen" && g === 22);
        stones.push(small(5, g <= 12 ? 0.3 : g <= 22 ? 0.32 : 0.36, 0.3, seen));
        if (variant === "hidden" && g >= 21) stones.push(small(6, 0.33, 0.3, false));
      }
      const events: WorldEvent[] = (g >= 14 && g <= 20) || g >= 24 ? [{ type: "new", id: 100 }] : [];
      const n = stones.length;
      const f = mkFrame(g, { stones, events, board: BOARD, stats: { stones: n, confirmed: n } });
      if (g === 13) f.world!.motion = "moving";
      core.feed(f);
    }
    core.end();
    return core.trays();
  }

  it.each([
    ["kept", { 5: [[0.32, 0.3], [0.05, 0.04], null] }],
    [
      "seen",
      {
        5: [
          [0.32, 0.3],
          [0.05, 0.04],
          [0.32, 0.3],
        ],
      },
    ],
    ["hidden", {}],
  ] as const)("counts what it kept (%s)", (variant, counted) => {
    const trays = secondStop(variant);
    expect(trays).toHaveLength(1);
    const tray = trays[0]!;
    const leaving = tray.facts.at(-1)!;
    const n = Object.keys(counted).length;
    expect([leaving.g, leaving.stones, leaving.sure, leaving.unclear]).toEqual([22, 3 + n, 2, n]);
    const added = tray.stones.filter((s) => s.added);
    expect(Object.fromEntries(added.map((s) => [s.worldId, [s.place, s.size, s.leftPlace ?? null]]))).toEqual(counted);
  });
});
