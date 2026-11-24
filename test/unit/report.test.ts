/**
 * Tray reports (SDK-DESIGN.md section 4.7) beyond the golden files: the trays that have none, the values, the text
 * without a clock, and a tray where nothing it arrived with is left.
 */
import { describe, expect, it } from "vitest";
import type { TrayReport, TrayStoneEvidence } from "pdigger-factory-sdk";
import {
  CONFIDENCE,
  MOVED,
  MOVED_CONFIDENCE,
  Tray,
  TrayChange,
  TrayFact,
  TrayStone,
  iso,
  trayReport,
  type TrayFactInit,
} from "pdigger-factory-sdk";

const at = (t: number, wall: number | null = null) => ({ g: Math.round(t * 5), t, wall });
const fact = (init: Partial<TrayFactInit> & Pick<TrayFactInit, "kind">): TrayFact =>
  new TrayFact({
    tray: 1,
    session: 7,
    video: "v",
    stone: null,
    worldId: null,
    certain: null,
    why: null,
    g: 10,
    t: 2,
    wall: null,
    stones: null,
    sure: null,
    added: null,
    removed: null,
    unclear: null,
    ...init,
  });
const stone = (
  id: string,
  place: [number, number],
  first: [number, number],
  more: Partial<ConstructorParameters<typeof TrayStone>[0]> = {},
): TrayStone =>
  new TrayStone({
    id,
    worldId: 1,
    status: "on",
    sure: true,
    added: false,
    certain: null,
    born: at(1),
    place,
    size: [0.4, 0.2],
    firstPlace: first,
    leftPlace: place, // seen at the leaving point
    ...more,
  });

describe("tray reports", () => {
  it("has none for a tray that never arrived, is still on, or whose facts do not end in its leaving", () => {
    const base = { session: 7, video: "v", n: 1, stones: [], facts: [] };
    expect(new Tray({ ...base, arrived: null, leaving: null }).report()).toBeNull();
    expect(new Tray({ ...base, arrived: at(1), leaving: null }).report()).toBeNull();
    expect(new Tray({ ...base, arrived: at(1), leaving: at(9) }).report()).toBeNull();
    const facts = [fact({ kind: "arrived", stones: 0 })];
    expect(trayReport(new Tray({ ...base, arrived: at(1), leaving: at(9), facts }))).toBeNull();
  });

  it("reads a tray without a clock, with every count the facts leave out, and nothing it arrived with left", () => {
    const gone = stone("s1t1.0-1-4", [0, 0], [0, 0], { status: "removed", certain: true, worldId: null });
    const facts = [
      fact({ kind: "arrived", g: 5, t: 1 }), // no stone count
      fact({ kind: "removed", stone: gone.id, certain: true, code: "carried_away", t: 4 }),
      fact({ kind: "leaving", t: 9, stones: 0, sure: 0 }), // no unclear count
    ];
    const r = new Tray({
      session: 7,
      video: "v",
      n: 1,
      arrived: at(1),
      leaving: at(9),
      stones: [gone],
      facts,
    }).report() as TrayReport;
    expect(r).toMatchObject({ stones: 0, unclear: 0, unsure: 0, complete: true, moved: [], added: [] });
    // a stone made without its evidence (no leaving answer): a certain removal, undecided (4.6.13)
    expect(r.describe()).toBe(
      "tray 1, 0:01.0 to 0:09.0: 1 removed, 0 added, 0 moved\n  0:04.0 removed s1t1.0-1-4 from (0.00, 0.00) (0.50)",
    );
    expect(JSON.parse(JSON.stringify(r))).toMatchObject({
      tray: 1,
      arrived: { t: 1, wall: null },
      removed: [
        {
          kind: "removed",
          stone: gone.id,
          at: { t: 4 },
          certain: true,
          code: "carried_away",
          place: [0, 0],
          size: [0.4, 0.2],
          distance: null,
          confidence: 0.5,
        },
      ],
      complete: true,
    });
  });

  it("gives each change its confidence: by its kind, certainty and the stone's evidence, a move 0.87", () => {
    const facts = [
      fact({ kind: "arrived", g: 5, t: 1, stones: 2 }),
      fact({ kind: "removed", stone: "r", certain: true, code: "carried_away", t: 4 }),
      fact({ kind: "removed", stone: "u", certain: false, code: "not_found", t: 9 }),
      fact({ kind: "added", stone: "a", certain: false, code: "not_recognised", t: 9 }),
      fact({ kind: "leaving", t: 9, stones: 1, sure: 0, unclear: 2 }),
    ];
    const report = (r: TrayStoneEvidence, u: TrayStoneEvidence, a: TrayStoneEvidence): TrayReport =>
      new Tray({
        session: 7,
        video: "v",
        n: 1,
        arrived: at(1),
        leaving: at(9),
        stones: [
          stone("r", [0, 0], [0, 0], { status: "removed", certain: true, worldId: null, evidence: r }),
          stone("u", [1, 0], [1, 0], { status: "removed", certain: false, worldId: null, evidence: u }),
          stone("a", [2, 0], [2, 0], { added: true, certain: false, sure: false, evidence: a }),
        ],
        facts,
      }).report() as TrayReport;
    const conf = (x: TrayReport): number[] => [...x.removed, ...x.added].map((c) => c.confidence);
    expect(conf(report("not_found", "not_found", "not_found"))).toEqual([0.98, 0.71, 0.96]);
    expect(conf(report("undecided", "undecided", "undecided"))).toEqual([0.5, 0.58, 0.52]);
    expect(conf(report("found", "found", "found"))).toEqual([0.25, 0.09, 0.02]);
    expect(report("found", "not_found", "undecided").describe()).toBe(
      "tray 1, 0:01.0 to 0:09.0: 2 removed, 1 added, 0 moved, not complete: 2 unclear\n" +
        "  0:04.0 removed r from (0.00, 0.00) (0.25)\n" +
        "  0:09.0 removed u from (1.00, 0.00) (unclear, 0.71)\n" +
        "  0:09.0 added a at (2.00, 0.00) (unclear, 0.52)",
    );
    // the table, the same in every SDK (4.6.13): a certain addition takes the unclear additions' numbers
    expect(CONFIDENCE).toEqual({
      removed: {
        certain: { not_found: 0.98, undecided: 0.5, found: 0.25 },
        unclear: { not_found: 0.71, undecided: 0.58, found: 0.09 },
      },
      added: {
        certain: { not_found: 0.96, undecided: 0.52, found: 0.02 },
        unclear: { not_found: 0.96, undecided: 0.52, found: 0.02 },
      },
    });
    expect(Object.isFrozen(CONFIDENCE.removed.certain)).toBe(true);
    expect(MOVED_CONFIDENCE).toBe(0.87);
  });

  it("takes the tray's own shift out before it calls a stone moved, by the median of the half that moved least", () => {
    // stones the tray carried 0.1 along y as it left, one of them pushed 0.3 along x besides; d is not sure, so it is
    // counted as not sure and not as moved however far its place is
    const kept = [
      stone("a", [0, 0.1], [0, 0]),
      stone("b", [1, 0.1], [1, 0]),
      stone("c", [2.3, 0.1], [2, 0], { touched: 40 }),
      stone("d", [3.9, 0.1], [3, 0], { sure: false, touched: 41 }),
      stone("e", [4, 0.1], [4, 0]),
    ];
    const facts = [
      fact({ kind: "arrived", stones: 5, wall: 1794960000.25 }),
      fact({ kind: "leaving", t: 9, stones: 5, sure: 4, unclear: 0 }),
    ];
    const tray = (stones: TrayStone[]) =>
      new Tray({ session: 7, video: "v", n: 2, arrived: at(1), leaving: at(9), stones, facts }).report() as TrayReport;
    const r = tray(kept);
    expect(r.moved.map((c) => [c.stone, c.distance, c.certain, c.place])).toEqual([["c", 0.3, true, [2.3, 0.1]]]);
    expect(r.moved[0]?.confidence).toBe(MOVED_CONFIDENCE);
    expect(r).toMatchObject({ unsure: 1, complete: false });
    expect(r.describe()).toBe(
      "tray 2 (2026-11-18T00:00:00.3Z), 0:02.0 to 0:09.0: 0 removed, 0 added, 1 moved, not complete: 1 not sure\n" +
        "  moved c 0.30 to (2.30, 0.10) (0.87)",
    );
    expect(MOVED).toBe(0.75);
    // the median of an odd half: one of two sure stones, three of five
    expect(tray([kept[0], kept[2]] as TrayStone[]).moved.map((c) => c.stone)).toEqual(["c"]);
    const five = [...kept.slice(0, 3), stone("f", [5, 0.1], [5, 0]), stone("g", [6, 0.1], [6, 0])];
    expect(tray(five).moved.map((c) => c.stone)).toEqual(["c"]);
    // nothing sure: nothing moved
    expect(tray([kept[3]] as TrayStone[]).moved).toEqual([]);
    // the same place, but nothing touched it: an outline the world refined is not a move
    const still = stone("c", [2.3, 0.1], [2, 0]);
    expect(tray([kept[0], kept[1], still] as TrayStone[]).moved).toEqual([]);
    // not seen at the leaving point: its place there is not known, and it is left out of the shift as well
    const unseen = stone("c", [2.3, 0.1], [2, 0], { touched: 40, leftPlace: null });
    expect(tray([kept[0], kept[1], unseen] as TrayStone[]).moved).toEqual([]);
    expect(unseen.toJSON()).toMatchObject({ left_place: null, touched: 40 });
  });

  it("gives an addition its final place: as the tray left, else where it was last seen", () => {
    const facts = [
      fact({ kind: "arrived", g: 5, t: 1, stones: 0 }),
      fact({ kind: "added", stone: "s1t1.0-1-5", certain: false, code: "not_recognised", t: 6 }),
      fact({ kind: "leaving", t: 9, stones: 1, sure: 0, unclear: 1 }),
    ];
    const report = (leftPlace: [number, number] | null) =>
      new Tray({
        session: 7,
        video: "v",
        n: 1,
        arrived: at(1),
        leaving: at(9),
        stones: [
          stone("s1t1.0-1-5", [2, -0.001], [2, -0.001], { added: true, certain: false, sure: false, leftPlace }),
        ],
        facts,
      }).report() as TrayReport;
    const seen = report([1.5, -0.004]);
    expect(seen.added[0]?.place).toEqual([1.5, -0.004]);
    expect(seen.describe()).toBe(
      "tray 1, 0:01.0 to 0:09.0: 0 removed, 1 added, 0 moved, not complete: 1 unclear\n" +
        "  0:06.0 added s1t1.0-1-5 at (1.50, 0.00) (unclear, 0.52)",
    );
    expect(report(null).added[0]?.describe()).toBe("0:06.0 added s1t1.0-1-5 at (2.00, 0.00) (unclear, 0.52)");
  });

  it("describes a change without its point, distance or confidence, and a stone made without a first place", () => {
    expect(new TrayChange("removed", "x", null, false, null, [0, 0], [1, 1]).describe()).toBe(
      "removed x from (0.00, 0.00) (unclear, 0.00)",
    );
    expect(new TrayChange("moved", "y", null, true, null, [0, 0], [1, 1]).describe()).toBe(
      "moved y 0.00 to (0.00, 0.00) (0.00)",
    );
    // a coordinate that rounds to zero prints without its sign
    expect(new TrayChange("removed", "x", null, true, null, [-1.236, -0.0049], [1, 1], null, 0.98).describe()).toBe(
      "removed x from (-1.24, 0.00) (0.98)",
    );
    const s = new TrayStone({
      id: "z",
      worldId: null,
      status: "on",
      sure: true,
      added: false,
      certain: null,
      born: at(1),
      place: [1, 2],
      size: [1, 1],
    });
    expect(s.firstPlace).toEqual([0, 0]);
    expect(s.toJSON()).toMatchObject({ first_place: [0, 0], left_place: null, touched: null });
    expect([s.bySpeckle, s.evidence]).toEqual([false, null]); // made while its tray is on: no evidence yet (4.6.13)
    expect(new TrayStone({ ...s, bySpeckle: true, evidence: "found" }).toJSON()).toMatchObject({
      by_speckle: true,
      evidence: "found",
    });
    expect(new TrayStone({ ...s, leftPlace: [1, 2] }).toJSON()).toMatchObject({ left_place: [1, 2] });
    expect(iso(1794960000.04)).toBe("2026-11-18T00:00:00.0Z");
  });
});
