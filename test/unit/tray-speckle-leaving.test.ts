/**
 * Version 8 of the tray rules (SDK-DESIGN.md 4.6.13) beyond the golden files: the leaving's speckle answer confirms,
 * relinks and finds stones again, each stone's evidence and each change's confidence, the self-check's C3, C4 and C9
 * with the leaving's speckle facts, and the pairs an answer may not link. The rules themselves are golden-tested over
 * `trays-speckle-synthetic` (its tray 3 has a leaving answer) and dry1's tray 1.
 */
import { describe, expect, it } from "vitest";
import {
  InterpreterCore,
  Replay,
  SPECKLE_CLEAN,
  SPECKLE_CODES,
  Tray,
  TrayFact,
  describeTrayFact,
  type SpeckleFind,
  type StoneView,
  type TrayFactInit,
  type TrayInit,
  type TrayReport,
  type TrayStone,
  type WorldEvent,
  type WorldSpeckle,
} from "pdigger-factory-sdk";
import { readBytes } from "../helpers/fixtures.js";
import { mkFrame, stone } from "../helpers/frames.js";

const SPECKLE = "trays-speckle-synthetic";
let kept: readonly Tray[] | null = null;
const trays = (): readonly Tray[] =>
  (kept ??= Replay.fromBytes(readBytes(`recordings/${SPECKLE}.ndjson.gz`)).traysSync());
/** The synthetic's tray 3, whose leaving has an answer. */
const three = (): Tray => trays().find((t) => t.n === 3) as Tray;
/** The tray stone whose id ends with that world id (`...-3-61`). */
const stoneOf = (t: Tray, wid: number): TrayStone => t.stones.find((s) => s.id.endsWith(`-${t.n}-${wid}`)) as TrayStone;

function remake(t: Tray, change: Partial<TrayInit>): Tray {
  return new Tray({
    session: t.session,
    video: t.video,
    n: t.n,
    arrived: t.arrived,
    leaving: t.leaving,
    stones: t.stones,
    facts: t.facts,
    open: t.open,
    tId: t.tId,
    ...change,
  });
}

const fact = (x: TrayFact, change: Partial<TrayFactInit>): TrayFact => new TrayFact({ ...x, ...change });
const withFacts = (t: Tray, facts: readonly TrayFact[]): string[] => remake(t, { facts }).check();
/** The tray's facts about one stone. */
const factsOf = (t: Tray, s: TrayStone): TrayFact[] => t.facts.filter((x) => x.stone === s.id);

describe("the leaving's speckle answer (version 8)", () => {
  it("confirms stones not sure, finds a lost stone again and swaps two: one fact each, sure", () => {
    const t = three();
    const by = (wid: number): (string | number | boolean | null)[] => {
      const x = factsOf(t, stoneOf(t, wid)).find((f) => f.kind === "identified") as TrayFact;
      return [x.code, x.worldId, x.fromWorld, x.score, x.margin, x.bar, x.certain];
    };
    expect(by(61)).toEqual(["speckle_same", 61, null, 600, 500, SPECKLE_CLEAN, null]);
    expect(by(63)).toEqual(["speckle_same", 63, null, 600, 480, SPECKLE_CLEAN, null]);
    expect(by(65)).toEqual(["speckle_found", 75, null, 660, 560, SPECKLE_CLEAN, null]); // lost, found again on 75
    expect(by(66)).toEqual(["speckle_moved", 67, 66, 640, 540, SPECKLE_CLEAN, null]); // 66 and 67 swapped
    expect(by(67)).toEqual(["speckle_moved", 66, 67, 630, 530, SPECKLE_CLEAN, null]);
    // the stones the answer linked or confirmed are sure again, by_speckle; each was unsure (or lost) before
    for (const wid of [61, 62, 63, 65, 66, 67]) {
      const s = stoneOf(t, wid);
      expect([s.status, s.sure, s.bySpeckle, s.question], `stone ${wid}`).toEqual(["on", true, true, null]);
      expect(factsOf(t, s).map((x) => x.kind)).toEqual(
        wid === 65 ? ["identified"] : ["unsure", "identified"], // 65 was lost: never unsure
      );
    }
    expect(t.check()).toEqual([]);
    expect(t.facts.at(-1)?.describe()).toBe("0:24.4 tray 3 leaving: 11 stones (7 sure), 0 added, 1 removed, 5 unclear");
  });

  it("refuses a pair that would move a stone nothing disturbed: 78's pair with 68", () => {
    const t = three();
    const s68 = stoneOf(t, 68);
    expect([s68.worldId, s68.sure, s68.bySpeckle]).toEqual([68, true, false]);
    expect(factsOf(t, s68)).toEqual([]);
    const s78 = stoneOf(t, 78);
    expect([s78.added, s78.certain, s78.evidence]).toEqual([true, false, "found"]); // the answer pairs 78: contradicted
  });

  it("gives every stone its evidence as the tray leaves, null while it is on", () => {
    const t = three();
    const evidence = Object.fromEntries(t.stones.map((s) => [Number(s.id.split("-").at(-1)), s.evidence]));
    expect(evidence).toEqual({
      61: "found",
      62: "found",
      63: "found",
      64: "found", // removed for certain, but a clean find of it is on the tray as it left
      65: "found",
      66: "found",
      67: "found",
      68: "found",
      69: "not_found",
      71: "not_found", // set down: not on the tray at the arrival
      72: "found", // on the tray since the arrival: a clean find there
      73: "undecided", // a look-alike: a find not twice its second
      78: "found",
    });
    // the trays without a leaving answer: undecided
    for (const n of [1, 2]) {
      const s = trays().find((x) => x.n === n)?.stones ?? [];
      expect(new Set(s.map((x) => x.evidence)), `tray ${n}`).toEqual(new Set(["undecided"]));
    }
    // the open tray's stones have none yet
    const core = new InterpreterCore();
    for (const f of Replay.fromBytes(readBytes(`recordings/${SPECKLE}.ndjson.gz`)).framesSync()) {
      core.feed(f);
      if (f.g === 100) break;
    }
    const open = core.trays().at(-1) as Tray;
    expect([open.n, open.leaving]).toEqual([3, null]);
    expect(open.stones.map((s) => [s.evidence, s.bySpeckle])).toEqual(open.stones.map(() => [null, false]));
  });

  it("gives every change of the report its confidence", () => {
    const r = three().report() as TrayReport;
    const conf = (cs: TrayReport["removed"]): [string, boolean, number][] =>
      cs.map((c) => [c.stone.split("-").at(-1) as string, c.certain, c.confidence]);
    expect(conf(r.removed)).toEqual([
      ["64", true, 0.25], // a certain removal the answer contradicts
      ["69", false, 0.71],
    ]);
    expect(conf(r.added)).toEqual([
      ["71", false, 0.96],
      ["72", false, 0.02],
      ["73", false, 0.52],
      ["78", false, 0.02],
    ]);
    expect(conf(r.moved)).toEqual([
      ["62", true, 0.87],
      ["65", true, 0.87],
      ["66", true, 0.87],
      ["67", true, 0.87],
    ]);
    const json = JSON.parse(JSON.stringify(r)) as {
      removed: { confidence: number }[];
      moved: { confidence: number }[];
    };
    expect([json.removed[0]?.confidence, json.moved[0]?.confidence]).toEqual([0.25, 0.87]);
  });

  it("says each of its facts", () => {
    expect([...SPECKLE_CODES]).toEqual(["speckle_same", "speckle_moved", "speckle_found"]);
    const base = { kind: "identified", tray: 3, t: 24.4, stone: "s", certain: null, why: null, worldId: 75 };
    const counts = { stones: null, sure: null, added: null, removed: null, unclear: null };
    const say = (code: string, score: number | null): string => describeTrayFact({ ...base, ...counts, code, score });
    expect(say("speckle_same", 600)).toBe("0:24.4 tray 3: stone s confirmed by its speckle on world stone 75 (0.600)");
    expect(say("speckle_moved", 640)).toBe(
      "0:24.4 tray 3: stone s recognised by its speckle on world stone 75 (0.640)",
    );
    expect(say("speckle_found", null)).toBe("0:24.4 tray 3: stone s found again by its speckle on world stone 75 (-)");
    expect(say("look_found", 900)).toBe("0:24.4 tray 3: stone s found again by its look on world stone 75 (0.900)");
  });
});

describe("the self-check with the leaving's speckle (4.6.10)", () => {
  /** Stone 61 of tray 3: unsure (a stone next to it was pushed), then confirmed by its speckle. */
  const parts = (): { t: Tray; unsure: TrayFact; same: TrayFact; i: number; j: number } => {
    const t = three();
    const [unsure, same] = factsOf(t, stoneOf(t, 61)) as [TrayFact, TrayFact];
    return { t, unsure, same, i: t.facts.indexOf(unsure), j: t.facts.indexOf(same) };
  };

  it("C3: after unsure only a removal or one fact of the leaving's speckle; none after a removal", () => {
    const { t, unsure, same, j } = parts();
    expect([unsure.kind, same.code]).toEqual(["unsure", "speckle_same"]);
    expect(t.check()).toEqual([]);
    const head = t.facts.slice(0, j + 1);
    const tail = t.facts.slice(j + 1);
    expect(withFacts(t, [...head, same, ...tail])).toContain("C3"); // two of the leaving's speckle
    const look = fact(same, { code: "look_found", score: 900, bar: 750 });
    expect(withFacts(t, [...t.facts.slice(0, j), look, ...tail])).toContain("C3"); // a look's after unsure
    const gone = stoneOf(t, 64); // removed for certain at 0:15.6
    const removal = t.facts.find((x) => x.kind === "removed" && x.stone === gone.id) as TrayFact;
    const k = t.facts.indexOf(removal);
    const late = fact(same, { stone: gone.id, worldId: null });
    expect(withFacts(t, [...t.facts.slice(0, k + 1), late, ...t.facts.slice(k + 1)])).toContain("C3");
  });

  it("C4: a stone is sure exactly when no unsure fact comes after its fact of the leaving's speckle", () => {
    const { t, same, unsure, i, j } = parts();
    expect(
      withFacts(
        t,
        t.facts.filter((x) => x !== same),
      ),
    ).toContain("C4"); // sure, but its unsure fact stands
    // its speckle fact before its unsure fact: the unsure fact stands
    const swapped = [...t.facts];
    swapped[i] = same;
    swapped[j] = unsure;
    expect(withFacts(t, swapped)).toEqual(["C4"]);
  });

  it("C9: a fact of the leaving's speckle clears SPECKLE_CLEAN, its bar, and is not certain", () => {
    const { t, same, j } = parts();
    const tried = (change: Partial<TrayFactInit>): string[] => {
      const facts = [...t.facts];
      facts[j] = fact(same, change);
      return withFacts(t, facts);
    };
    expect(tried({ margin: 10 })).toEqual([]); // no margin rule: the clean find's second is half its score at most
    expect(tried({ margin: null })).toEqual([]);
    for (const bad of [
      { bar: 750 }, // a look's bar
      { bar: 200 }, // cleared, but not SPECKLE_CLEAN
      { score: 299 },
      { score: null },
      { bar: null },
      { certain: true },
    ] as Partial<TrayFactInit>[])
      expect(tried(bad), JSON.stringify(bad)).toEqual(["C9"]);
  });
});

// ---- a tray made by hand: the pairs an answer links and those it may not ------------------------------------------

const find = (id: number, at: number | null, score: number | null, second: number | null): SpeckleFind => ({
  id,
  at,
  score,
  second,
});

/** An answer from the tray's arrival (g4) to the later moment `at`. */
const answerOf = (at: number, refs: SpeckleFind[], stones: SpeckleFind[], pairs: [number, number][]): WorldSpeckle => ({
  v: 1,
  tray: 1,
  ref: { g: 4, t: 0.8 },
  at: { g: at, t: at / 5 },
  device: "d",
  gpu_ms: 1,
  wall_ms: 2,
  stones,
  refs,
  pairs,
});

interface Leaving {
  /** Its later moment (the leaving point is g27). */
  at?: number;
  /** It pairs stone 5 with its own world stone ... */
  pairFive?: boolean;
  /** ... and has a clean find of it. */
  findFive?: boolean;
}

/**
 * An answer for the hand-made tray: stone 1 on world stone 6 and stone 2 on 7 (pairs that move them); stone 3 where
 * it was (its arrival find is not clean: the later find counts); stone 4 on stone 5's world stone (refused while
 * nothing disturbed stone 5); a world id no tray stone had at the arrival; and stone 5 where it was (`pairFive`, with
 * or without a find of it).
 */
function leavingAnswer({ at = 27, pairFive = true, findFive = false }: Leaving = {}): WorldSpeckle {
  const pairs: [number, number][] = [
    [6, 1],
    [7, 2],
    [3, 3],
    [5, 4],
    [4, 99],
  ];
  return answerOf(
    at,
    [find(1, 6, 0.6, 0.1), find(2, 7, 0.62, 0.1), find(3, 3, 0.2, 0.1), find(4, 5, 0.65, 0.1)].concat(
      findFive ? [find(5, 5, 0.7, 0.1)] : [],
    ),
    [find(6, 1, 0.61, 0.1), find(7, 2, 0.63, 0.1), find(3, 3, 0.6, 0.1), find(1, null, 0.12, 0.05)],
    pairFive ? [...pairs, [5, 5]] : pairs,
  );
}

/**
 * Stones 1 to 5 arrive at g4 in a row, 0.5 apart; a hand pushes 1 at g14 and 2, 3 and 4 at g18 (each not sure at the
 * next settle); world stone 6 appears below stone 1 at g22; the last calm frame is g27, the leaving point; world stone
 * 7 appears below stone 2 at g28, after it (only the tray's last frame, g29, shows it). `pushFive` pushes stone 5
 * (no hand) at g26, after the last settle; each answer comes in the world of the frame its key names.
 */
function handMade(answers: Record<number, WorldSpeckle>, pushFive = false): Tray {
  const core = new InterpreterCore();
  const at = (id: number, x: number, y = 0): StoneView => stone(id, [x, y, 0.05]);
  const row = [at(1, -1), at(2, -0.5), at(3, 0), at(4, 0.5), at(5, 1)];
  for (let g = 0; g < 30; g++) {
    const stones = [...row, ...(g >= 22 ? [at(6, -1, -0.5)] : []), ...(g >= 28 ? [at(7, -0.5, -0.5)] : [])];
    const events: Partial<WorldEvent>[] = [];
    if (g === 14) events.push({ type: "push", id: 1, side: "left" });
    if (g === 18) for (const id of [2, 3, 4]) events.push({ type: "push", id, side: "left" });
    if (g === 22) events.push({ type: "new", id: 6 });
    if (g === 26 && pushFive) events.push({ type: "push", id: 5 });
    if (g === 28) events.push({ type: "new", id: 7 });
    const f = mkFrame(g, { stones, events, stats: { stones: stones.length, confirmed: stones.length } });
    const sp = answers[g];
    if (sp !== undefined && f.world) f.world.speckle = sp;
    core.feed(f);
  }
  core.end();
  return core.trays()[0] as Tray;
}

const ARRIVAL = [
  "0:00.8 tray 1 arrived: 5 stones",
  "0:03.4 tray 1: stone s1t0.8-1-1 is not sure any more (it was pushed)",
  "0:04.2 tray 1: stone s1t0.8-1-2 is not sure any more (it was pushed)",
  "0:04.2 tray 1: stone s1t0.8-1-3 is not sure any more (it was pushed)",
  "0:04.2 tray 1: stone s1t0.8-1-4 is not sure any more (it was pushed)",
];
/** Version 7's leaving of the hand-made tray: world stone 6 added unclear. */
const NO_ANSWER = [
  ...ARRIVAL,
  "0:05.4 tray 1: stone s1t4.4-1-6 not recognised (unclear)",
  "0:05.4 tray 1 leaving: 6 stones (1 sure), 0 added, 0 removed, 1 unclear",
];

const stoneNo = (t: Tray, i: number): TrayStone => t.stone(`s1t0.8-1-${i}`) as TrayStone;

describe("the pairs of a leaving answer, on a tray made by hand", () => {
  it("links what the pairs may link, and frees the world stones the moved stones stood on", () => {
    const t = handMade({ 29: leavingAnswer() });
    expect(t.leaving?.g).toBe(27);
    expect(t.facts.map((x) => x.describe())).toEqual([
      ...ARRIVAL,
      "0:05.4 tray 1: stone s1t0.8-1-1 recognised by its speckle on world stone 6 (0.600)",
      "0:05.4 tray 1: stone s1t0.8-1-2 recognised by its speckle on world stone 7 (0.620)",
      "0:05.4 tray 1: stone s1t0.8-1-3 confirmed by its speckle on world stone 3 (0.600)",
      "0:05.4 tray 1: stone s1t5.4-1-1 not recognised (unclear)",
      "0:05.4 tray 1: stone s1t5.4-1-2 not recognised (unclear)",
      "0:05.4 tray 1 leaving: 7 stones (4 sure), 0 added, 0 removed, 2 unclear",
    ]);
    expect(t.check()).toEqual([]);
    const said = (x: Tray): (number | null)[][] =>
      x.facts.filter((f) => f.kind === "identified").map((f) => [f.fromWorld, f.margin]);
    // the moved stones name the world stone they stood on; stone 3's clean find is the later one
    expect(said(t)).toEqual([
      [1, 500],
      [2, 520],
      [null, 500],
    ]);
    // stone 2's world stone 7 is in the tray's last frame only: it is linked from there
    expect([1, 2, 3, 4, 5].map((i) => stoneNo(t, i).worldId)).toEqual([6, 7, 3, 4, 5]);
    expect([1, 2, 3, 4, 5].map((i) => [stoneNo(t, i).sure, stoneNo(t, i).bySpeckle])).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [false, false], // its pair would give stone 5's world stone to it
      [true, true], // sure and on its pair's world stone: confirmed, no fact (and no find needed)
    ]);
    // the world stones 1 and 2 are unidentified again (freed): added unclear as the tray leaves
    expect((t.open ?? []).map((o) => [o.stone, o.kind, o.cause])).toEqual([
      ["s1t0.8-1-4", "unsure", "pushed"],
      ["s1t5.4-1-1", "added", "freed"],
      ["s1t5.4-1-2", "added", "freed"],
    ]);
    expect(t.stones.map((x) => x.evidence)).toEqual([
      "found",
      "found",
      "found", // in a pair (its own find is not clean)
      "found", // in a pair, though not linked
      "undecided", // not in the answer
      "not_found", // world stone 1 was not on the tray at the arrival
      "undecided", // world stone 2 is not in the answer's later stones
    ]);
    expect((t.report() as TrayReport).describe()).toBe(
      "tray 1, 0:00.8 to 0:05.4: 0 removed, 2 added, 1 moved, not complete: 2 unclear, 1 not sure\n" +
        "  0:05.4 added s1t5.4-1-1 at (-1.00, 0.00) (unclear, 0.96)\n" +
        "  0:05.4 added s1t5.4-1-2 at (-0.50, 0.00) (unclear, 0.52)\n" +
        "  moved s1t0.8-1-1 0.50 to (-1.00, -0.50) (0.87)",
    );
  });

  it("reads only the newest answer whose later moment is within SPECKLE_NEAR frames of the leaving point", () => {
    // an older answer near the leaving point would move stone 4 to world stone 6: the newer one is the leaving's
    const older = answerOf(26, [find(4, 6, 0.7, 0.1)], [find(6, 4, 0.7, 0.1)], [[6, 4]]);
    const t = handMade({ 28: older, 29: leavingAnswer() });
    expect([stoneNo(t, 1).worldId, stoneNo(t, 4).worldId]).toEqual([6, 4]);
    // a later moment three frames from the leaving point: no leaving answer, version 7's account
    const far = handMade({ 29: leavingAnswer({ at: 24 }) });
    expect(far.facts.map((x) => x.describe())).toEqual(NO_ANSWER);
    expect(new Set(far.stones.map((x) => [x.evidence, x.bySpeckle].join()))).toEqual(new Set(["undecided,false"]));
  });

  it("does not test the stones it pairs at the leaving: the answer settles them", () => {
    // stone 5 is pushed after the last settle: the leaving doubts it unless the answer pairs it; doubted, it is no
    // longer trusted, so the pair of stone 4 with its world stone links: stone 5 is lost and removed, unclear
    const doubted = handMade({ 29: leavingAnswer({ pairFive: false }) }, true);
    expect([stoneNo(doubted, 5).status, stoneNo(doubted, 5).bySpeckle]).toEqual(["removed", false]);
    expect(factsOf(doubted, stoneNo(doubted, 5)).map((x) => x.describe())).toEqual([
      "0:05.4 tray 1: stone s1t0.8-1-5 is not sure any more (it was pushed)",
      "0:05.4 tray 1: stone s1t0.8-1-5 not found (unclear)",
    ]);
    const four = factsOf(doubted, stoneNo(doubted, 4)).at(-1) as TrayFact;
    expect([four.code, four.worldId, four.fromWorld]).toEqual(["speckle_moved", 5, 4]);
    expect(doubted.check()).toEqual([]);
    for (const findFive of [false, true]) {
      const paired = handMade({ 29: leavingAnswer({ findFive }) }, true);
      const s = stoneNo(paired, 5);
      expect([s.status, s.sure, s.bySpeckle, s.evidence]).toEqual(["on", true, true, findFive ? "found" : "undecided"]);
      expect(factsOf(paired, s)).toEqual([]); // sure and on its pair's world stone: confirmed, no fact
      expect(stoneNo(paired, 4).worldId).toBe(4);
      expect(paired.check()).toEqual([]);
    }
  });

  it("links nothing on a pair whose clean find has no score, unless its stone is sure and on its world stone", () => {
    // a unit pairs only stones it found: such a pair is a malformed answer, read without failing. Stone 3 is not sure:
    // confirming it needs a fact, but its arrival find is not clean and a later one of world stone 3 is missing or was
    // not checked: the pair is skipped
    for (const later of [[], [find(3, 3, null, null)]]) {
      const t = handMade({ 29: answerOf(27, [find(3, 3, 0.2, 0.1)], later, [[3, 3]]) });
      expect(t.facts.map((x) => x.describe())).toEqual(NO_ANSWER);
      expect([stoneNo(t, 3).sure, stoneNo(t, 3).bySpeckle]).toEqual([false, false]);
      expect(t.check()).toEqual([]);
    }
    // stone 5 is sure and on world stone 5: the same pair is kept and confirms it, with no fact (no score needed)
    for (const later of [[], [find(5, 5, null, null)]]) {
      const t = handMade({ 29: answerOf(27, [find(5, 5, 0.2, 0.1)], later, [[5, 5]]) });
      expect(t.facts.map((x) => x.describe())).toEqual(NO_ANSWER);
      expect([stoneNo(t, 5).status, stoneNo(t, 5).sure, stoneNo(t, 5).bySpeckle]).toEqual(["on", true, true]);
      expect(t.check()).toEqual([]);
    }
  });

  it("gives a pair's fact the score of its find and a margin when the find has a second", () => {
    // a find with a score and no second is no find of a WorldSpeckle (the readers leave such an answer out); the core
    // takes the frame as it is given: the fact has no margin. A score below the bar fails the self-check's C9.
    const of = (later: SpeckleFind): Tray => {
      const t = handMade({ 29: answerOf(27, [find(3, 3, 0.2, 0.1)], [later], [[3, 3]]) });
      expect([stoneNo(t, 3).sure, stoneNo(t, 3).bySpeckle]).toEqual([true, true]);
      return t;
    };
    const last = (t: Tray): TrayFact => factsOf(t, stoneNo(t, 3)).at(-1) as TrayFact;
    const t = of(find(3, 3, 0.6, null));
    expect([last(t).code, last(t).score, last(t).margin, last(t).bar]).toEqual([
      "speckle_same",
      600,
      null,
      SPECKLE_CLEAN,
    ]);
    expect(t.check()).toEqual([]);
    const low = of(find(3, 3, 0.25, 0.2));
    expect([last(low).score, last(low).margin]).toEqual([250, 50]);
    expect(last(low).describe()).toBe(
      "0:05.4 tray 1: stone s1t0.8-1-3 confirmed by its speckle on world stone 3 (0.250)",
    );
    expect(low.check()).toEqual(["C9"]);
  });
});
