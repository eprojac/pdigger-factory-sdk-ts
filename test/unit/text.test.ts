import { describe, expect, it } from "vitest";
import {
  DELETE_REASONS,
  FactoryEvent,
  Move,
  PushBurst,
  Summary,
  clock,
  describeActivity,
  describeEvent,
  eventSentence,
  fmt,
  handWord,
  joinIds,
  round3,
  verb,
  type EventText,
} from "pdigger-factory-sdk";
import { readJson } from "../helpers/fixtures.js";

const ev = (type: string, extra: Partial<EventText> = {}): EventText => ({
  type,
  t: 0,
  stoneId: 7,
  hand: null,
  why: null,
  into: null,
  source: null,
  ...extra,
});

describe("numbers (section 4.5)", () => {
  it("fmt rounds half up and keeps leading zeros", () => {
    expect(fmt(0.05, 1)).toBe("0.1");
    expect(fmt(0.25, 1)).toBe("0.3");
    expect(fmt(1.005, 2)).toBe("1.00");
    expect(fmt(0.004, 2)).toBe("0.00");
    expect(fmt(12.345, 0)).toBe("12");
    expect(fmt(-1.25, 1)).toBe("-1.3");
    expect(fmt(3, 3)).toBe("3.000");
  });
  it("round3", () => {
    expect(round3(1.2345)).toBe(1.235);
    expect(round3(0.0004)).toBe(0);
  });
  it("clock below and above one hour, with Python floor semantics", () => {
    expect(clock(0)).toBe("0:00.0");
    expect(clock(79.24)).toBe("1:19.2");
    expect(clock(59.96)).toBe("1:00.0");
    expect(clock(3600)).toBe("1:00:00.0");
    expect(clock(3725.55)).toBe("1:02:05.6");
    expect(clock(-0.5)).toBe("-1:59:59.5");
  });
});

describe("words", () => {
  it("hands and verbs", () => {
    expect(handWord("left")).toBe("Left hand");
    expect(handWord("right")).toBe("Right hand");
    expect(handWord("both")).toBe("Both hands");
    expect(handWord(null)).toBe("A hand");
    expect(handWord("toString")).toBe("A hand");
    expect(verb("both", "pushes")).toBe("push");
    expect(verb("left", "pushes")).toBe("pushes");
    expect(verb("both", "is")).toBe("are");
  });
  it("joins ids", () => {
    expect(joinIds([])).toBe("");
    expect(joinIds([1])).toBe("1");
    expect(joinIds([1, 2])).toBe("1 and 2");
    expect(joinIds([1, 2, 3])).toBe("1, 2 and 3");
  });
  it("has the delete reasons", () => {
    expect(DELETE_REASONS.overlap).toBe("overlapped another stone");
  });
});

describe("event sentences (section 4.1)", () => {
  const cases: [EventText, string][] = [
    [ev("new"), "stone 7 appears"],
    [ev("new", { source: "image" }), "stone 7 appears (found in the image)"],
    [ev("confirm"), "stone 7 is confirmed"],
    [ev("freeze"), "stone 7 gets its final shape"],
    [ev("push", { why: "course" }), "stone 7 is pushed along its row"],
    [ev("push", { why: "reseat" }), "stone 7 is reseated"],
    [ev("push", { hand: "left" }), "Left hand pushes stone 7"],
    [ev("push", { hand: "both" }), "Both hands push stone 7"],
    [ev("push"), "stone 7 is pushed"],
    [ev("push", { why: "neighbour" }), "stone 7 is pushed (neighbour)"],
    [ev("lift", { hand: "right" }), "Right hand lifts stone 7"],
    [ev("hinge", { hand: "both" }), "Both hands tip stone 7 up on its edge"],
    [ev("carry", { hand: "left" }), "Left hand carries stone 7"],
    [ev("place", { hand: "both" }), "Both hands place stone 7"],
    [ev("drop"), "A hand drops stone 7"],
    [ev("gone", { hand: "right" }), "Right hand takes stone 7 out of view"],
    [ev("delete"), "stone 7 is removed"],
    [ev("delete", { why: "hand" }), "stone 7 is removed (a hand emptied its place)"],
    [ev("delete", { why: "weird" }), "stone 7 is removed (weird)"],
    [ev("split"), "stone 7 splits"],
    [ev("split", { into: [] }), "stone 7 splits"],
    [ev("split", { into: [7] }), "stone 7 is trimmed"],
    [ev("split", { into: [7, 9] }), "stone 7 splits into 7 and 9"],
    [ev("teleport", { stoneId: null }), "stone ?: teleport"],
  ];
  for (const [e, text] of cases) {
    it(`${e.type} ${e.hand ?? ""} ${e.why ?? ""}`, () => expect(eventSentence(e)).toBe(text));
  }
  it("describes with the clock", () => {
    expect(describeEvent(ev("lift", { t: 79.24, hand: "left" }))).toBe("1:19.2 Left hand lifts stone 7");
  });
});

describe("activity sentences (section 4.2)", () => {
  const base = { start: { t: 10 }, end: { t: 11.04 }, duration: 1.04 };
  it("moves", () => {
    const m = (extra: object): string =>
      describeActivity({ kind: "move", hand: "left", stoneId: 5, ...base, ...extra });
    expect(m({ outcome: "placed", carried: true, distance: 0.1234 })).toBe(
      "0:10.0 Left hand moves stone 5 0.12 units in 1.0 s",
    );
    expect(m({ outcome: "placed", carried: true, distance: null })).toBe("0:10.0 Left hand moves stone 5 in 1.0 s");
    expect(m({ outcome: "placed", tipped: true })).toBe("0:10.0 Left hand tips stone 5 and sets it down (1.0 s)");
    expect(m({ outcome: "placed" })).toBe("0:10.0 Left hand lifts stone 5 and sets it down (1.0 s)");
    expect(m({ outcome: "dropped" })).toBe("0:10.0 Left hand drops stone 5 after 1.0 s");
    expect(m({ outcome: "carried_away" })).toBe("0:10.0 Left hand takes stone 5 away (1.0 s)");
    expect(m({ outcome: "removed" })).toBe("0:10.0 Left hand lifts stone 5; it is removed after 1.0 s");
    expect(m({ outcome: "interrupted" })).toBe("0:10.0 Left hand is still holding stone 5 (1.0 s so far)");
    expect(m({ outcome: "carried_away", partial: true })).toBe(
      "0:11.0 Left hand takes stone 5 away (1.0 s) (joined mid-move)",
    );
    expect(describeActivity({ kind: "move", hand: "both", stoneId: null, ...base, outcome: null })).toBe(
      "0:10.0 Both hands are still holding stone ? (1.0 s so far)",
    );
  });
  it("push bursts", () => {
    const p = (stones: number[], pushes: number): string =>
      describeActivity({ kind: "push", hand: "both", ...base, stones, pushes });
    expect(p([], 1)).toBe("0:10.0 Both hands push stone ? (1 push)");
    expect(p([4], 2)).toBe("0:10.0 Both hands push stone 4 (2 pushes in 1.0 s)");
    expect(p([1, 2, 3, 4, 5, 6], 6)).toBe("0:10.0 Both hands push stones 1, 2, 3, 4, 5 and 6 (6 pushes in 1.0 s)");
    expect(p([1, 2, 3, 4, 5, 6, 7, 8], 9)).toBe(
      "0:10.0 Both hands push stones 1, 2, 3, 4, 5, 6 and 2 more (9 pushes in 1.0 s)",
    );
    expect(describeActivity({ kind: "push", hand: "right", ...base })).toBe(
      "0:10.0 Right hand pushes stone ? (0 pushes in 1.0 s)",
    );
  });
});

describe("typed events and activities", () => {
  const start = { g: 50, t: 10, wall: null };
  it("FactoryEvent", () => {
    const e = new FactoryEvent({
      type: "lift",
      g: 50,
      t: 10,
      wall: 1.5,
      session: 3,
      video: "dry1",
      stoneId: 9,
      hand: "left",
      why: null,
      into: null,
      source: null,
      stone: null,
    });
    expect(e.describe()).toBe("0:10.0 Left hand lifts stone 9");
    expect(e.clock).toBe("0:10.0");
    expect(e.toJSON()).toEqual({
      type: "lift",
      g: 50,
      t: 10,
      wall: 1.5,
      session: 3,
      video: "dry1",
      stone_id: 9,
      hand: "left",
      why: null,
      into: null,
      source: null,
      tray_stone: null, // the init leaves it out: the stone stood for no tray stone
    });
  });
  it("Move open and closed", () => {
    const m = new Move({
      stoneId: 3,
      hand: "right",
      start,
      from: [0, 0, 0],
      tipped: false,
      partial: false,
      session: 1,
      video: "v",
    });
    expect(m.describe()).toBe("0:10.0 Right hand is still holding stone 3 (0.0 s so far)");
    m.outcome = "placed";
    m.end = { g: 60, t: 12, wall: null };
    m.duration = 2;
    expect(m.describe()).toBe("0:10.0 Right hand lifts stone 3 and sets it down (2.0 s)");
    expect(m.toJSON()).toMatchObject({ kind: "move", stone_id: 3, outcome: "placed", duration: 2, end: m.end });
  });
  it("PushBurst open and closed", () => {
    const b = new PushBurst({ hand: "left", start, session: 1, video: "v" });
    b.stones.push(4);
    b.pushes = 2;
    b.last = { g: 52, t: 10.4, wall: null };
    expect(b.describe()).toBe("0:10.0 Left hand pushes stone 4 (2 pushes in 0.4 s)");
    b.end = b.last;
    b.duration = 0.4;
    expect(b.describe()).toBe("0:10.0 Left hand pushes stone 4 (2 pushes in 0.4 s)");
    expect(b.toJSON()).toMatchObject({ kind: "push", hand: "left", stones: [4], pushes: 2, duration: 0.4 });
  });
});

describe("Summary", () => {
  it("round-trips a golden summary", () => {
    const json = readJson<ReturnType<Summary["toJSON"]>>("golden/dry1-0000-0130.summary.json");
    const s = Summary.fromJSON(json);
    expect(s.toJSON()).toEqual(json);
    expect(s.describe().split("\n")).toHaveLength(10); // nine lines, each ending with a newline
  });
  it("prints dashes for unknown values", () => {
    const json = readJson<ReturnType<Summary["toJSON"]>>("golden/dry1-0000-0130.summary.json");
    const s = new Summary({
      ...json,
      stones: { last: null, max: 0, confirmed_last: null },
      moves: { ...json.moves, mean_duration: null, mean_distance: null },
    });
    const text = s.describe();
    expect(text).toContain("stones: last -, max 0, confirmed -");
    expect(text).toContain("mean - s, - units");
  });
});
