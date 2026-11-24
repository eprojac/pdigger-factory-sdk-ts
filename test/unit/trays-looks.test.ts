/**
 * The tray rules by look (SDK-DESIGN.md 4.6.3-4.6.10) beyond the golden files: the self-check finds each broken code on
 * accounts made broken on purpose, the open account and a live question as values, and the permille text. The rules
 * themselves are golden-tested over `trays-looks-synthetic` (every rule by look) and the real excerpts.
 */
import { describe, expect, it } from "vitest";
import {
  InterpreterCore,
  Replay,
  Tray,
  TrayCandidate,
  TrayFact,
  TrayOpen,
  TrayQuestion,
  TrayStone,
  describeOpenTxt,
  type StoneLook,
  type TrayFactInit,
  type TrayInit,
  type TrayOpenInit,
  type TrayStoneInit,
} from "pdigger-factory-sdk";
import { milli } from "../../src/interpreter/text.js";
import { sinceOf, unscored } from "../../src/interpreter/trays.js";
import { readBytes, readJson } from "../helpers/fixtures.js";
import { mkFrame, stone } from "../helpers/frames.js";

const LOOKS = "trays-looks-synthetic";
const replay = (): Replay => Replay.fromBytes(readBytes(`recordings/${LOOKS}.ndjson.gz`));

let kept: readonly Tray[] | null = null;
const leftTrays = (): readonly Tray[] => (kept ??= replay().traysSync());
const tray = (n: number): Tray => leftTrays().find((t) => t.n === n) as Tray;
/** The tray stone whose id ends with that world id (`...-13-301`). */
const stoneOf = (t: Tray, wid: number): TrayStone => t.stones.find((s) => s.id.endsWith(`-${t.n}-${wid}`)) as TrayStone;
const entry = (t: Tray, id: string): TrayOpen => (t.open ?? []).find((o) => o.stone === id) as TrayOpen;

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

function withStone(t: Tray, s: TrayStone, change: Partial<TrayStoneInit>): string[] {
  const stones = t.stones.map((x) => (x.id === s.id ? new TrayStone({ ...x, ...change }) : x));
  return remake(t, { stones }).check();
}

/** The tray with one open entry of its leaving fact changed. */
function withEntry(t: Tray, id: string, change: Partial<TrayOpenInit>): string[] {
  const leave = t.facts.at(-1) as TrayFact;
  const open = (leave.open ?? []).map((o) => (o.stone === id ? new TrayOpen({ ...o, ...change }) : o));
  return withFacts(t, [...t.facts.slice(0, -1), fact(leave, { open })]);
}

const candidate = (kind: TrayCandidate["kind"], worldId: number | null, id: string | null): TrayCandidate =>
  new TrayCandidate({ kind, worldId, stone: id, score: null, why: null });
const synthetic = (name: string): StoneLook =>
  readJson<{ looks: Record<string, StoneLook> }>("looks/looks-synthetic.json").looks[name] as StoneLook;

describe("trays by look", () => {
  it("every left tray checks clean", () => {
    expect(leftTrays().map((t) => t.n)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    for (const t of leftTrays()) expect(t.check(), `tray ${t.n}`).toEqual([]);
  });

  it("the certain facts with looks are the first of v1's", () => {
    // 4.6.7: on each tray the same certain facts on the same frames, up to where the tray is relinked; the copy of the
    // recording without any look is v1
    const certain = (trays: readonly Tray[]): Map<number, string[]> => {
      const by = new Map<number, string[]>();
      for (const t of trays)
        by.set(
          t.n,
          t.facts.filter((f) => f.certain === true).map((f) => `${f.kind} ${f.stone} ${f.g} ${f.code}`),
        );
      return by;
    };
    const looks = certain(leftTrays());
    const v1 = certain(Replay.fromBytes(readBytes(`recordings/${LOOKS}-nolooks.ndjson.gz`)).traysSync());
    expect([...looks.keys()]).toEqual([...v1.keys()]);
    const held = new Map<number, number>();
    for (const [n, mine] of looks) {
      const theirs = v1.get(n) as string[];
      expect(mine, `tray ${n}`).toEqual(theirs.slice(0, mine.length));
      if (theirs.length > mine.length) held.set(n, theirs.length - mine.length);
    }
    // tray 2 a swap, 10 a stone linked by its look, 30 twins, 31 a look that changed (no hand took 15's X: v1
    // leaves its loss unclear too)
    expect(Object.fromEntries(held)).toEqual({ 2: 1, 10: 1, 30: 3, 31: 1 });
  });

  it("C1: the facts run from arrived to leaving", () => {
    const t = tray(13);
    const never = new Tray({
      session: t.session,
      video: t.video,
      n: 99,
      arrived: null,
      leaving: null,
      stones: [],
      facts: [],
    });
    expect(never.check()).toEqual([]); // a tray that never arrived passes
    expect(withFacts(t, t.facts.slice(0, -1))).toContain("C1"); // not left yet: no leaving fact
    expect(withFacts(t, [])).toContain("C1");
    expect(withFacts(t, [...t.facts, t.facts.at(-1) as TrayFact])).toContain("C1"); // a fact after the leaving
    expect(withFacts(t, t.facts.slice(1))).toContain("C1"); // no arrival first
  });

  it("C2: ids are unique and every fact names a stone of the tray", () => {
    const t = tray(13);
    expect(remake(t, { stones: [...t.stones, t.stones[0] as TrayStone] }).check()).toContain("C2");
    const facts = [...t.facts];
    const named = facts.findIndex((x) => x.stone !== null);
    facts[named] = fact(facts[named] as TrayFact, { stone: "nobody" });
    expect(withFacts(t, facts)).toContain("C2");
  });

  it("C3: each stone's facts come in order", () => {
    const t = tray(13);
    const pushed = stoneOf(t, 301); // unsure (pushed) at the leaving
    const unsure = t.facts.find((x) => x.kind === "unsure" && x.stone === pushed.id) as TrayFact;
    const i = t.facts.indexOf(unsure);
    const head = t.facts.slice(0, i + 1);
    const tail = t.facts.slice(i + 1);
    expect(withFacts(t, [...head, fact(unsure, { code: "pushed" }), ...tail])).toContain("C3"); // two unsure facts
    const added = fact(unsure, { kind: "added", certain: false });
    expect(withFacts(t, [...head, added, ...tail])).toContain("C3"); // an addition after its first fact
    const found = fact(unsure, { kind: "identified", certain: null, score: 900, bar: 750 });
    expect(withFacts(t, [...head, found, ...tail])).toContain("C3"); // identified after unsure
    const gone = fact(unsure, { kind: "removed", certain: false });
    expect(withFacts(t, [...head, gone, gone, ...tail])).toContain("C3"); // two removals, a fact after a removal
    const ten = tray(10);
    const removed = ten.facts.find((x) => x.kind === "removed") as TrayFact;
    const j = ten.facts.indexOf(removed);
    const late = fact(removed, { kind: "identified", certain: null, score: 900, bar: 750 });
    expect(withFacts(ten, [...ten.facts.slice(0, j + 1), late, ...ten.facts.slice(j + 1)])).toContain("C3");
  });

  it("C4: the final state matches the facts", () => {
    const t = tray(13);
    const sure = stoneOf(t, 292);
    expect([sure.status, sure.sure]).toEqual(["on", true]);
    expect(withStone(t, sure, { status: "removed", worldId: null })).toContain("C4"); // removed with no removal
    expect(withStone(t, sure, { sure: false })).toContain("C4"); // not sure with no unsure fact
    const question = new TrayQuestion("pushed", "it was pushed", 120, { g: 119, t: 23.8, wall: null });
    expect(withStone(t, sure, { question })).toContain("C4"); // a question still open
    const ten = tray(10);
    const gone = ten.stones.find((s) => s.status === "removed") as TrayStone;
    expect(withStone(ten, gone, { certain: true })).toContain("C4"); // the removal unclear, the stone certain
  });

  it("C5: the counts and the open list", () => {
    const t = tray(13);
    const first = t.facts[0] as TrayFact;
    const leave = t.facts.at(-1) as TrayFact;
    const but = (x: TrayFact): TrayFact[] => [...t.facts.slice(0, -1), x];
    expect(withFacts(t, [fact(first, { stones: (first.stones as number) + 1 }), ...t.facts.slice(1)])).toContain("C5");
    expect(withFacts(t, but(fact(leave, { sure: (leave.sure as number) + 1 })))).toContain("C5");
    expect(withFacts(t, but(fact(leave, { open: [] })))).toContain("C5");
    expect(withFacts(t, but(fact(leave, { open: null })))).toContain("C5");
  });

  it("C5: one open entry per open stone, in tray order", () => {
    const t = tray(13);
    const leave = t.facts.at(-1) as TrayFact;
    const [a, b, ...rest] = leave.open ?? [];
    expect(t.check()).toEqual([]);
    const but = (open: TrayOpen[]): TrayFact[] => [...t.facts.slice(0, -1), fact(leave, { open })];
    expect(withFacts(t, but([a, b, ...rest, a] as TrayOpen[]))).toEqual(["C5"]); // one stone twice
    expect(withFacts(t, but([b, a, ...rest] as TrayOpen[]))).toEqual(["C5"]); // out of tray order
    // an id on the tray twice (C2): each stone is open or settled by itself (4.6.8), so an open copy of a sure stone
    // needs its own entry
    const sure = stoneOf(t, 291);
    expect([sure.status, sure.sure]).toEqual(["on", true]);
    const copy = new TrayStone({ ...sure, sure: false, added: true, certain: false, worldId: 99999 });
    const twin = remake(t, { stones: [...t.stones, copy] });
    const added = (leave.open ?? []).find((o) => o.kind === "added") as TrayOpen;
    const stones = (leave.stones as number) + 1;
    const listed = fact(leave, { stones, open: [...(leave.open ?? []), new TrayOpen({ ...added, stone: sure.id })] });
    expect(withFacts(twin, [...t.facts.slice(0, -1), listed])).toEqual(["C2"]);
    expect(withFacts(twin, [...t.facts.slice(0, -1), fact(leave, { stones })])).toEqual(["C2", "C5"]);
  });

  it("C6: world ids are unique on the tray", () => {
    const t = tray(13);
    const a = stoneOf(t, 292);
    const b = stoneOf(t, 294);
    expect(withStone(t, a, { worldId: b.worldId })).toContain("C6");
    expect(withStone(t, a, { worldId: null })).toContain("C6");
  });

  it("C7: the open entries are well formed", () => {
    const t = tray(13);
    const unsure = stoneOf(t, 301).id;
    const added = stoneOf(t, 311).id;
    expect(withEntry(t, unsure, { cause: "no such cause" })).toContain("C7");
    expect(withEntry(t, unsure, { look: "no such look" })).toContain("C7");
    expect(withEntry(t, unsure, { kind: "leaving" as TrayOpenInit["kind"] })).toContain("C7"); // no open kind
    expect(withEntry(t, unsure, { candidates: [] })).toContain("C7");
    const twice = entry(t, unsure).candidates;
    expect(withEntry(t, unsure, { candidates: [...twice, twice[0] as TrayCandidate] })).toContain("C7");
    expect(withEntry(t, unsure, { candidates: twice.slice(1) })).toContain("C7"); // its own world stone is not first
    expect(withEntry(t, unsure, { candidates: twice.filter((c) => c.kind !== "gone") })).toContain("C7");
    expect(withEntry(t, added, { candidates: entry(t, added).candidates.slice(0, -1) })).toContain("C7"); // no "new"
    const ten = tray(10);
    const removed = entry(ten, (ten.stones.find((s) => s.status === "removed") as TrayStone).id);
    expect(withEntry(ten, removed.stone, { candidates: removed.candidates.slice(0, -1) })).toContain("C7"); // no "unseen"
  });

  it("C8: a candidate is never a settled stone", () => {
    const t = tray(13);
    const added = entry(t, stoneOf(t, 311).id);
    const sure = stoneOf(t, 292);
    const settled = candidate("stone", null, sure.id);
    expect(withEntry(t, added.stone, { candidates: [settled, ...added.candidates] })).toContain("C8");
    const taken = candidate("world", sure.worldId, sure.id);
    expect(withEntry(t, added.stone, { candidates: [taken, ...added.candidates] })).toContain("C8");
  });

  it("a malformed entry still has its candidates checked: each broken code", () => {
    const t = tray(13);
    const added = entry(t, stoneOf(t, 311).id);
    const settled = candidate("stone", null, stoneOf(t, 292).id);
    const broken = { cause: "no such cause", candidates: [settled, ...added.candidates] };
    expect(withEntry(t, added.stone, broken)).toEqual(["C7", "C8"]);
  });

  it("C9: an identified fact cleared its bar", () => {
    const t = tray(12);
    const i = t.facts.findIndex((x) => x.kind === "identified");
    const found = t.facts[i] as TrayFact;
    const bar = found.bar as number;
    expect(found.score).not.toBeNull();
    // a hand-made fact without its score says so
    expect(fact(found, { score: null }).describe()).toMatch(
      new RegExp(`by its look on world stone ${String(found.worldId)} \\(-\\)$`),
    );
    for (const bad of [
      { score: bar - 1 },
      { bar: 700, score: 720 },
      { certain: true },
      { margin: 149 },
      { score: null },
    ] as Partial<TrayFactInit>[]) {
      const facts = [...t.facts];
      facts[i] = fact(found, bad);
      expect(withFacts(t, facts), JSON.stringify(bad)).toContain("C9");
    }
  });

  it("the open account as values", () => {
    const t = tray(13);
    const d = t.toJSON();
    expect(JSON.parse(JSON.stringify(t))).toEqual(d);
    expect(d.t_id).toBe(750);
    const tie = entry(t, stoneOf(t, 311).id);
    expect(tie.toJSON()).toEqual({
      stone: tie.stone,
      world_id: 311,
      kind: "added",
      cause: "doubtful",
      look: "tie",
      score: tie.score,
      hand_near: true,
      seen_at_arrival: false,
      candidates: tie.candidates.map((c) => c.toJSON()),
    });
    expect(tie.candidates[0]?.toJSON()).toEqual({
      kind: "stone",
      world_id: null,
      stone: stoneOf(t, 301).id,
      score: tie.score,
      why: null,
    });
    expect(tie.candidates.at(-1)?.toJSON()).toEqual({
      kind: "new",
      world_id: null,
      stone: null,
      score: null,
      why: null,
    });
    expect(d.open).toEqual((t.open ?? []).map((o) => o.toJSON()));
    const stones = d.stones as Record<string, unknown>[];
    expect(stones[t.stones.findIndex((s) => s.id === tie.stone)]?.open).toEqual(tie.toJSON());
    expect((t.facts.at(-1) as TrayFact).toJSON().open).toEqual(d.open);
    expect(new TrayCandidate({ kind: "gone", worldId: null, stone: null, score: null, why: "hand" }).describe()).toBe(
      "gone (hand)",
    );
  });

  it("a question while its tray is on", () => {
    // a stone in question is not sure while its tray is on and holds its question; the live tray breaks C1 (it has not
    // left) and C4 (a question is open) until it leaves
    const core = new InterpreterCore();
    let seen = false;
    for (const f of replay().framesSync()) {
      core.feed(f);
      const live = core.trays().at(-1);
      const s = live?.stones.find((x) => x.question !== null);
      if (live === undefined || live.leaving !== null || s === undefined) continue;
      const q = s.question as TrayQuestion;
      expect(s.sure).toBe(false);
      expect(["pushed", "neighbour_pushed", "found_again"]).toContain(q.cause);
      expect(q.toJSON()).toEqual({ cause: q.cause, why: q.why, since: q.since, opened: q.opened });
      expect(s.toJSON().question).toEqual(q.toJSON());
      expect(live.check()).toEqual(expect.arrayContaining(["C1", "C4"]));
      seen = true;
      break;
    }
    expect(seen).toBe(true);
  });

  it("a look that scores nothing settles nothing, and the gauge pairs stones of one size only", () => {
    const world = [
      stone(1, [0, 0, 0.05], { look: synthetic("big") }),
      stone(3, [1.2, 0, 0.05], {
        look: synthetic("brick-a"),
        solid: { pos: [1.2, 0, 0.05], q: [0, 0, 0, 1], dims: [0.6, 0.4, 0.09] }, // another size
      }),
      stone(4, [0, 1, 0.05], { look: synthetic("flat") }), // usable, but it pairs with no look: no score
    ];
    const stats = { stones: 3, confirmed: 3 };
    const core = new InterpreterCore();
    const facts: TrayFact[] = [];
    for (let g = 0; g < 40; g++) {
      const events = g === 20 ? [{ type: "push" as const, id: 4, side: "left" as const }] : [];
      facts.push(...core.feed(mkFrame(g, { stones: world, stats, events })).trayFacts);
    }
    const live = core.state.tray as Tray;
    expect(live.tId).toBe(900); // the tray took looks; its gauge holds no pair (the flat look scores none)
    // the anchors and latest looks: the flat look's own compare has no score, so its stone keeps its anchor only
    expect(live.stones.map((s) => [s.worldId, s.looks.length, s.question?.cause ?? null])).toEqual([
      [1, 2, null],
      [3, 2, null],
      [4, 1, "pushed"],
    ]);
    expect(live.check()).toEqual(["C1", "C4"]);
    facts.push(...core.end().trayFacts);
    const left = core.trays().at(-1) as Tray;
    const flat = left.stones[2] as TrayStone;
    expect(facts.map((f) => f.describe())).toEqual([
      "0:00.8 tray 1 arrived: 3 stones",
      `0:07.8 tray 1: stone ${flat.id} is not sure any more (it was pushed; open since 0:04.6)`,
      "0:07.8 tray 1 leaving: 3 stones (2 sure), 0 added, 0 removed, 0 unclear",
    ]);
    expect(entry(left, flat.id).describe()).toBe(`stone ${flat.id}: unsure pushed, look low: world 4 or gone`);
    expect(left.check()).toEqual([]);
  });

  it("a tray stone, a tray and a leaving fact made by hand", () => {
    const born = { g: 1, t: 0.2, wall: null };
    const s = new TrayStone({
      id: "x",
      worldId: 1,
      status: "on",
      sure: true,
      added: false,
      certain: null,
      born,
      place: [0, 0],
      size: [0.2, 0.14],
    });
    expect([s.question, s.looks, s.byLook, s.lookLost, s.open]).toEqual([null, [], false, false, null]);
    const t = new Tray({ session: 1, video: "v", n: 1, arrived: born, leaving: null, stones: [s], facts: [] });
    expect([t.open, t.tId, t.toJSON().open, t.toJSON().t_id]).toEqual([null, null, null, null]);
    const leave = new TrayFact({
      kind: "leaving",
      tray: 1,
      session: 1,
      video: "v",
      stone: null,
      worldId: null,
      certain: null,
      why: null,
      g: 5,
      t: 1,
      wall: null,
      stones: 1,
      sure: 1,
      added: 0,
      removed: 0,
      unclear: 0,
    });
    expect(describeOpenTxt([leave])).toBe("0:01.0 tray 1 leaving: 1 stones (1 sure), 0 added, 0 removed, 0 unclear\n");
  });

  it("the small helpers: since a disturbance, and what blocks a decision by look", () => {
    const at = { g: 9, t: 1.8, wall: null };
    expect(sinceOf({ disturbed: null }, at)).toBe(9); // an undisturbed stone: this frame on
    expect(sinceOf({ disturbed: 7 }, at)).toBe(8); // after its latest disturbance
    // a tray stone without a chain that could be on world stone 5 at (0, 0) blocks a decision on it
    const size: [number, number] = [0.2, 0.14];
    const row = { chain: [{}] };
    const blocks = (place: [number, number], extra: Record<string, unknown> = {}): boolean => {
      const o = { status: "on", chain: [], size, place, world: 9, disturbed: null, ...extra };
      return unscored({ stones: [row, o] } as never, row as never, 5, [0, 0], size);
    };
    expect(blocks([0.6, 0])).toBe(false); // far and not disturbed
    expect(blocks([0.6, 0], { disturbed: 3 })).toBe(true); // disturbed within D_MATCH
    expect(blocks([1.2, 0], { disturbed: 3 })).toBe(false); // disturbed beyond D_MATCH
    expect(blocks([0.3, 0])).toBe(true); // within D_NEIGH
    expect(blocks([2, 0], { world: 5 })).toBe(true); // linked to it
    expect(blocks([2, 0], { world: 5, status: "lost" })).toBe(false); // lost: not linked
    expect(blocks([0.3, 0], { chain: [{}] })).toBe(false); // with a chain: its score rules it out
    expect(blocks([0.3, 0], { status: "removed" })).toBe(false);
    expect(blocks([0.3, 0], { size: [0.6, 0.4] })).toBe(false); // another size
  });

  it("permille text and the pairing of no look", () => {
    expect([milli(853), milli(1000), milli(-5), milli(-1000), milli(0)]).toEqual([
      "0.853",
      "1.000",
      "-0.005",
      "-1.000",
      "0.000",
    ]);
  });
});
