/**
 * Trays and tray stones (SDK-DESIGN.md section 4.6) beyond the golden files: the values, ids without a clock, the live
 * streams, the state, the events' tray stones and the trays the core keeps. The rules themselves are golden-tested over
 * every recording, `trays-synthetic` among them (the rules the real excerpts never reach).
 */
import { describe, expect, it } from "vitest";
import {
  InterpreterCore,
  Replay,
  Summary,
  TrayFact,
  describeTrayFact,
  Tray,
  type Frame,
  type StoneView,
  type TrayFactInit,
} from "pdigger-factory-sdk";
import { stamp, uniqueId } from "../../src/interpreter/trays.js";
import { all, clientOf, fixtureFake } from "../helpers/fake.js";
import { readBytes, readText, recordingPath } from "../helpers/fixtures.js";
import { mkFrame, stone } from "../helpers/frames.js";

const SYNTH = "trays-synthetic";
const golden = (): string => readText(`golden/${SYNTH}.trays.txt`);
const text = (facts: Iterable<TrayFact>): string => [...facts].map((f) => `${f.describe()}\n`).join("");
const numbers = (trays: readonly Tray[]): number[] => trays.map((t) => t.n);
const frames = (): Frame[] => [...Replay.fromBytes(readBytes(`recordings/${SYNTH}.ndjson.gz`)).framesSync()];

/** A core with the recording's clock state (wall = 1794960000 + t). */
function clocked(options: ConstructorParameters<typeof InterpreterCore>[0] = {}): InterpreterCore {
  const core = new InterpreterCore(options);
  core.setClock({
    session: 1794684199,
    revision: 1,
    playing: true,
    rate: 1,
    anchor_media: 0,
    anchor_wall: 1794960000,
    hold_until: 1794960000,
  });
  return core;
}

describe("trays", () => {
  it("a tray as values", async () => {
    const trays = await (await Replay.open(recordingPath(SYNTH))).trays();
    expect(numbers(trays)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const first = trays[0] as Tray;
    expect(first.window()).toEqual([0.8, 5.2]);
    const never = trays[3] as Tray; // a stop that never settled
    expect([never.window(), never.arrived, never.leaving, never.stones.length]).toEqual([null, null, null, 0]);
    const d = JSON.parse(JSON.stringify(first)) as Record<string, unknown> & {
      stones: unknown[];
      facts: unknown[];
      leaving: { g: number };
    };
    expect([d.session, d.video, d.n]).toEqual([1794684199, "dry1", 1]);
    expect(d.arrived).toEqual({ g: 4, t: 0.8, wall: 1794960000.8 });
    expect(d.leaving.g).toBe(26);
    expect(d.stones[1]).toEqual({
      id: "20261118T000000.8Z-1-2",
      world_id: null,
      status: "removed",
      sure: true,
      added: false,
      certain: true,
      born: { g: 4, t: 0.8, wall: 1794960000.8 },
      place: [0, 0],
      size: [0.3, 0.2],
      question: null,
      looks: [],
      by_look: false,
      look_lost: false,
      open: null,
      first_place: [0, 0],
      left_place: null, // removed: not on the tray when it left
      touched: 13, // the frame a hand last touched it (it carried it away)
      speckle: null, // no speckle answer for it (4.6.12)
      by_speckle: false, // no leaving answer linked or confirmed it (4.6.13)
      evidence: "undecided", // no leaving answer: undecided (4.6.13)
    });
    expect(d.stones[0]).toMatchObject({ left_place: [-0.6, 0], touched: null }); // seen in the leaving frame, never touched
    expect(d.facts[1]).toEqual({
      kind: "removed",
      tray: 1,
      session: 1794684199,
      video: "dry1",
      stone: "20261118T000000.8Z-1-2",
      world_id: null,
      certain: true,
      why: "carried away",
      code: "carried_away",
      g: 22,
      t: 4.4,
      wall: 1794960004.4,
      stones: null,
      sure: null,
      added: null,
      removed: null,
      unclear: null,
      opened: null,
      from_world: null,
      score: null,
      margin: null,
      bar: null,
      t_id: null,
      open: null,
    });
    const added = first.stone("20261118T000003.8Z-1-7");
    expect([added?.added, added?.certain, added?.status]).toEqual([true, true, "on"]);
    expect(first.stone("no such stone")).toBeNull();
    const leaving = first.facts.at(-1) as TrayFact;
    expect([leaving.kind, leaving.clock]).toEqual(["leaving", "0:05.2"]);
    expect([leaving.stones, leaving.sure, leaving.added, leaving.removed, leaving.unclear]).toEqual([3, 3, 1, 1, 0]);
  });

  it("a relinked stone keeps its id: the world renames 12 to 17, the tray stone stands for 17, still sure", () => {
    const tray = Replay.fromBytes(readBytes(`recordings/${SYNTH}.ndjson.gz`)).traysSync()[1] as Tray;
    const s = tray.stone("20261118T000006.4Z-2-12");
    expect([s?.worldId, s?.status, s?.sure]).toEqual([17, "on", true]);
    const found = tray.facts.find((f) => f.why === "found again, not for sure");
    expect([found?.stone, found?.worldId]).toEqual(["20261118T000006.4Z-2-13", 18]);
  });

  it("names the session in ids without a clock: they stay unique after a seek back and in another session", () => {
    const core = new InterpreterCore(); // no clock state
    const facts: TrayFact[] = [];
    for (const f of frames()) facts.push(...core.feed(f).trayFacts);
    facts.push(...core.end().trayFacts);
    const lines = text(facts).split("\n");
    expect(lines[1]).toBe("0:04.4 tray 1: stone s1794684199t0.8-1-2 was removed (carried away)");
    expect(lines[2]).toBe("0:05.2 tray 1: stone s1794684199t3.8-1-7 was set down");
    expect(facts.every((f) => f.wall === null)).toBe(true);
  });

  it("stamps the UTC time to the tenth, or the session and the media time", () => {
    const stamps: [number, string][] = [
      [1794960000.84, "20261118T000000.8Z"],
      [1767225600, "20260101T000000.0Z"],
      [1772323199.96, "20260301T000000.0Z"],
      [-0.04, "19700101T000000.0Z"],
      [-0.06, "19691231T235959.9Z"],
    ];
    for (const [wall, want] of stamps) expect(stamp(wall, 0, 1), String(wall)).toBe(want);
    expect(stamp(null, 22.5, 1795314878)).toBe("s1795314878t22.5");
    expect(stamp(null, 1, null)).toBe("s0t1.0"); // frames without a session
  });

  it("gives no id twice on a tray: -2, then -3", () => {
    // a second stone first seen under one world id in one tenth of a second takes -2, a third -3 (4.6)
    expect(uniqueId([], "s7t1.0-1-7")).toBe("s7t1.0-1-7");
    expect(uniqueId([{ id: "s7t1.0-1-7" }], "s7t1.0-1-7")).toBe("s7t1.0-1-7-2");
    expect(uniqueId([{ id: "s7t1.0-1-7" }, { id: "s7t1.0-1-7-2" }], "s7t1.0-1-7")).toBe("s7t1.0-1-7-3");
  });

  it("gives two stones first seen in one tenth under one world id two ids", () => {
    // tray stone 1 arrives at t 9.96; world 1 is missing at t 10.00 while a hand places stone 2, and is back at t 10.04
    // at x 0.3: nothing pairs it with stone 1, so that is removed and world 1 added, both unclear and both first seen
    // in the tenth 10.0; the added one takes the id with -2 (4.6)
    const core = new InterpreterCore();
    const times = [9, 9.2, 9.4, 9.6, 9.96, 10, 10.04, ...Array.from({ length: 12 }, (_, k) => 10.2 + 0.2 * k)];
    const slab = (id: number, x: number): StoneView =>
      stone(id, [x, 0, 0.046], {
        mode: "kept",
        shape: "frozen",
        solid: { pos: [x, 0, 0.046], q: [0, 0, 0, 1], dims: [0.3, 0.2, 0.092] },
      });
    times.forEach((t, g) => {
      const stones = g === 5 ? [slab(2, 0.6)] : [slab(1, g >= 6 ? 0.3 : -0.6), slab(2, 0.6)];
      const events = g === 5 ? [{ type: "place" as const, id: 2, side: "left" }] : [];
      core.feed(mkFrame(g, { t, stones, events, stats: { stones: stones.length, confirmed: stones.length } }));
    });
    core.end();
    const tray = core.trays()[0]!;
    expect(tray.stones.map((s) => [s.id, s.worldId, s.added])).toEqual([
      ["s1t10.0-1-1", null, false],
      ["s1t10.0-1-2", 2, false],
      ["s1t10.0-1-1-2", 1, true],
    ]);
    expect(
      tray.facts.filter((f) => f.stone !== null && f.kind !== "unsure").map((f) => [f.kind, f.code, f.stone]),
    ).toEqual([
      ["removed", "not_found", "s1t10.0-1-1"],
      ["added", "not_recognised", "s1t10.0-1-1-2"],
    ]);
  });

  it("trays() keeps its own pass's trays while another pass of the same replay runs", async () => {
    const replay = await Replay.open(recordingPath(SYNTH));
    const trays = replay.trays(); // its pass starts
    const other = replay.updates();
    await other.next(); // another pass starts, and pauses after its first frame
    expect(numbers(await trays)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await other.return(undefined);
  });

  it("a certain addition still counts when its stone is removed unclear when the tray leaves", async () => {
    // tray 5: slab 47 is set down for certain, then gone after the last calm moment
    const replay = await Replay.open(recordingPath(SYNTH));
    const five = (await replay.trays())[4] as Tray;
    const slab = five.stone("20261118T000025.8Z-5-47");
    expect([slab?.added, slab?.status, slab?.certain]).toEqual([true, "removed", false]); // certain is the removal's
    expect(five.facts.filter((f) => f.stone === slab?.id).map((f) => [f.kind, f.certain])).toEqual([
      ["added", true],
      ["removed", false],
    ]);
    const leaving = five.facts[five.facts.length - 1] as TrayFact;
    expect([leaving.stones, leaving.sure, leaving.added, leaving.removed, leaving.unclear]).toEqual([2, 2, 1, 0, 1]);
    expect(five.check()).toEqual([]);
    // the self-check counts the leaving's additions, removals and unclear from the facts: each one off is C5
    const { session, video, n, arrived, leaving: point, stones, open, tId } = five;
    const off = (change: Partial<TrayFactInit>): string[] => {
      const facts = [...five.facts.slice(0, -1), new TrayFact({ ...leaving, ...change })];
      return new Tray({ session, video, n, arrived, leaving: point, stones, facts, open, tId }).check();
    };
    expect([off({ added: 0 }), off({ removed: 1 }), off({ unclear: 0 })]).toEqual([["C5"], ["C5"], ["C5"]]);
    expect((await replay.summary()).trays.added).toBe(2); // tray 1's slab and this one
  });

  it("events name their tray stone (before their frame) and the state its open tray", () => {
    const core = clocked();
    const seen = new Map<string, string | null>();
    const trays = new Set<number>();
    for (const f of frames()) {
      const u = core.feed(f);
      for (const e of u.events) seen.set(`${e.type} ${e.stoneId}`, e.trayStone);
      const tray = u.state.tray;
      if (tray === null) continue;
      trays.add(tray.n);
      expect(tray.leaving, "the open tray").toBeNull();
    }
    expect(seen.get("gone 2")).toBe("20261118T000000.8Z-1-2"); // it stood for 2 before this frame
    expect(seen.get("new 7")).toBeNull(); // a stone not on the tray yet
    expect(seen.get("lift 13")).toBe("20261118T000006.4Z-2-13");
    expect(seen.get("place 18")).toBe("20261118T000006.4Z-2-13"); // renamed: the same tray stone
    // revisions: the tray stone before the revised frame, not the links of the newest one
    expect(seen.get("confirm 2")).toBe("20261118T000000.8Z-1-2"); // frame 13, when 2 still stood for its tray stone
    expect(seen.get("confirm 7")).toBeNull(); // frame 26, still the newest, which set 7 down: none before it
    expect(seen.get("confirm 17")).toBeNull(); // frame 58, whose rename linked 17
    expect([...trays]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const end = core.end();
    expect([end.isFinal, end.frame, end.state.tray]).toEqual([true, null, null]);
    expect(core.state.tray).toBeNull();
  });

  it("the core keeps the newest trays that have left, and the open one", () => {
    const core = clocked({ traysKept: 2 });
    let last: number[] = [];
    for (const f of frames()) {
      core.feed(f);
      if (f.g === 80) expect(numbers(core.trays())).toEqual([1, 2, 3]); // tray 3 is on
      last = numbers(core.trays());
    }
    expect(last).toEqual([5, 6, 7]); // tray 7 is on, after the 2 newest that have left
    core.end();
    expect(numbers(core.trays())).toEqual([6, 7]);
    const one = clocked({ traysKept: 1 });
    for (const f of frames()) one.feed(f);
    one.end();
    expect(numbers(one.trays())).toEqual([7]);
    const every = clocked({ traysKept: 0 });
    for (const f of frames()) every.feed(f);
    expect(numbers(every.trays())).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(every.state.tray?.n).toBe(7); // tray 7 is still on
  });

  it("finish() leaves the facts of the open tray leaving in trays()", () => {
    const core = clocked();
    for (const f of frames()) core.feed(f);
    expect(core.finish()).toEqual([]); // no activity was open
    expect(text(core.trays().flatMap((t) => t.facts))).toBe(golden());
  });

  it("the interpreter streams the tray facts, and end() makes the open tray leave", async () => {
    const fake = await fixtureFake(SYNTH, { endOfData: "close" });
    const interpreter = clientOf(fake).interpreter({ resume: false });
    expect(text(await all(interpreter.trayFacts()))).toBe(golden());
    expect(numbers(interpreter.trays())).toEqual([1, 2, 3, 4, 5, 6, 7]); // the stream's end made tray 7 leave
    const last = interpreter.end();
    expect([last.isFinal, last.trayFacts.length]).toEqual([true, 0]); // so nothing is left to leave
    fake.close();
  });

  it("a tray-facts loop stopped inside a frame leaves the rest of it to the next loop", async () => {
    const fake = await fixtureFake(SYNTH, { endOfData: "close" });
    const interpreter = clientOf(fake).interpreter({ resume: false });
    for await (const fact of interpreter.trayFacts()) if (fact.clock === "0:08.6") break; // three facts at 0:08.6
    const rest = await all(interpreter.trayFacts());
    expect(rest[0]?.describe()).toBe(
      "0:08.6 tray 2: stone 20261118T000006.4Z-2-15 is not sure any more (its box overlaps another stone)",
    );
    expect(golden().endsWith(text(rest))).toBe(true);
    fake.close();
  });

  it("replays the tray facts of a recording, async and in memory", async () => {
    const replay = await Replay.open(readBytes(`recordings/${SYNTH}.ndjson.gz`));
    const facts: TrayFact[] = [];
    for await (const f of replay.trayFacts()) facts.push(f);
    expect(text(facts)).toBe(golden());
  });

  it("reads a summary without trays (one made before trays were counted) as zeros", async () => {
    const summary = await (await Replay.open(readBytes(`recordings/${SYNTH}.ndjson.gz`))).summary();
    const json = summary.toJSON();
    expect(json.trays).toEqual({
      total: 7,
      arrived: 6,
      stones: 33,
      added: 2,
      added_unclear: 1,
      removed: 1,
      removed_unclear: 2,
      unsure: 5,
    });
    const { trays: _trays, ...old } = json;
    const zeros = Summary.fromJSON(old).trays;
    expect(zeros).toEqual({
      total: 0,
      arrived: 0,
      stones: 0,
      added: 0,
      addedUnclear: 0,
      removed: 0,
      removedUnclear: 0,
      unsure: 0,
    });
    expect(Summary.fromJSON(old).describe()).toContain(
      "trays: 0 (arrived 0), stones at arrival 0, added 0 (+0 unclear), removed 0 (+0 unclear), not sure 0\n",
    );
  });

  it("says every kind of fact, with what it lacks as 0 and ?", () => {
    const base: TrayFactInit = {
      kind: "arrived",
      tray: 2,
      session: 1,
      video: "v",
      stone: null,
      worldId: null,
      certain: null,
      why: null,
      g: 306,
      t: 61.2,
      wall: null,
      stones: null,
      sure: null,
      added: null,
      removed: null,
      unclear: null,
    };
    const say = (x: Partial<TrayFactInit>): string => new TrayFact({ ...base, ...x }).describe();
    expect(say({})).toBe("1:01.2 tray 2 arrived: 0 stones");
    expect(say({ kind: "leaving" })).toBe("1:01.2 tray 2 leaving: 0 stones (0 sure), 0 added, 0 removed, 0 unclear");
    expect(say({ kind: "leaving", stones: 5, sure: 4, added: 1, removed: 2, unclear: 3 })).toBe(
      "1:01.2 tray 2 leaving: 5 stones (4 sure), 1 added, 2 removed, 3 unclear",
    );
    expect(say({ kind: "unsure" })).toBe("1:01.2 tray 2: stone ? is not sure any more ()");
    expect(say({ kind: "unsure", stone: "x", why: "it was pushed" })).toBe(
      "1:01.2 tray 2: stone x is not sure any more (it was pushed)",
    );
    expect(say({ kind: "removed", stone: "x", certain: true, why: "missing" })).toBe(
      "1:01.2 tray 2: stone x was removed",
    );
    expect(say({ kind: "removed", stone: "x", certain: false })).toBe("1:01.2 tray 2: stone x not found (unclear)");
    expect(say({ kind: "added", stone: "x", certain: true })).toBe("1:01.2 tray 2: stone x was set down");
    expect(say({ kind: "added", stone: "x", certain: null })).toBe("1:01.2 tray 2: stone x not recognised (unclear)");
    expect(describeTrayFact({ ...base, kind: "removed", stone: "y", certain: true, why: "carried away" })).toBe(
      "1:01.2 tray 2: stone y was removed (carried away)",
    );
  });

  it("an event without an id on a tray changes no tray stone", () => {
    const core = new InterpreterCore();
    const bricks = [stone(1, [0, 0, 0.05]), stone(2, [0.5, 0, 0.05])];
    const stats = { stones: 2, confirmed: 2 };
    for (let g = 0; g < 20; g++) core.feed(mkFrame(g, { stones: bricks, stats }));
    expect(core.state.tray?.arrived).not.toBeNull();
    const u = core.feed(mkFrame(20, { stones: bricks, stats, events: [{ type: "push", side: "left" }] }));
    expect([u.events[0]?.trayStone, u.trayFacts]).toEqual([null, []]);
    expect(core.state.tray?.stones.map((s) => [s.worldId, s.status, s.sure])).toEqual([
      [1, "on", true],
      [2, "on", true],
    ]);
  });

  describe("brief quiet absences", () => {
    const one = stone(1);
    const two = stone(2, [0.7, 0, 0.05]);
    const start = (): InterpreterCore => {
      const core = new InterpreterCore();
      for (let g = 0; g < 12; g++) core.feed(mkFrame(g, { stones: [one], stats: { confirmed: 1, stones: 1 } }));
      return core;
    };

    it.each([1, 2])("keeps the original link and the birth of an unidentified stone after %i omissions", (count) => {
      const core = start();
      core.feed(mkFrame(12, { stones: [one, two] }));
      for (let i = 0; i < count; i++) {
        core.feed(mkFrame(13 + i));
        expect(core.state.tray!.stones[0]).toMatchObject({ worldId: 1, status: "on" });
      }
      core.feed(
        mkFrame(13 + count, {
          stones: [one, two],
          events: [
            { type: "new", id: 3 },
            { type: "confirm", id: 2 },
            { type: "freeze", id: 1 },
          ],
        }),
      );
      core.end();
      const tray = core.trays()[0]!;
      expect(tray.leaving!.g).toBe(12);
      expect(tray.stones.map((s) => [s.worldId, s.born.g, s.status])).toEqual([
        [1, 4, "on"],
        [2, 12, "on"],
      ]);
      expect(tray.check()).toEqual([]);
    });

    it("leaves the identity unresolved when two neighbouring tracks disappear together or a new rival appears", () => {
      const near = stone(2, [0.08, 0, 0.05]);
      const core = start();
      core.feed(mkFrame(12, { stones: [one, near] }));
      core.feed(mkFrame(13));
      core.feed(mkFrame(14));
      core.feed(mkFrame(15, { stones: [one, near], events: [{ type: "new", id: 9 }] }));
      // Either returning track could be the arrival stone. The unrelated birth keeps this out of a calm snapshot.
      expect(core.state.tray!.stones[0]).toMatchObject({ worldId: null, status: "lost" });
      core.end();
      const report = core.trays()[0]!.report()!;
      expect(report.removed.map((change) => [change.stone, change.certain])).toEqual([["s1t0.8-1-1", false]]);
      expect(report.added).toEqual([]);
    });

    it.each([
      [0.14, 0.14, 0],
      [0.14, 0.07, 0.07],
      [0.24, 0.13, 0.11],
    ])(
      "does not silently keep the old identities across a crossed or tied return (%f, %f, %f)",
      (separation, x1, x2) => {
        const core = new InterpreterCore();
        const small = (id: number, x: number): StoneView =>
          stone(id, [x, 0, 0.015], {
            solid: { pos: [x, 0, 0.015], q: [0, 0, 0, 1], dims: [0.09, 0.05, 0.03] },
            shape: "frozen",
          });
        for (let g = 0; g < 13; g++)
          core.feed(mkFrame(g, { stones: [small(1, 0), small(2, separation)], stats: { confirmed: 2, stones: 2 } }));
        core.feed(mkFrame(13));
        for (let g = 14; g < 23; g++) core.feed(mkFrame(g, { stones: [small(1, x1), small(2, x2)] }));
        core.end();
        const tray = core.trays()[0]!;
        for (const s of tray.stones.filter((s) => !s.added)) {
          expect(s.sure && s.worldId === Number(s.id.split("-").at(-1))).toBe(false);
        }
        expect(tray.check()).toEqual([]);
      },
    );

    it("drops a link if a new plausible neighbour appears during the omission", () => {
      const near = stone(2, [0.08, 0, 0.05]);
      for (const first of [12, 13]) {
        const rival = start();
        for (let g = 12; g < first; g++) rival.feed(mkFrame(g));
        rival.feed(mkFrame(first, { stones: [near] }));
        expect(rival.state.tray!.stones[0]!.worldId).not.toBe(1);
      }
    });

    it("drops a link if a hand or push disturbed the preceding frame", () => {
      for (const spec of [
        { events: [{ type: "push" as const, id: 88 }] },
        { events: [{ type: "delete" as const, id: 88, why: "carried-away" }] },
        { hands: { left: { state: "free" as const, stone: null, untrusted: true } } },
      ]) {
        const core = start();
        core.feed(mkFrame(12, { ...spec, stones: [one] }));
        core.feed(mkFrame(13));
        expect(core.state.tray!.stones[0]!.status).toBe("lost");
      }
    });

    it("waits for a complete arrival frame, even before it has any links", () => {
      const core = new InterpreterCore();
      for (let g = 0; g < 13; g++) {
        const stones = g === 4 || g === 5 ? [one] : [one, two];
        core.feed(mkFrame(g, { stones, stats: { stones: stones.length, confirmed: stones.length } }));
      }
      expect(core.state.tray!.arrived!.g).toBe(6);
      expect(core.state.tray!.stones.map((s) => s.worldId)).toEqual([1, 2]);
    });

    it("ends an unresolved absence at close and expires a run of three quiet omissions", () => {
      for (const count of [1, 2, 3]) {
        const core = start();
        core.feed(mkFrame(12, { stones: [one, two] }));
        for (let i = 0; i < count; i++) core.feed(mkFrame(13 + i));
        expect(core.state.tray!.stones[0]!.status).toBe(count === 3 ? "lost" : "on");
        core.end();
        const tray = core.trays()[0]!;
        expect(tray.stones[0]!.status).toBe("removed");
        expect(tray.stones).toHaveLength(1);
        expect(tray.check()).toEqual([]);
      }
    });

    it("honours a hand taking a stone during an omission", () => {
      const core = start();
      core.feed(mkFrame(12));
      core.feed(mkFrame(13, { events: [{ type: "gone", id: 1, side: "left" }] }));
      expect(core.state.tray!.stones[0]!.status).toBe("lost");
      for (let g = 14; g < 31; g++) core.feed(mkFrame(g));
      core.feed(mkFrame(31, { events: [{ type: "new", id: 2 }] }));
      for (let g = 32; g < 36; g++) core.feed(mkFrame(g));
      expect(core.state.tray!.facts.find((f) => f.kind === "removed")?.code).toBe("carried_away");
    });

    it("does not bridge a changed size, a far return, an identity event, or a gap", () => {
      const wider: StoneView = { ...two, solid: { ...two.solid, dims: [0.6, 0.4, 0.09] } };
      for (const frame of [
        mkFrame(14, { stones: [one, wider] }),
        mkFrame(14, { stones: [one, stone(2, [1.5, 0, 0.05])] }),
        mkFrame(14, { stones: [one, two], events: [{ type: "new", id: 2 }] }),
        mkFrame(15, { stones: [one, two] }),
      ]) {
        const core = start();
        core.feed(mkFrame(12, { stones: [one, two] }));
        core.feed(mkFrame(13, { stones: [one] }));
        core.feed(frame);
        core.end();
        // When the world id returns on a normal frame its unidentified record starts again, even if a later settle pairs it.
        expect(core.trays()[0]!.stones.some((s) => s.added && s.born.g === 12)).toBe(false);
      }
    });
  });

  it("when the tray leaves, of two stones as near to a lost one, the lower world id is matched to it", () => {
    const core = new InterpreterCore();
    const frame = (g: number, stones: StoneView[]): Frame =>
      mkFrame(g, { stones, stats: { stones: stones.length, confirmed: stones.length } });
    for (let g = 0; g < 20; g++) core.feed(frame(g, [stone(1, [0, 0, 0.05]), stone(2, [0.5, 0, 0.05])]));
    expect(core.state.tray?.arrived).not.toBeNull();
    // 1 goes, and 11 and 10 turn up as near to its place: no rename, and the pairs tie on distance and tray order
    const two = [stone(2, [0.5, 0, 0.05]), stone(11, [-0.05, 0, 0.05]), stone(10, [0.05, 0, 0.05])];
    for (let g = 20; g < 30; g++) core.feed(frame(g, two));
    expect(core.state.tray?.stones.map((s) => s.status)).toEqual(["lost", "on"]);
    const facts = core.end().trayFacts;
    const tray = core.trays().at(-1)!;
    expect(tray.stones.map((s) => [s.id.split("-").at(-1), s.worldId, s.status, s.sure, s.added])).toEqual([
      ["1", 10, "on", false, false],
      ["2", 2, "on", true, false],
      ["11", 11, "on", false, true],
    ]);
    expect(facts.map((f) => [f.kind, f.worldId, f.code])).toEqual([
      ["unsure", 10, "matched_at_leaving"],
      ["added", 11, "not_recognised"],
      ["leaving", null, null],
    ]);
  });

  it("of two lost stones as near to a new one, neither is renamed to it: the world may have renamed either", () => {
    const core = new InterpreterCore();
    const frame = (g: number, stones: StoneView[]): Frame =>
      mkFrame(g, { stones, stats: { stones: stones.length, confirmed: stones.length } });
    const three = [stone(1, [0, -0.08, 0.05]), stone(2, [0, 0.08, 0.05]), stone(3, [0.6, 0, 0.05])];
    for (let g = 0; g < 20; g++) core.feed(frame(g, three));
    expect(core.state.tray?.arrived).not.toBeNull();
    // 1 and 2 go, and 9 turns up between them, 0.08 from each: no rename
    const after = [stone(3, [0.6, 0, 0.05]), stone(9, [0, 0, 0.05])];
    for (let g = 20; g < 30; g++) core.feed(frame(g, after));
    expect(core.state.tray?.stones.map((s) => [s.id.split("-").at(-1), s.worldId, s.status])).toEqual([
      ["1", null, "lost"],
      ["2", null, "lost"],
      ["3", 3, "on"],
    ]);
    // when the tray leaves, the two pairs tie on distance: tray order gives 9 to 1, and 2 is not found
    expect(core.end().trayFacts.map((f) => [f.kind, f.worldId, f.code])).toEqual([
      ["unsure", 9, "matched_at_leaving"],
      ["removed", null, "not_found"],
      ["leaving", null, null],
    ]);
    // With 2 still there, the new neighbour 9 prevents grace: 1 alone fits 9 immediately.
    const one = new InterpreterCore();
    for (let g = 0; g < 20; g++) one.feed(frame(g, three));
    const renamed = [stone(2, [0, 0.08, 0.05]), stone(3, [0.6, 0, 0.05]), stone(9, [0, -0.08, 0.05])];
    one.feed(frame(20, renamed));
    expect(one.state.tray?.stones.map((s) => [s.worldId, s.status])).toEqual([
      [9, "on"],
      [2, "on"],
      [3, "on"],
    ]);
  });
});
