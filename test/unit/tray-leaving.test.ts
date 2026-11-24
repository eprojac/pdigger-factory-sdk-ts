import { describe, expect, it } from "vitest";
import { sameStone } from "../../src/interpreter/trays.js";

// Version 5 of the tray rules (SDK-DESIGN.md 4.6.1, Leaving): the leaving pairs a lost tray stone S with an
// unidentified world stone W only on evidence. Looks that agree (the tray's bar over at least N_ID cells) pair them
// and looks that disagree (below T_DIFF over at least N_ID cells) keep them apart, whatever the time and the hands;
// looks in between, too few cells or no look leave it to the time and the hands: W first seen no earlier than
// RENAME_T before S's last sight, and no hand mark near S's place or W's since the earliest of S's last sight, S's
// loss and W's first sight, less RENAME_T.

const BAR = 900; // T_ID_START: the tray's bar before its gauge has 20 pairs
const T_DIFF = 400;
const N_ID = 100;
const RENAME_T = 3.0;
const HAND_R = 0.4;

type Score = readonly [number, number] | null;

interface Case {
  born?: number;
  mark?: readonly [number, readonly [number, number]];
  chain?: boolean;
  stored?: boolean;
}

/**
 * The leaving's verdict on S (last seen at 10.0, lost at 10.4, at (0, 0), its chain one look of world stone 3 at g10)
 * and W (world stone 7 at (0.1, 0), its stored look read at g50), the pair's score `x` taken from the tray's memo.
 */
function same(x: Score, c: Case = {}): boolean {
  const wLook = { wid: 7, g: 50 };
  const tr = {
    store: c.stored === false ? new Map() : new Map([[7, wLook]]),
    memo: new Map([["7,50,3,10", x]]),
    alike: null,
    alikeN: 0,
    marks: c.mark === undefined ? [] : [c.mark],
  };
  const s = { chain: c.chain === false ? [] : [{ wid: 3, g: 10 }], seenT: 10.0, lostT: 10.4, place: [0, 0] };
  const u = { born: { t: c.born ?? 7.2 }, place: [0.1, 0] };
  return sameStone(tr as never, s as never, 7, u as never);
}

describe("the leaving pairs only on evidence (version 5)", () => {
  it("pairs looks that agree, whatever the time and the hands", () => {
    expect(same([BAR, N_ID])).toBe(true);
    expect(same([BAR, N_ID], { born: 1.0, mark: [9.0, [0, 0]] })).toBe(true);
  });

  it("never pairs looks that disagree", () => {
    expect(same([T_DIFF - 1, N_ID])).toBe(false);
    expect(same([T_DIFF - 1, N_ID], { born: 9.0 })).toBe(false);
  });

  it.each([
    ["the lowest score in between", [T_DIFF, N_ID] as Score],
    ["the highest score in between", [BAR - 1, N_ID] as Score],
    ["too few cells to disagree", [T_DIFF - 1, N_ID - 1] as Score],
    ["too few cells to agree", [BAR, N_ID - 1] as Score],
    ["no score", null],
  ])("leaves %s to the time and the hands", (_, x) => {
    expect(same(x)).toBe(true); // W first seen 2.8 s before S's last sight, no hand near
    expect(same(x, { born: 10.0 - RENAME_T })).toBe(true);
    expect(same(x, { born: 10.0 - RENAME_T - 0.1 })).toBe(false);
    expect(same(x, { mark: [9.0, [HAND_R - 0.05, 0]] })).toBe(false); // near S's place
    expect(same(x, { mark: [9.0, [0.1 + HAND_R - 0.05, 0]] })).toBe(false); // near W's place only
    expect(same(x, { mark: [9.0, [0.1 + HAND_R + 0.05, 0]] })).toBe(true); // near neither
    expect(same(x, { mark: [4.1, [0, 0]] })).toBe(true); // before the window: min(10.0, 10.4, 7.2) - RENAME_T = 4.2
    expect(same(x, { mark: [4.3, [0, 0]] })).toBe(false);
  });

  it("scores nothing without S's chain or W's stored look", () => {
    expect(same([T_DIFF - 1, N_ID], { chain: false })).toBe(true);
    expect(same([T_DIFF - 1, N_ID], { stored: false })).toBe(true);
    expect(same([T_DIFF - 1, N_ID], { chain: false, born: 1.0 })).toBe(false);
  });
});
