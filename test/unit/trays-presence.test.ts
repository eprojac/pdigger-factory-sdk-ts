/**
 * Presence questions (SDK-DESIGN.md 4.6.1) beyond the golden files: every tray of the four presence recordings ends as
 * its generator says; a stone held in question reads as one and is sure again once it is seen; a settle at once holds
 * only if the next calm moment shows the stone; a stone with a look chain is never held in question; held stones, hand
 * deletes, revisions, a crowd of stones of its size and another stone's look keep a question from settling; the leaving
 * counts its own frame again when something could have changed the stone; and the frames the tray rules can not read
 * (the core's `gap()`, a replay's `gap` and `reset` lines, a live stream's `gap` and `reset` events) end the questions
 * open then. The rules themselves are golden-tested over `trays-presence-synthetic` (35 trays),
 * `trays-presence-looks-synthetic` (8 trays, with made-up looks), `trays-presence-attacks-synthetic` (28 trays) and
 * `trays-presence-attacks-looks-synthetic` (7 trays, with made-up looks). The rules no tray of those recordings
 * decides alone are tested on edited copies of them (the last block): probation after a settle by an earlier sight, the
 * settle's first and last sight within NEAR, a hand event with both hands free, frames the rules could not read inside
 * a static stop not yet taken, a lift of a stone read far from its places, the look test's limits (a look read before
 * the stone was last seen, a look no longer fresh, a look like a stone that is sure and not in question), the leaving's
 * same-frame rule with a look against, a freed push next to the stone; and a stream item of a kind this version does not
 * know.
 */
import { describe, expect, it, vi } from "vitest";
import {
  InterpreterCore,
  Replay,
  TrayQuestion,
  clock,
  type ClockAnchor,
  type Frame,
  type StreamItem,
  type Tray,
  type TrayFact,
  type TrayPoint,
  type TrayStone,
} from "pdigger-factory-sdk";
import { FakeFactory } from "pdigger-factory-sdk/testing";
import { classifyLine, linesOfBytes } from "../../src/recording.js";
import { all, clientOf } from "../helpers/fake.js";
import { FIXTURES, readBytes, readText } from "../helpers/fixtures.js";

const PRESENCE = "trays-presence-synthetic";
const LOOKS = "trays-presence-looks-synthetic";
const ATTACKS = "trays-presence-attacks-synthetic";
const ATTACK_LOOKS = "trays-presence-attacks-looks-synthetic";

/**
 * A tray as its generator writes it: its name there, the world ids of the stones that end sure (the leaving counts
 * exactly these), of those that end not sure, and of those among them whose `unsure` fact ends a question ("open
 * since", `opened` set); every other stone that ends not sure gets its fact at its doubt.
 */
type End = readonly [string, readonly number[], readonly number[], readonly number[]];

const ENDS: Readonly<Record<string, Readonly<Record<number, End>>>> = {
  [PRESENCE]: {
    1: ["CTRL", [101, 102, 103], [], []],
    2: ["MOT1", [202, 203], [201], [201]],
    3: ["MOT2", [302, 303], [301], [301]],
    4: ["MOT3", [402, 403], [401], []],
    5: ["NOW1", [502, 503], [501], [501]],
    6: ["GAP1", [602, 603], [601], [601]],
    7: ["REV1", [702, 703], [701], [701]],
    8: ["DROP1", [802, 803], [801, 804], []],
    9: ["PSAME", [902], [901, 903], [901]],
    10: ["DROP2", [1002, 1003], [1001, 1004], []],
    11: ["SIDE1", [1102, 1103], [1101], [1101]],
    12: ["T15", [1122, 1123], [1121], [1121]],
    13: ["T16", [1132], [1131], [1131]],
    14: ["T17", [1143], [1141, 1142], [1141]],
    15: ["Q1", [1501, 1502, 1503], [], []],
    16: ["Q2", [1602, 1603], [1601], []],
    17: ["Q3", [1702, 1703, 1704], [1701], []],
    18: ["QS", [1802, 1803], [1801, 1804], []],
    19: ["T13", [1903], [1901, 1902], []],
    20: ["T14", [2002], [2001], []],
    21: ["QP", [2102, 2103], [2101], []],
    22: ["PNEIGH", [2203], [2201, 2202], [2201]],
    23: ["LEAVE1", [2301, 2302, 2303], [], []],
    24: ["NOARR", [2401, 2402, 2403], [], []],
    25: ["PUSHX", [2502, 2503], [2501], [2501]],
    26: ["ORDER", [2603], [2601, 2602], [2602]],
    27: ["MINT", [2701, 2702], [2707], []],
    28: ["REVPUSH", [2802, 2803], [2801], [2801]],
    29: ["REVSAME", [2902, 2903], [2901], [2901]],
    30: ["CROWD", [3002, 3003], [3001], [3001]],
    31: ["ONCELOST", [3102, 3103], [3101], []],
    32: ["ONCETOUCH", [3202, 3203], [3201], []],
    33: ["CROWD1", [3302, 3303], [3301], [3301]],
    34: ["LVHAND", [3402, 3403], [3401], []],
    35: ["SETTLE3", [3501, 3502, 3503], [], []],
  },
  [LOOKS]: {
    1: ["LK1", [102, 103], [101], [101]],
    2: ["LK2", [202, 203], [201], [201]],
    3: ["LK0", [302, 303], [301], [301]],
    4: ["QE", [402, 403], [401], [401]],
    5: ["QL1", [501, 502, 503], [], []],
    6: ["QL2", [602, 603], [601], [601]],
    7: ["LKNOCH", [702, 703], [701, 704], [701, 704]],
    8: ["LKNOCH0", [801, 802, 803], [804], [804]],
  },
  [ATTACKS]: {
    1: ["CTRL", [101, 102, 103], [], []],
    2: ["NHELD", [202, 203, 204], [201], [201]],
    3: ["NHELDF", [302, 303], [301], [301]],
    4: ["XHELDD", [402, 403], [401], [401]],
    5: ["DELHF", [503], [501], [501]],
    6: ["DELCA", [602, 603], [601], [601]],
    7: ["DELHN", [702, 703], [701], [701]],
    8: ["REVHAND", [802, 803], [801], [801]],
    9: ["REVUNTR", [902, 903], [901], [901]],
    10: ["REVHELD", [1002, 1003], [1001], [1001]],
    11: ["REVLATE", [1101, 1102, 1103], [], []],
    12: ["REVMID", [1202, 1203], [1201], [1201]],
    13: ["MOTFS", [1302, 1303], [1301], [1301]],
    14: ["MOTS1", [1402, 1403], [1401], [1401]],
    15: ["ONCEMOT", [1502, 1503], [1501], []],
    16: ["ONCEBUSY", [1602, 1603], [1601], []],
    17: ["ONCEGAP", [1702, 1703], [1701], []],
    18: ["GAPC2", [1802, 1803], [1801], []],
    19: ["RENSWAP", [1902, 1903], [1901, 1904], [1901, 1904]],
    20: ["SMALLSW", [2002, 2003], [2001, 2004], [2001, 2004]],
    21: ["SMALLSWD", [2101, 2102, 2103, 2104], [], []],
    22: ["PUSHX1", [2202, 2203], [2201], [2201]],
    23: ["TWOQ", [2302, 2303], [2301, 2304], [2301]],
    24: ["NEWNEXT", [2401, 2402, 2403], [], []],
    25: ["LVBUSY", [2502, 2503], [2501], [2501]],
    26: ["LVHOLE", [2602, 2603], [2601], [2601]],
    27: ["LVUNTR", [2702, 2703], [2701], [2701]],
    28: ["LVPUSH", [2802], [2801, 2803], [2801]],
  },
  [ATTACK_LOOKS]: {
    1: ["LKSET", [102, 103], [101], [101]],
    2: ["LKONCE", [202, 203], [201], [201]],
    3: ["LKLIFT", [302, 303], [301], [301]],
    4: ["LKSWAPZ", [402, 403, 404], [401], [401]],
    5: ["LKSWAPZ0", [502, 503, 504], [501], [501]],
    6: ["LKGREY", [602, 603], [601], [601]],
    7: ["LKSWAPZG", [702, 703, 704], [701], [701]],
  },
};

const CASES = Object.entries(ENDS).flatMap(([name, trays]) =>
  Object.entries(trays).map(([n, end]) => [name, Number(n), end[0]] as const),
);

/** A world stone of a frame line, as JSON (the fields the edits below read). */
interface WorldStone {
  id: number;
  mode?: string;
  detected?: boolean;
  solid?: { pos: number[] };
  look?: unknown;
}

/** A recording line, as JSON (the fields the edits below read). */
interface Line {
  sse?: string;
  data?: unknown;
  g?: number;
  world?: {
    rev?: number;
    motion?: string;
    stones?: WorldStone[];
    events?: { type?: string; id?: number; why?: string; side?: string }[];
  } | null;
  [key: string]: unknown;
}

const byNumber = (a: number, b: number): number => a - b;
const golden = (name: string, part: string): string => readText(`golden/${name}.${part}`);
const textOf = (items: Iterable<{ describe(): string }>): string => [...items].map((x) => `${x.describe()}\n`).join("");
const factsOf = (trays: readonly Tray[]): TrayFact[] => trays.flatMap((t) => t.facts);
const replayOf = (name: string): Replay => Replay.fromBytes(readBytes(`recordings/${name}.ndjson.gz`));
const ndjson = (lines: readonly Line[]): string => lines.map((x) => `${JSON.stringify(x)}\n`).join("");

/** Every line of the recording, as JSON: new objects on every call. */
const recordingLines = (name: string): Line[] =>
  [...linesOfBytes(readBytes(`recordings/${name}.ndjson.gz`))]
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Line);

const kept = new Map<string, readonly Tray[]>();
/** Every tray of the recording (one replay per recording). */
function leftTrays(name: string): readonly Tray[] {
  let trays = kept.get(name);
  if (trays === undefined) kept.set(name, (trays = replayOf(name).traysSync()));
  return trays;
}

const trayOf = (name: string, n: number): Tray => leftTrays(name).find((t) => t.n === n) as Tray;

/** The tray stone first seen under that world id (`...-1-101`). */
function stoneOf(t: Tray, wid: number): TrayStone {
  const s = t.stones.find((x) => x.id.endsWith(`-${t.n}-${wid}`));
  if (s === undefined) throw new Error(`tray ${t.n} has no stone first seen under world id ${wid}`);
  return s;
}

/** The tray's `unsure` facts in fact order, by the world id their stone was first seen under. */
function unsureFacts(t: Tray): Map<number, TrayFact> {
  const out = new Map<number, TrayFact>();
  for (const f of t.facts) {
    if (f.kind === "unsure" && f.stone !== null) out.set(Number(f.stone.split("-")[2]), f);
  }
  return out;
}

const unsureOf = (t: Tray, wid: number): TrayFact => unsureFacts(t).get(wid) as TrayFact;
const leavingOf = (t: Tray): TrayPoint => {
  expect(t.leaving).not.toBeNull();
  return t.leaving as TrayPoint;
};

/** The frame of a frame line, as a replay reads it. */
function frameOf(x: Line): Frame {
  const line = classifyLine(x, true);
  if (line.kind !== "frame") throw new Error(`not a frame line: ${JSON.stringify(x).slice(0, 80)}`);
  return line.frame;
}

/**
 * A core fed the recording as a replay feeds it (its clock lines, its gap lines, its frames), with `gap()` after its
 * `gapAfter`-th frame; then its end.
 */
function fed(name: string, gapAfter: number | null = null): InterpreterCore {
  const core = new InterpreterCore();
  let n = 0;
  for (const x of recordingLines(name).slice(1)) {
    if (x.sse === "clock") core.setClock(x.data as ClockAnchor);
    else if (x.sse === "gap") core.gap();
    else {
      core.feed(frameOf(x));
      n += 1;
      if (n === gapAfter) core.gap();
    }
  }
  core.end();
  return core;
}

type View = readonly [number, TrayStone, Tray];
const seenViews = new Map<string, readonly View[]>();
/** Frame by frame while tray `n` is on: how many frames were fed, its stone first seen under `wid`, the tray. */
function views(name: string, n: number, wid: number): readonly View[] {
  const key = `${name} ${n} ${wid}`;
  let out = seenViews.get(key);
  if (out !== undefined) return out;
  const core = new InterpreterCore();
  const got: View[] = [];
  let k = 0;
  for (const frame of replayOf(name).framesSync()) {
    core.feed(frame);
    k += 1;
    const live = core.trays().at(-1);
    if (live !== undefined && live.n === n && live.leaving === null) got.push([k, stoneOf(live, wid), live]);
  }
  seenViews.set(key, (out = got));
  return out;
}

type Seen = readonly [boolean, boolean];
const SURE: Seen = [true, false];
const ASKED: Seen = [false, true];
const GIVEN_UP: Seen = [false, false];

/** The stone's (sure, in question) frame by frame while its tray is on, each change once. */
function states(name: string, n: number, wid: number): Seen[] {
  const seen = views(name, n, wid).map(([, s]): Seen => [s.sure, s.question !== null]);
  return seen.filter((x, i) => i === 0 || x[0] !== (seen[i - 1] as Seen)[0] || x[1] !== (seen[i - 1] as Seen)[1]);
}

let asked: number | null = null;
/** How many frames of `trays-presence-synthetic` were fed when tray 1's stone 101 first held its question. */
function inQuestion(): number {
  asked ??= (views(PRESENCE, 1, 101).find(([, s]) => s.question !== null) as View)[0];
  return asked;
}

/** The facts of every tray but the first, as text. */
const afterTheFirst = (trays: readonly Tray[]): string => textOf(factsOf(trays.slice(1)));

/** The stone's `unsure` fact, which must end its presence question of the doubt at 0:04.4 (tray 1's stone 101). */
function endedUnseen(t: Tray, wid: number): TrayFact {
  const fact = unsureOf(t, wid);
  expect([fact.why, fact.code]).toEqual(["not seen at two calm moments", "unseen"]);
  expect(fact.opened).not.toBeNull();
  expect(clock((fact.opened as TrayPoint).t)).toBe("0:04.4");
  expect(stoneOf(t, wid).sure).toBe(false);
  return fact;
}

/** The trays of a copy of the recording with every line after its header passed through `change` (null drops it). */
function edited(name: string, change: (x: Line) => Line | null): Tray[] {
  const [header, ...rest] = recordingLines(name);
  const out = [header as Line, ...rest.flatMap((x): Line[] => [change(x)].filter((y) => y !== null))];
  return Replay.fromText(ndjson(out)).traysSync();
}

/** `trays-presence-synthetic` with `line` after its `after`-th frame. */
function withLine(line: Line, after: number): Line[] {
  const out: Line[] = [];
  let n = 0;
  for (const x of recordingLines(PRESENCE)) {
    out.push(x);
    if ("g" in x && "cursor" in x && ++n === after) out.push(line);
  }
  return out;
}

/** World stone `wid` of a frame line (it must have it). */
function stoneIn(x: Line, wid: number): WorldStone {
  const s = x.world?.stones?.find((y) => y.id === wid);
  if (s === undefined) throw new Error(`no world stone ${wid} at g ${String(x.g)}`);
  return s;
}

/** The frame line carries world stone `wid`. */
const carries = (x: Line, wid: number): boolean => "g" in x && (x.world?.stones ?? []).some((y) => y.id === wid);

/** Moves the world stone `dx` along x. */
const shift = (s: WorldStone, dx: number): void => {
  (s.solid as { pos: number[] }).pos[0] = ((s.solid as { pos: number[] }).pos[0] as number) + dx;
};

/**
 * The recording's lines with `edit(x, kind, streak, k)` called on every frame line that carries world stone `wid`:
 * `kind` is D where the stone is detected and U where it is not, `streak` the number of that kind's run of frames (D1,
 * U1, D2, ...: each kind counted on its own), `k` the frame's place in it (from 1); `edit` returns the lines that take
 * the frame's place.
 */
function byStreak(name: string, wid: number, edit: (x: Line, kind: "D" | "U", streak: number, k: number) => Line[]) {
  const out: Line[] = [];
  const count = { D: 0, U: 0 };
  let prev: boolean | null = null;
  let k = 0;
  for (const x of recordingLines(name)) {
    if (!carries(x, wid)) {
      out.push(x);
      continue;
    }
    const det = stoneIn(x, wid).detected === true;
    const kind = det ? "D" : "U";
    if (det !== prev) {
      count[kind] += 1;
      k = 0;
    }
    prev = det;
    k += 1;
    out.push(...edit(x, kind, count[kind], k));
  }
  return out;
}

/** The index of the only frame line whose world stone `wid` carries a look. */
function lookLine(lines: readonly Line[], wid: number): number {
  const at = lines.flatMap((x, i) => (carries(x, wid) && stoneIn(x, wid).look !== undefined ? [i] : []));
  expect(at).toHaveLength(1);
  return at[0] as number;
}

/** Moves world stone `wid`'s look from line `from` to line `to`. */
function moveLook(lines: readonly Line[], wid: number, from: number, to: number): void {
  const a = stoneIn(lines[from] as Line, wid);
  stoneIn(lines[to] as Line, wid).look = a.look;
  delete a.look;
}

/** The trays of a recording given as its lines, and the one numbered `n`. */
function replayed(lines: readonly Line[], n: number): [Tray[], Tray] {
  const trays = Replay.fromText(ndjson(lines)).traysSync();
  return [trays, trays.find((t) => t.n === n) as Tray];
}

/** Every tray of `trays` but number `n` has the facts it has in the recording. */
function othersAsRecorded(trays: readonly Tray[], name: string, n: number): void {
  const rest = (ts: readonly Tray[]): Tray[] => ts.filter((t) => t.n !== n);
  expect(textOf(factsOf(rest(trays)))).toBe(textOf(factsOf(rest(leftTrays(name)))));
}

/** The stone's `unsure` fact, which must be a plain one: "not seen at two calm moments", ending no question. */
function plainUnseen(t: Tray, wid: number): TrayFact {
  const fact = unsureOf(t, wid);
  expect([fact.code, fact.why, fact.opened]).toEqual(["unseen", "not seen at two calm moments", null]);
  return fact;
}

describe("presence questions", () => {
  it("the recordings hold the trays of their generator", () => {
    for (const [name, trays] of Object.entries(ENDS)) {
      expect(
        leftTrays(name).map((t) => t.n),
        name,
      ).toEqual(Object.keys(trays).map(Number));
      for (const t of leftTrays(name)) expect(t.check(), `${name} tray ${t.n}`).toEqual([]);
    }
  });

  // the stones that end sure are on the tray, sure, out of question and without a fact `unsure`, and the leaving counts
  // exactly them; each of the others has one, which ends a question ("open since", `opened` set) exactly where the
  // stone was held in question, and else comes at its doubt
  it.each(CASES)("%s tray %i (%s) ends as its generator says", (name, n) => {
    const [, sure, notSure, held] = (ENDS[name] as Readonly<Record<number, End>>)[n] as End;
    const t = trayOf(name, n);
    const facts = unsureFacts(t);
    expect([...facts.keys()].sort(byNumber)).toEqual([...notSure].sort(byNumber));
    for (const wid of sure) {
      const s = stoneOf(t, wid);
      expect([s.status, s.sure, s.question], `${wid}`).toEqual(["on", true, null]);
    }
    for (const wid of notSure) {
      expect(stoneOf(t, wid).sure, `${wid}`).toBe(false);
      expect(unsureOf(t, wid).opened !== null, `${wid}`).toBe(held.includes(wid));
    }
    const leaving = t.facts.at(-1) as TrayFact;
    expect(leaving.kind).toBe("leaving");
    expect(leaving.sure).toBe(sure.length);
  });

  it("a stone held in question is not sure until it is seen again", () => {
    // tray 1: stone 101 is not seen at two calm moments while nothing could have changed it; it is in question (not
    // sure, `question` set, no fact) until the world sees it again on its place, and then sure again
    expect(states(PRESENCE, 1, 101)).toEqual([SURE, ASKED, SURE]);
    const [, s, live] = views(PRESENCE, 1, 101).find(([, x]) => x.question !== null) as View;
    const q = s.question as TrayQuestion;
    expect(q).toEqual(new TrayQuestion("unseen", "not seen at two calm moments", q.since, q.opened));
    expect([q.since, q.opened.g, clock(q.opened.t)]).toEqual([22, 22, "0:04.4"]);
    expect(s.toJSON().question).toEqual(q.toJSON());
    expect(live.facts.some((f) => f.kind === "unsure")).toBe(false);
    expect(live.check()).toEqual(expect.arrayContaining(["C1", "C4"])); // it has not left, and a question is open
    const one = leftTrays(PRESENCE)[0] as Tray;
    expect(stoneOf(one, 101).sure).toBe(true);
    expect(unsureFacts(one).size).toBe(0);
  });

  it("a question seen again before its doubt is settled at once", () => {
    // tray 15: stone 1501 is seen again on its place between the two calm moments that miss it, with nothing at work:
    // the doubt settles at once, so the stone is never in question; its next unseen run, which starts at that calm
    // moment, is on probation, and the calm moment that shows it again settles that run too: it stays sure
    expect(states(PRESENCE, 15, 1501)).toEqual([SURE]);
    expect(unsureFacts(trayOf(PRESENCE, 15)).size).toBe(0);
  });

  it("a question settled on a calm moment that does not show it is on probation", () => {
    // tray 35: stone 3501's question is settled by a sight between two calm moments, and the second does not show it:
    // sure again there, its next unseen run starts there on probation, and the calm moment after, which shows the
    // stone, settles that run too: it stays sure, with no fact
    expect(states(PRESENCE, 35, 3501)).toEqual([SURE, ASKED, SURE]);
    expect(unsureFacts(trayOf(PRESENCE, 35)).size).toBe(0);
  });

  // the stone is settled at once (never in question) and is sure until the next calm moment that shows it; when its run
  // on probation can not be settled there (the stone was lost meanwhile, its first sight was busy, the tray moved or
  // hands worked while it was out of sight, frames were dropped), it gets its fact `unsure` there, a plain one, and the
  // tray has not left yet
  it.each([
    ["lost", PRESENCE, 31, 3101],
    ["busy-first-sight", PRESENCE, 32, 3201],
    ["motion", ATTACKS, 15, 1501],
    ["hands", ATTACKS, 16, 1601],
    ["dropped-frames", ATTACKS, 17, 1701],
  ] as const)("a settle at once holds only if the next calm moment settles its run (%s)", (_case, name, n, wid) => {
    expect(states(name, n, wid)).toEqual([SURE, GIVEN_UP]);
    const t = trayOf(name, n);
    const fact = unsureOf(t, wid);
    expect([fact.code, fact.why, fact.opened]).toEqual(["unseen", "not seen at two calm moments", null]);
    expect(fact.t).toBeLessThan(leavingOf(t).t);
  });

  it("a question keeps its run and ends before the tray leaves", () => {
    // tray 12: the stone is seen at a calm moment after its question opened, then a hand works while it is out of
    // sight: the question keeps the run it was opened with, which that hand spoils, so it ends at the next settle and
    // not when the tray leaves; tray 14: at the leaving's step 1 the question that ends comes first, then the doubt of
    // the stone after it in tray order
    const twelve = trayOf(PRESENCE, 12);
    expect(unsureOf(twelve, 1121).t).toBeLessThan(leavingOf(twelve).t);
    expect([...unsureFacts(trayOf(PRESENCE, 14)).keys()]).toEqual([1141, 1142]);
  });

  it("the settle goes stone by stone and still tests a later reason", () => {
    // tray 26: stone 2601, first in tray order, was pushed while stone 2602 was in question and out of sight; one
    // settle gives both facts, 2601's first; tray 25: stone 2501, in question, was pushed and is still unseen: its own
    // later reason ends the question at that settle, with the question's cause and why, and not when the tray leaves
    const order = unsureFacts(trayOf(PRESENCE, 26));
    expect([...order.keys()]).toEqual([2601, 2602]);
    const [pushed, waiting] = [order.get(2601) as TrayFact, order.get(2602) as TrayFact];
    expect(pushed.t).toBe(waiting.t);
    expect([pushed.code, pushed.opened]).toEqual(["pushed", null]);
    expect(waiting.opened).not.toBeNull();
    const t = trayOf(PRESENCE, 25);
    const fact = unsureOf(t, 2501);
    expect([fact.code, fact.why]).toEqual(["unseen", "not seen at two calm moments"]);
    expect(fact.opened).not.toBeNull();
    expect(fact.t).toBeLessThan(leavingOf(t).t);
  });

  it("a stone added for certain was last seen where its world stone was first seen", () => {
    // tray 27: a slab a hand set down is added for certain, then not seen at two calm moments, seen once between them:
    // its last sight is its placing, where the hand worked, so the doubt is not a presence question (a plain fact)
    const t = trayOf(PRESENCE, 27);
    const kinds = t.facts.filter((f) => f.stone?.endsWith("-27-2707") === true).map((f) => [f.kind, f.certain]);
    expect(kinds).toEqual([
      ["added", true],
      ["unsure", null],
    ]);
    expect(unsureOf(t, 2707).opened).toBeNull();
  });

  // trays 30 and 33: a small stone in question is seen again on its place, but another stone of its size stands within
  // NEAR of that place at the settle (tray 30) or at its first sight (tray 33): a sight can not tell the two apart, so
  // the question is never settled and ends when the tray leaves
  it.each([
    ["at-the-settle", 30, 3001],
    ["at-its-first-sight", 33, 3301],
  ] as const)("a stone of its size near its place keeps the question open (%s)", (_case, n, wid) => {
    expect(states(PRESENCE, n, wid)).toEqual([SURE, ASKED]);
    const t = trayOf(PRESENCE, n);
    const fact = unsureOf(t, wid);
    expect(fact.opened).not.toBeNull();
    expect(fact.t).toBe(leavingOf(t).t);
  });

  it("a look of another open stone on its world stone ends the question", () => {
    // looks tray 7: stone 701 (no chain) is in question; its world stone is seen again on its place with the face of
    // stone 704, which is in question too: the look reaches the bar against 704's chain, so the sight does not settle
    // 701, and its question ends at that settle; looks tray 8: the same with a face that is not 804's (its chain scores
    // low on it): 801 is settled, 804 stays in question until the tray leaves
    expect(states(LOOKS, 7, 701)).toEqual([SURE, ASKED, GIVEN_UP]);
    const t = trayOf(LOOKS, 7);
    const fact = unsureOf(t, 701);
    expect(fact.opened).not.toBeNull();
    expect(fact.t).toBeLessThan(leavingOf(t).t);
    expect(stoneOf(t, 701).looks).toEqual([]);
    expect(states(LOOKS, 8, 801)).toEqual([SURE, ASKED, SURE]);
    const eight = trayOf(LOOKS, 8);
    expect(unsureOf(eight, 804).t).toBe(leavingOf(eight).t);
  });

  // a stone with a look chain that is not seen at two calm moments gets a question only a look settles: in question
  // from that doubt on, it is not settled by being seen again on its place; its fact ends the question when the tray
  // leaves; looks tray 4: still unseen at the next calm moment, the question's `since` grows to it
  it.each([
    [LOOKS, 4, 401],
    [LOOKS, 3, 301],
    [ATTACK_LOOKS, 4, 401],
  ] as const)("a stone with a chain is never held in question (%s tray %i)", (name, n, wid) => {
    const seen = views(name, n, wid).flatMap(([, s]) => (s.question === null ? [] : [s.question]));
    const first = seen[0] as TrayQuestion;
    expect(seen.length).toBeGreaterThan(0);
    for (const q of seen) expect([q.cause, q.opened]).toEqual(["unseen", first.opened]);
    expect(states(name, n, wid)).toEqual([SURE, ASKED]);
    const t = trayOf(name, n);
    expect(stoneOf(t, wid).looks.length).toBeGreaterThan(0);
    const fact = unsureOf(t, wid);
    expect(fact.opened?.g).toBe(first.opened.g); // the views feed no clock lines: no wall there
    expect(fact.t).toBe(leavingOf(t).t);
    if (name === LOOKS && n === 4) {
      expect(new Set(seen.map((q) => q.since)).size).toBe(2);
      expect((seen.at(-1) as TrayQuestion).since).toBeGreaterThan(first.since);
    }
  });

  it("a world stone held or taken by a hand makes a busy frame", () => {
    // attack trays 2 and 6: while stone 201 is in question and out of sight, the brick next to it reads `carry` (tray
    // 2), or the one next to 601 is deleted, why `carried-away` (tray 6), with both hands free and no hand event: busy
    // frames, so neither question is settled; the same recording with that brick `kept`, and that delete why `absent`:
    // both settled, every other tray the recording's
    const calm = (x: Line): Line => {
      for (const s of x.world?.stones ?? []) if (s.id === 204) s.mode = "kept";
      for (const e of x.world?.events ?? []) if (e.id === 604 && e.why === "carried-away") e.why = "absent";
      return x;
    };
    const trays = edited(ATTACKS, calm);
    for (const [n, wid] of [
      [2, 201],
      [6, 601],
    ] as const) {
      expect(stoneOf(trayOf(ATTACKS, n), wid).sure).toBe(false);
      const t = trays[n - 1] as Tray;
      expect(stoneOf(t, wid).sure).toBe(true);
      expect(unsureFacts(t).size).toBe(0);
    }
    const rest = (ts: readonly Tray[]): Tray[] => ts.filter((t) => t.n !== 2 && t.n !== 6);
    expect(textOf(factsOf(rest(trays)))).toBe(textOf(factsOf(rest(leftTrays(ATTACKS)))));
  });

  it("every revision is a frame the rules could not read", () => {
    // tray 29: a frame inside stone 2901's unseen run comes again as a revision that changes nothing: the next frame
    // counts as one after frames the rules could not read, so the question ends ("open since"); without that revision
    // the stone is seen again and sure, and every other tray is the recording's
    expect(unsureOf(trayOf(PRESENCE, 29), 2901).opened).not.toBeNull();
    const revision = recordingLines(PRESENCE).find(
      (x) => x.world?.rev === 1 && (x.world.stones ?? []).some((s) => s.id === 2901),
    )?.g;
    expect(revision).toBeDefined();
    const trays = edited(PRESENCE, (x) => (x.g === revision && (x.world?.rev ?? 0) > 0 ? null : x));
    const t = trays[28] as Tray;
    expect(stoneOf(t, 2901).sure).toBe(true);
    expect(unsureFacts(t).size).toBe(0);
    const rest = (ts: readonly Tray[]): Tray[] => ts.filter((x) => x.n !== 29);
    expect(textOf(factsOf(rest(trays)))).toBe(textOf(factsOf(rest(leftTrays(PRESENCE)))));
  });

  // attack trays 25-28: stone X is not detected at the last calm moment, whose frame is the tray's last, after hands
  // worked, frames were dropped, a hand was flagged untrusted or a stone was pushed while it was out of sight: the
  // leaving counts that frame again, so X's question opens and ends there ("open since" the leaving itself); tray 23
  // of `trays-presence-synthetic`, where nothing happened: the frame is not counted twice, the stone stays sure
  it.each([
    ["hands", 25],
    ["dropped-frames", 26],
    ["untrusted", 27],
    ["push", 28],
  ] as const)("the leaving counts its own frame again when something could have changed the stone (%s)", (_case, n) => {
    const t = trayOf(ATTACKS, n);
    const fact = unsureOf(t, n * 100 + 1);
    expect(fact.opened).toEqual(leavingOf(t));
    expect(fact.t).toBe(leavingOf(t).t);
    expect(unsureFacts(trayOf(PRESENCE, 23)).size).toBe(0);
  });

  it("the leaving refuses the question of a stone a hand handled since its last sight", () => {
    // tray 34: a hand lifted and set down stone 3401 while it was not detected, and the last calm moment, the tray's
    // last frame, does not show it: the leaving counts that frame again, and the doubt there is no question (a hand
    // handled it since its last sight): a plain fact at the leaving
    const t = trayOf(PRESENCE, 34);
    const fact = unsureOf(t, 3401);
    expect([fact.code, fact.opened, fact.t]).toEqual(["unseen", null, leavingOf(t).t]);
  });

  it("the core's gap() ends the questions open then", () => {
    // `InterpreterCore.gap()` while stone 101 of tray 1 is in question: the next frame comes after frames the rules
    // could not read, so the question ends at the next settle with the fact `unsure` ("open since" its doubt); without
    // it the stone is seen again and sure; every other tray is the recording's
    const trays = fed(PRESENCE, inQuestion() + 2).trays();
    endedUnseen(trays[0] as Tray, 101);
    expect([...unsureFacts(trays[0] as Tray).keys()]).toEqual([101]);
    expect(afterTheFirst(trays)).toBe(afterTheFirst(leftTrays(PRESENCE)));
    expect(textOf(factsOf(fed(PRESENCE).trays()))).toBe(golden(PRESENCE, "trays.txt"));
  });

  it.each([
    ["reset", { sse: "reset", data: { boot: "0123456789", cursor: 7 }, recv: 1794960004.8 }],
    ["gap", { sse: "gap", data: { gap: 2 } }],
  ] as const)("a replay's %s line ends the questions open then", async (_case, line) => {
    const text = ndjson(withLine(line, inQuestion() + 2));
    const sync = Replay.fromText(text).traysSync();
    const streamed = await (await Replay.open(new TextEncoder().encode(text))).trays();
    for (const trays of [sync, streamed]) {
      endedUnseen(trays[0] as Tray, 101);
      expect(afterTheFirst(trays)).toBe(afterTheFirst(leftTrays(PRESENCE)));
    }
  });

  // a side line that does not decode is a line a reader does not understand (section 6): ignored
  it.each([
    ["reset-boot-a-number", { sse: "reset", data: { boot: 5, cursor: 7 } }],
    ["gap-not-whole", { sse: "gap", data: { gap: 1.5 } }],
    ["gap-recv-a-string", { sse: "gap", data: { gap: 2 }, recv: "late" }],
  ] as const)("a gap or reset line that does not decode changes no tray (%s)", (_case, line) => {
    const replay = Replay.fromText(ndjson(withLine(line, inQuestion() + 2)));
    expect(textOf(replay.trayFactsSync())).toBe(golden(PRESENCE, "trays.txt"));
  });

  // the Interpreter tells its core about a `gap` or `reset` event of its stream (`gap()`)
  it.each([
    ["reset", { boot: "other", cursor: 3 }],
    ["gap", { gap: 2 }],
  ] as const)("a live stream's %s ends the questions open then", async (event, data) => {
    const fake = await FakeFactory.create({
      recording: withLine({ sse: event, data }, inQuestion() + 2),
      replies: `${FIXTURES}api`,
      endOfData: "close",
    });
    const interpreter = clientOf(fake).interpreter({ resume: false });
    const got = await all(interpreter.trayFacts());
    const trays = interpreter.trays();
    expect(got).toContainEqual(endedUnseen(trays[0] as Tray, 101));
    expect(afterTheFirst(trays)).toBe(afterTheFirst(leftTrays(PRESENCE)));
    fake.close();
  });
});

// Each test below edits a copy of a recording so that one rule of 4.6.1 that no tray of the recordings decides alone
// decides how a tray ends (the TypeScript and the Python SDK give the same eight parts on every one of these copies)
describe("presence questions on edited recordings", () => {
  // tray 35 (SETTLE3): stone 3501's question is settled at c3 by its sight between c2 and c3, and c3 does not show it,
  // so its next unseen run starts at c3, on probation; edited, a hand lifts 3501 on the second frame it is seen after
  // c3, after a clean first sight: at c4, which shows the stone, something could have changed it since it was last seen
  // before that run (the run's s1), so the probation fails there: a plain fact, before the tray leaves
  it("probation after a settle by an earlier sight fails when a hand handled the stone before the next calm moment", () => {
    const [trays, t] = replayed(
      byStreak(PRESENCE, 3501, (x, kind, streak, k) => {
        if (kind === "D" && streak === 3 && k === 2) x.world?.events?.push({ type: "lift", id: 3501, side: "left" });
        return [x];
      }),
      35,
    );
    expect([...unsureFacts(t).keys()]).toEqual([3501]);
    expect(plainUnseen(t, 3501).t).toBeLessThan(leavingOf(t).t);
    expect(stoneOf(t, 3501).sure).toBe(false);
    othersAsRecorded(trays, PRESENCE, 35);
  });

  // tray 1 (CTRL), stone 101 in question from its doubt at 0:04.4: edited, its first sight after that doubt is 0.20 to
  // the right of where it was last seen (on its place again from the next frame on), or it is first seen on its place
  // and then 0.20 to the right from the third frame of that sight on: the first sight, and the last, must be within
  // NEAR (0.12) of that place, so the question is never settled and ends when the tray leaves
  it.each([
    ["the first sight", (k: number) => k === 1],
    ["the last sight", (k: number) => k >= 3],
  ] as const)("%s further than NEAR from the stone's last place does not settle its question", (_case, far) => {
    const [trays, t] = replayed(
      byStreak(PRESENCE, 101, (x, kind, streak, k) => {
        if (kind === "D" && streak === 2 && far(k)) shift(stoneIn(x, 101), 0.2);
        return [x];
      }),
      1,
    );
    expect(endedUnseen(t, 101).t).toBe(leavingOf(t).t);
    expect([...unsureFacts(t).keys()]).toEqual([101]);
    othersAsRecorded(trays, PRESENCE, 1);
  });

  // tray 1: a `lift` of stone 103 (1.2 from 101) on the last frame of 101's unseen run, after its doubt, both hands
  // reading free: a hand event anywhere on the tray makes the frame busy, and a busy frame spoils 101's run (its world
  // stone is not detected there), so 101's question ends at the next settle, before the tray leaves
  it("a hand event with both hands free makes a busy frame", () => {
    const [trays, t] = replayed(
      byStreak(PRESENCE, 101, (x, kind, streak, k) => {
        if (kind === "U" && streak === 1 && k === 10) x.world?.events?.push({ type: "lift", id: 103, side: "left" });
        return [x];
      }),
      1,
    );
    expect(endedUnseen(t, 101).t).toBeLessThan(leavingOf(t).t);
    expect([...unsureFacts(t).keys()]).toEqual([101]);
    expect(stoneOf(t, 103).sure).toBe(true);
    othersAsRecorded(trays, PRESENCE, 1);
  });

  // tray 1: stone 101 not detected from the 10th frame of the tray's stop on, with a `gap` line before that frame,
  // while the stop is still held back (it has not yet lasted STOP_MIN): the frames the rules could not read count at
  // the frame they precede when the stop is taken, a busy and a push frame after 101's last sight, so its first sight
  // after its doubt is not clean and its question ends when the tray leaves
  it("frames the rules could not read inside a stop not yet taken count at the frame they precede", () => {
    const lines = byStreak(PRESENCE, 101, (x, kind, streak, k) => {
      if (kind !== "D" || streak !== 1 || k < 10) return [x];
      stoneIn(x, 101).detected = false;
      return k === 10 ? [{ sse: "gap", data: { gap: 2 } }, x] : [x];
    });
    const frames = lines.filter((x) => "g" in x);
    const gapAt = lines.findIndex((x) => x.sse === "gap");
    const tenth = lines[gapAt + 1] as Line;
    expect(frames.indexOf(tenth)).toBe(9); // the stop's 10th frame (101 is seen from the first)
    expect((tenth.t as number) - ((frames[0] as Line).t as number)).toBeLessThan(2); // STOP_MIN: still held back
    const [trays, t] = replayed(lines, 1);
    expect(endedUnseen(t, 101).t).toBe(leavingOf(t).t);
    expect([...unsureFacts(t).keys()]).toEqual([101]);
    othersAsRecorded(trays, PRESENCE, 1);
  });

  // tray 1: on the frame after stone 101's first sight after its doubt, the world reads 101 0.50 to the right, further
  // than HAND_R from where it was last seen and from its place at the settle, with a `lift` of it (on its place again
  // from the next frame on): the hand mark of that lift lies too far to count, but the lift handled the stone, so
  // something could have changed it since its last sight and its question ends at the next settle
  it("a lift of the stone read further than HAND_R from its places still ends its question", () => {
    const [trays, t] = replayed(
      byStreak(PRESENCE, 101, (x, kind, streak, k) => {
        if (kind === "D" && streak === 2 && k === 2) {
          shift(stoneIn(x, 101), 0.5);
          x.world?.events?.push({ type: "lift", id: 101, side: "left" });
        }
        return [x];
      }),
      1,
    );
    expect(endedUnseen(t, 101).t).toBeLessThan(leavingOf(t).t);
    expect([...unsureFacts(t).keys()]).toEqual([101]);
    othersAsRecorded(trays, PRESENCE, 1);
  });

  // looks tray 7 (LKNOCH): stone 701 (no chain) and stone 704 (a chain, 0.35 from it) are not seen at c1 and c2; 701's
  // world stone is seen again on its place with 704's face, which ends 701's question (the recording); edited: that
  // look read on the frame 701 was last seen before it went unseen (a look read before or when the stone was last seen
  // does not count), or one frame later where the world reads 701 0.50 to the left, on its place again after (at the
  // settle that look is no longer fresh: its world stone stands further than NEAR from where it was read), or with 704
  // detected on every frame (sure and never in question, so not a stone the look step pairs looks for): 701 is settled
  // by its sight and ends sure; 704 ends in question as in the recording, or sure where it is seen throughout
  it.each([
    ["read when the stone was last seen", "s1"],
    ["no longer fresh", "stale"],
    ["like a stone that is sure and not in question", "sure"],
  ] as const)("a look %s does not stop the settle", (_case, edit) => {
    const lines = recordingLines(LOOKS);
    const at = lookLine(lines, 701);
    const seen = lines.flatMap((x, i) => (carries(x, 701) ? [i] : []));
    if (edit === "s1") {
      const lastSight = seen[seen.findIndex((i) => stoneIn(lines[i] as Line, 701).detected !== true) - 1] as number;
      moveLook(lines, 701, at, lastSight);
    } else if (edit === "stale") {
      moveLook(lines, 701, at, at + 1);
      shift(stoneIn(lines[at + 1] as Line, 701), -0.5);
    } else for (const x of lines) if (carries(x, 704)) stoneIn(x, 704).detected = true;
    const [trays, t] = replayed(lines, 7);
    expect(unsureOf(trayOf(LOOKS, 7), 701).opened).not.toBeNull(); // the recording: the look ends 701's question
    expect([stoneOf(t, 701).status, stoneOf(t, 701).sure, stoneOf(t, 701).question]).toEqual(["on", true, null]);
    expect([...unsureFacts(t).keys()]).toEqual(edit === "sure" ? [] : [704]);
    if (edit !== "sure") expect(unsureOf(t, 704).t).toBe(leavingOf(t).t);
    expect((t.facts.at(-1) as TrayFact).sure).toBe(edit === "sure" ? 4 : 3);
    othersAsRecorded(trays, LOOKS, 7);
  });

  // looks tray 7, edited: stone 701 seen at c1, c2 and c3 (never in question) and not detected from the breaker frame
  // before c4 on, its world stone's look (704's face; 704 in question) read on that frame, and the tray's last frame
  // c4's own (the next frame moving): at c4 701 is not seen once; at the leaving that look, read since 701 was last seen
  // and still fresh, reaches the bar against 704's chain, so something could have changed 701: the leaving counts c4's
  // frame again, and the doubt there is no presence question (a plain fact at the leaving); without that look the
  // frame is not counted twice and 701 stays sure
  it.each([
    ["a fresh look against another open stone counts it again", true],
    ["without that look it is not counted twice", false],
  ] as const)("the leaving's own frame: %s", (_case, look) => {
    const lines = recordingLines(LOOKS);
    const at = lookLine(lines, 701);
    const tray = lines.flatMap((x, i) => (carries(x, 701) && x.world?.motion === "static" ? [i] : []));
    const last = tray.at(-1) as number;
    const breaker = tray.filter((i) => (lines[i]?.world?.events ?? []).some((e) => e.type === "new")).at(-1) as number;
    for (const i of tray) stoneIn(lines[i] as Line, 701).detected = i < breaker;
    if (look) moveLook(lines, 701, at, breaker);
    else delete stoneIn(lines[at] as Line, 701).look;
    (lines[last]?.world as { motion: string }).motion = "moving";
    const [trays, t] = replayed(lines, 7);
    expect(leavingOf(t).g).toBe((lines[tray.at(-2) as number] as Line).g); // its last frame is its last calm moment
    expect([...unsureFacts(t).keys()]).toEqual(look ? [701, 704] : [704]);
    if (look) expect(plainUnseen(t, 701).t).toBe(leavingOf(t).t);
    else expect(stoneOf(t, 701).sure).toBe(true);
    expect(unsureOf(t, 704).opened).not.toBeNull();
    expect((t.facts.at(-1) as TrayFact).sure).toBe(look ? 2 : 3);
    othersAsRecorded(trays, LOOKS, 7);
  });

  // trays-looks-synthetic tray 14: stone 410 is recognised by its look on world stone 430, which frees world stone 410,
  // and a push of that world stone makes stone 432, 0.35 from it, the neighbour of a freed push; edited: 432 has no look
  // (no chain), is not detected from that recognition on but on the push frame (so its run is not spoilt), and the push
  // has no side (no hand mark next to 432): at the calm moment after the push 432 is not seen a second time, and the
  // freed push next to it makes that doubt a plain fact there; without the push it is a presence question, which ends
  // later ("open since" that calm moment)
  it.each([
    ["with a freed push next to it, a plain fact", true],
    ["without the push, a presence question", false],
  ] as const)("a stone not seen at two calm moments: %s", (_case, pushed) => {
    const lines = recordingLines("trays-looks-synthetic");
    const tray = lines.flatMap((x, i) => (carries(x, 432) ? [i] : []));
    delete stoneIn(lines[tray[0] as number] as Line, 432).look;
    const push = tray.find((i) => (lines[i]?.world?.events ?? []).some((e) => e.type === "push" && e.id === 410));
    const freed = tray.find((i) => carries(lines[i] as Line, 430) && stoneIn(lines[i] as Line, 430).look !== undefined);
    const events = (lines[push as number] as Line).world?.events ?? [];
    for (const e of events) delete e.side;
    if (!pushed) events.splice(0, events.length);
    for (const i of tray) if (i >= (freed as number) && i !== push) stoneIn(lines[i] as Line, 432).detected = false;
    const [trays, t] = replayed(lines, 14);
    const recognised = t.facts.find((f) => f.kind === "identified");
    expect(recognised?.worldId).toBe(430);
    const fact = unsureOf(t, 432);
    const after = (lines[push as number] as Line).g as number;
    if (pushed) expect(plainUnseen(t, 432).g).toBeGreaterThan(after);
    else expect([fact.code, fact.opened !== null && fact.opened.g > after]).toEqual(["unseen", true]);
    expect(fact.t).toBeLessThan(leavingOf(t).t);
    othersAsRecorded(trays, "trays-looks-synthetic", 14);
  });

  // the Interpreter's pump counts a `gap` or `reset` item of its stream as frames the rules could not read, and nothing
  // else: an item of a kind this version does not know is ignored, while a `gap` item at the same place ends tray 1's
  // question
  it.each([
    ["of a kind this version does not know is ignored", { kind: "later" }, false],
    ["`gap` ends the question", { kind: "gap", count: 1 }, true],
  ] as const)("a live stream's item after the doubt: %s", async (_case, item, ends) => {
    const fake = await FakeFactory.create({
      recording: recordingLines(PRESENCE),
      replies: `${FIXTURES}api`,
      endOfData: "close",
    });
    const client = clientOf(fake);
    const frames = client.streams.frames.bind(client.streams);
    vi.spyOn(client.streams, "frames").mockImplementation(async function* (options) {
      let n = 0;
      for await (const x of frames(options)) {
        yield x;
        if (x.kind === "frame" && ++n === inQuestion() + 2) yield item as unknown as StreamItem;
      }
    });
    const interpreter = client.interpreter({ resume: false });
    await all(interpreter.trayFacts());
    const trays = interpreter.trays();
    if (ends) endedUnseen(trays[0] as Tray, 101);
    else expect(textOf(factsOf(trays))).toBe(golden(PRESENCE, "trays.txt"));
    expect(afterTheFirst(trays)).toBe(afterTheFirst(leftTrays(PRESENCE)));
    fake.close();
  });
});
