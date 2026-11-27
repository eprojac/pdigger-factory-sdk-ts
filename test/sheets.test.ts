import { describe, expect, it } from "vitest";
import {
  Summary,
  InterpreterCore,
  Replay,
  Tray,
  TrayFact,
  TrayReport,
  TrayStone,
  FactoryEvent,
  describeTrayFact,
  eventSentence,
  type Frame,
  type StoneView,
} from "pdigger-factory-sdk";
import { eventKey } from "../src/interpreter/core.js";
import { readBytes } from "./helpers/fixtures.js";

const fixture = (name: string) => Replay.fromBytes(readBytes(`recordings/${name}.ndjson.gz`));
const paper = "trays-sheet-synthetic";
const partial = "trays-sheet-partial-synthetic";

describe("paper covering a tray", () => {
  it("keeps action membership across revisions and preserves the transmitted order", () => {
    const ids = [9, 3, 9];
    expect(eventKey({ type: "sheet", why: "laid", ids })).toBe(eventKey({ type: "sheet", why: "laid", ids: [3, 9] }));
    expect(eventKey({ type: "sheet", why: "lifted", ids })).not.toBe(eventKey({ type: "sheet", why: "laid", ids }));
    expect(eventKey({ type: "sheet" })).toBe(eventKey({ type: "sheet", ids: [] }));
    expect(ids).toEqual([9, 3, 9]);
    const e = [...fixture(paper).eventsSync()].find((e) => e.type === "sheet")!;
    expect(e.toJSON().ids).toEqual(e.ids);
    expect(eventSentence({ ...e, why: null, ids: null })).toBe("a sheet event");
    expect(eventSentence({ ...e, why: "rolled", ids: null })).toBe("a sheet event (rolled)");
    expect(eventSentence({ ...e, why: "lifted", ids: null })).toBe("a sheet is lifted");
    expect(eventSentence({ ...e, why: "laid", ids: [1, 2, 3, 4, 5, 6, 7] })).toBe(
      "a sheet is laid over stones 1, 2, 3, 4, 5, 6 and 1 more",
    );
    expect(new FactoryEvent({ ...e, ids: null }).toJSON()).not.toHaveProperty("ids");
  });
  it("records the stone IDs, timestamps and a clear sight through the normal replay path", () => {
    const [tray] = fixture(paper).traysSync();
    const r = tray!.report()!;
    expect(r.toJSON()).toMatchObject({
      sheets: r.sheets,
      under_sheet: r.underSheet,
      sheet_facts: r.sheetFacts.map((f) => f.toJSON()),
    });
    expect(tray!.stones.find((s) => s.underSheet)!.toJSON()).toMatchObject({
      under_sheet: true,
      sheet_since: expect.anything(),
    });
    const core = new InterpreterCore();
    for (const f of fixture(paper).framesSync()) {
      if (f.g === 17 || f.g === 18)
        Object.assign(
          f.world!.stones.find((s) => s.id === 1)!,
          { under_sheet: false, mode: "seen", detected: true },
        );
      core.feed(f);
    }
    core.end();
    expect(
      core
        .trays()[0]!
        .facts.filter((f) => f.kind === "sheet")
        .map((f) => [f.g, f.code]),
    ).toEqual([
      [14, "sheet_laid"],
      [17, "sheet_lifted"],
      [19, "sheet_laid"],
      [20, "sheet_laid"],
    ]);
  });
  it("checks the order, size and membership of paper facts and its departure count", () => {
    const first = fixture(paper).traysSync()[0]!;
    const [arrived, laid, again, left] = first.facts as readonly [TrayFact, TrayFact, TrayFact, TrayFact];
    const check = (facts: TrayFact[]) => new Tray({ ...first, facts }).check();
    for (const fields of [
      { stones: 3 },
      { trayStones: [] },
      { trayStones: [...laid.trayStones].reverse() },
      { g: arrived.g - 1 },
      { trayStones: ["unknown"] },
      { code: "sheet_lifted" },
      { code: "rolled" },
    ]) {
      expect(check([arrived, new TrayFact({ ...laid, ...fields }), again, left])).toContain("C10");
    }
    expect(check([arrived, laid, laid, again, left])).toContain("C10");
    expect(check([arrived, laid, again, new TrayFact({ ...left, underSheet: 0 })])).toContain("C11");
    const partially = fixture(partial).traysSync()[0]!;
    expect(partially.check()).toEqual([]);
    const unresolved = partially.stones.find((s) => s.worldId === null)!;
    expect(
      new Tray({
        ...partially,
        stones: partially.stones.map((s) => (s === unresolved ? new TrayStone({ ...s, underSheet: true }) : s)),
      }).check(),
    ).toContain("C6");
    expect(describeTrayFact({ ...laid, trayStones: undefined })).toContain("stone ?");
  });
  it("uses two directly observed faces in a native rectangle to keep the same board", () => {
    function end(bounded: boolean, condition = "") {
      const core = new InterpreterCore(bounded ? { trayBounds: [0, 0, 1920, 1080] } : {});
      for (const f of fixture(partial).framesSync()) {
        if (f.g > 31) break;
        if (f.g === 19 && condition === "gap") continue;
        for (const s of f.world!.stones.filter((s) => s.id === 3 || s.id === 4)) {
          Object.assign(s, { under_sheet: false, detected: true, mode: "seen" });
          if (f.g === 20 && s.id === 4 && condition === "missing") Object.assign(s, { mode: "kept", detected: false });
          if (f.g === 20 && s.id === 4 && condition === "moved") s.solid.pos[0] += 0.4;
        }
        if (f.g === 14) f.world!.events[0]!.ids = [1, 2];
        core.feed(f);
      }
      core.end();
      return core.trays()[0]!.leaving!.g;
    }
    expect(end(true)).toBeGreaterThan(26);
    for (const why of ["missing", "moved", "gap"]) expect(end(true, why)).toBe(20);
    expect(end(false)).toBe(20);
    for (const r of [[0, 0, 0, 1], [0, 3, 8, 1], [NaN, 0, 1, 2], [0]]) {
      expect(() => new InterpreterCore({ trayBounds: r as [number, number, number, number] })).toThrow(RangeError);
    }
  });
  it("allows retirement outside the native rectangle only with two continuing direct observations", () => {
    const inside: StoneView["outline"] = [
      [1, 1],
      [5, 1],
      [5, 5],
    ];
    const outside: StoneView["outline"] = [
      [110, 1],
      [115, 1],
      [115, 5],
    ];
    function arrival(condition: string, change?: (f: Frame, old: StoneView) => void) {
      const core = new InterpreterCore({ trayBounds: [0, 0, 100, 100] });
      for (const f of fixture("trays-synthetic").framesSync()) {
        if (f.g > 12) break;
        const w = f.world!;
        const a = w.stones[0]!,
          b = w.stones[1]!;
        const old = { ...a, id: 99, detected: false, mode: "kept" as const, outline: outside };
        w.stones = condition === "one" ? [a] : [a, b];
        for (const s of w.stones) Object.assign(s, { outline: inside, detected: true, mode: "seen" });
        if (f.g < 4) w.stones.push(old);
        w.events = f.g === 4 ? [{ type: "delete", id: 99, why: "stranded" }] : [];
        change?.(f, old);
        w.stats.stones = w.stats.confirmed = w.stones.length;
        core.feed(f);
      }
      core.end();
      return core.trays()[0]!.arrived!.g;
    }
    expect(arrival("")).toBe(4);
    expect(arrival("one")).toBe(7);
    expect(
      arrival("", (_f, o) => {
        o.outline = inside;
      }),
    ).toBe(7);
    expect(
      arrival("", (_f, o) => {
        o.outline = [];
      }),
    ).toBe(7);
    expect(
      arrival("", (_f, o) => {
        o.outline = [
          [NaN, 1],
          [120, 0],
          [120, 10],
        ];
      }),
    ).toBe(7);
    expect(
      arrival("", (_f, o) => {
        o.under_sheet = true;
      }),
    ).toBe(7);
    expect(
      arrival("", (_f, o) => {
        o.detected = true;
      }),
    ).toBe(7);
    expect(
      arrival("", (f) => {
        if (f.g === 4) f.world!.events = [{ type: "delete", id: 199, why: "outside" }];
      }),
    ).toBe(7);
    expect(
      arrival("", (f) => {
        if (f.g === 4) f.world!.events = [{ type: "delete", why: "outside" }];
      }),
    ).toBe(7);
    expect(
      arrival("", (f) => {
        if (f.g === 4) f.world!.events = [{ type: "delete", id: 99, why: "sheet" }];
      }),
    ).toBe(7);
    expect(
      arrival("", (f) => {
        if (f.g === 4) f.world!.events.push({ type: "confirm", id: 1 });
      }),
    ).toBe(4);
  });
});

it("accepts a report created before sheets were recorded", () => {
  const current = fixture("trays-sheet-synthetic-nosheet").traysSync()[0]!.report()!;
  const old = new TrayReport({ ...current, sheets: undefined, underSheet: undefined, sheetFacts: undefined });
  expect(old.sheets).toBe(0);
  expect(old.underSheet).toEqual([]);
  expect(old.sheetFacts).toEqual([]);
  expect(old.toJSON()).toEqual(current.toJSON());
});

it("normalizes partial sheet counts saved by external consumers", () => {
  const old = new InterpreterCore().summary().toJSON();
  const base = { ...old, trays: { ...old.trays, under_sheet: 2 } };
  expect(Summary.fromJSON(base).toJSON().trays).toMatchObject({ sheets: 0, under_sheet: 2 });
  expect(Summary.fromJSON({ ...old, trays: { ...old.trays, sheets: 3 } }).toJSON().trays).toMatchObject({
    sheets: 3,
    under_sheet: 0,
  });
});

it("retains ordinary tray state on a paper retirement of an unknown track", () => {
  const core = new InterpreterCore();
  for (const f of fixture(paper).framesSync()) {
    if (f.g > 18) break;
    if (f.g === 17)
      f.world!.events = [
        { type: "sheet", why: "lifted" },
        { type: "delete", id: 999, why: "sheet" },
      ];
    core.feed(f);
  }
  expect(core.trays()[0]!.leaving).toBeNull();
  core.end();
  const first = core.trays()[0]!;
  const left = first.facts.at(-1)!;
  expect(left.toJSON().under_sheet).toBeGreaterThan(0);
  expect(left.toJSON()).not.toHaveProperty("tray_stones");
  expect(
    new Tray({ ...first, facts: [...first.facts.slice(0, -1), new TrayFact({ ...left, stones: null })] }).check(),
  ).toContain("C11");
  const visible = first.stones.find((s) => !s.underSheet)!;
  expect(visible.toJSON()).not.toHaveProperty("sheet_since");
});
