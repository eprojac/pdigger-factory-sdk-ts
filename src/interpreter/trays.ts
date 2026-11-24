/**
 * Trays and tray stones (SDK-DESIGN.md section 4.6): the SDK's own stone ids, one per stone, never reused.
 *
 * The world's stone ids are the engine tracker's: it renames a stone it lost and found again, and it can keep an id on
 * another stone (a stone set down where a removed one lay, a neighbour pushed into its place, a row of equal stones
 * pushed one place along while the ids stay on the places). The interpreter follows each tray from the moment it has
 * arrived and settled to the moment it leaves, and keeps its own stones on it, the tray stones. A tray stone says
 * whether its identity is still sure; a fact about it is certain or unclear: an identity stays sure, and a fact is
 * certain, only when what the world shows at calm moments leaves no other reading. A certain fact is never revised.
 *
 * A stone without looks of its own (`TrayStone.looks` empty) that the world stops detecting while nothing could have
 * changed it is not given up at once: its doubt is a question (a presence question, 4.6.1: the stone is not sure
 * meanwhile, and no fact is given), which seeing it again where it was settles when no hand was at work, no push came
 * on the tray, no frame went unread and no other stone of its size stood at its place while it was out of sight.
 *
 * When the world carries looks of the stones' faces (`StoneView.look`, 4.6.2), the rules also follow each stone that has
 * a look by it: a doubt a later look may settle is first a question too (a stone with looks that is not seen at two
 * calm moments included: only a look settles its question); a look settles it, or links a stone again (fact
 * `identified`), only above a bar the tray's own looks set; and a tray's certain facts are the first of those the rules
 * make without looks (once a look changes a link, doubts a stone they trust or keeps one from their certain removal,
 * the tray makes no more). Without usable looks the rules are those of the first version (4.6.1, presence questions
 * included), line for line. When a tray leaves, its open account (`Tray.open`) lists every stone the rules leave open
 * with the readings the evidence leaves.
 *
 * What the SDK can not see: a box the model sees on an empty slot when the tray arrives becomes a tray stone, and a
 * stone set into that slot later keeps its id.
 *
 * A tray's report ({@link Tray.report}, section 4.7) is simple mode: which stones were removed, added and moved, when,
 * and whether that is the tray's whole account. The facts say why, stone by stone.
 *
 * @module
 */
import type { HandState, Rect, Solid, SpeckleFind, StoneView, WorldLayer, WorldSpeckle } from "../models.js";
import { type LookCells, lookPermille, pairCells, usableCells } from "./looks.js";
import { clock, describeTrayFact, fmt, milli, pyDiv, pyMod, round3 } from "./text.js";
import type { FrameRef } from "./types.js";

/** A static stop of at least this many seconds is a tray visit. */
const STOP_MIN = 2.0;
/** A calm moment: this many frames in a row with both hands free, no hand event and no stone new or gone. */
const CALM = 3;
/** Maximum consecutive quiet frames that may omit a detected world id. */
const BLINK_FRAMES = 2;
/** Frames since the last `new` before a tray can arrive. */
const QUIET = 5;
/** A world rename: an unidentified stone first seen within this many seconds of the loss ... */
const RENAME_T = 3.0;
/** ... and this close to the lost stone's place. */
const RENAME_D = 0.15;
/** Two sizes are compatible when each side differs by at most this share of the larger. */
const SIZE_TOL = 0.25;
/** An unidentified stone at the same place at two calm moments: within this distance. */
const NEAR = 0.12;
/** "Next to": hand work, a pushed neighbour, a stone that appeared. */
const HAND_R = 0.4;
/** When a tray leaves, what is left is paired within this distance. */
const LEAVE_D = 1.0;
/** Calm moments in a row a stone's world stone may go unseen before the stone is not sure. */
const GHOST = 2;
/** Share of a stone's box another world box may cover before the stone is not sure. */
const OVERLAP = 0.3;
/** Margin of the empty-footprint check of a removal. */
const MARGIN = 0.03;
// by look (4.6.11); scores are permille integers
/** The tray's bar while its gauge holds fewer than GAUGE_MIN pairs. */
const T_ID_START = 900;
/** The lowest bar: `T_id = max(T_ID_MIN, alike + GAP)`. */
const T_ID_MIN = 750;
/** How far the bar lies above the most alike pair of two different stones of the tray. */
const GAP = 100;
/** Gauge pairs a tray needs before its bar can drop. */
const GAUGE_MIN = 20;
/** Gauge partners each taken look is scored with, both ways. */
const GAUGE_K = 2;
/** The bar for a link change, or with a stone without a chain near. */
const T_FIRM = 800;
/** The margin a decision needs over every scored rival. */
const M_ID = 150;
/** Paired cells a decision or a doubt by look needs. */
const N_ID = 100;
/** Below this an untouched stone's own look changed. */
const T_DIFF = 400;
/** How far a pair reaches. */
const D_MATCH = 1.0;
/** Neighbours of a column, and stones without a chain near. */
const D_NEIGH = 0.4;
/** Pairs per row. */
const K_PAIR = 4;
/** Neighbours per column. */
const K_NEIGH = 4;
/** Looks taken per look work. */
const N_TAKE = 16;

const HAND_EVENTS: ReadonlySet<string> = new Set(["lift", "hinge", "carry", "place", "drop", "gone"]);
const HELD: ReadonlySet<string> = new Set(["carry", "hinge"]);
const HANDLED: ReadonlySet<string> = new Set(["lift", "carry", "hinge", "place"]);
const ENDS: ReadonlySet<string> = new Set(["gone", "drop", "delete"]);
const CHANGES: ReadonlySet<string> = new Set(["new", "delete", "split"]);
const LOOK_CLEARERS: ReadonlySet<string> = new Set([
  "push",
  "lift",
  "hinge",
  "carry",
  "place",
  "drop",
  "gone",
  "delete",
  "split",
]);

/** The codes of `unsure` facts (4.6.9), which are also the causes of open `unsure` entries. */
const UNSURE_CODES: readonly string[] = [
  "overlap",
  "unseen",
  "pushed",
  "neighbour_pushed",
  "appeared",
  "size_changed",
  "found_again",
  "matched_at_leaving",
  "look_changed",
];
/** Why an open `removed` entry was not removed for certain (4.6.8). */
const REMOVED_CAUSES: readonly string[] = [
  "look_lost",
  "by_look",
  "twins",
  "relinked",
  "lost_late",
  "covered",
  "rivals",
  "no_hand",
  "unchecked",
];
/** Why an open `added` entry was not added for certain (4.6.8). */
const ADDED_CAUSES: readonly string[] = ["freed", "size_changed", "relinked", "doubtful", "seen_once", "unchecked"];
/** Why the looks could not settle an open entry, by kind (4.6.8). */
const STONE_LOOKS: readonly string[] = ["none", "late", "box", "stale", "tie", "low"];
const LOOK_CODES: ReadonlyMap<string, readonly string[]> = new Map([
  ["unsure", STONE_LOOKS],
  ["removed", STONE_LOOKS],
  ["added", ["none", "tie", "new"]],
]);

/**
 * How many trays that have left a new {@link InterpreterCore} keeps for `trays()` (the newest); see its `traysKept`
 * option.
 */
export const TRAYS_KEPT = 256;

/** A point of a tray: grid frame, media time and wall time (null before a clock state is known). */
export type TrayPoint = FrameRef;

/**
 * What a {@link TrayFact} says: the tray arrived, a stone is not sure any more, a look or the leaving's speckle answer
 * linked it (`identified`), it was removed or added, the tray leaves.
 */
export type TrayFactKind = "arrived" | "unsure" | "identified" | "removed" | "added" | "leaving";

/** Where a {@link TrayStone} is: on the tray, lost (its world stone went, not found again yet) or removed. */
export type TrayStoneStatus = "on" | "lost" | "removed";

/**
 * A doubt held open for a look, or for the stone's next sight (a presence question, 4.6.1), to settle (4.6.4): its
 * cause code (`pushed`, `unseen`, ...), why, `since` (the first frame `g` whose looks count for it) and where it
 * opened.
 */
export class TrayQuestion {
  readonly cause: string;
  readonly why: string;
  /** The first frame `g` whose looks count for it. */
  readonly since: number;
  /** Where it opened. */
  readonly opened: TrayPoint;

  constructor(cause: string, why: string, since: number, opened: TrayPoint) {
    this.cause = cause;
    this.why = why;
    this.since = since;
    this.opened = opened;
  }

  toJSON(): Record<string, unknown> {
    return {
      cause: this.cause,
      why: this.why,
      since: this.since,
      opened: this.opened,
    };
  }
}

/** What a {@link TrayCandidate} is: a world stone, a tray stone, gone, unseen or new. */
export type TrayCandidateKind = "world" | "stone" | "gone" | "unseen" | "new";

/** What the fields of a new {@link TrayCandidate} are. */
export interface TrayCandidateInit {
  kind: TrayCandidateKind;
  worldId: number | null;
  stone: string | null;
  score: number | null;
  why: string | null;
}

/**
 * One reading the evidence leaves for an open stone (4.6.8): `world` (a world stone, with the tray stone linked to it,
 * if any), `stone` (a tray stone), `gone` (with why: `carried_away`, `emptied`, `dropped` or `hand`), `unseen` or
 * `new`. `score` is a look score in permille, when the last look run had one.
 */
export class TrayCandidate {
  readonly kind: TrayCandidateKind;
  readonly worldId: number | null;
  readonly stone: string | null;
  readonly score: number | null;
  readonly why: string | null;

  constructor(init: TrayCandidateInit) {
    this.kind = init.kind;
    this.worldId = init.worldId;
    this.stone = init.stone;
    this.score = init.score;
    this.why = init.why;
  }

  /** `world 91 0.781`, `stone 20261122T023847.0Z-2-87`, `gone (hand)`, `unseen` or `new`. */
  describe(): string {
    if (this.kind === "world" || this.kind === "stone") {
      const head = this.kind === "world" ? `world ${String(this.worldId)}` : `stone ${String(this.stone)}`;
      return this.score === null ? head : `${head} ${milli(this.score)}`;
    }
    if (this.kind === "gone") return this.why === null ? "gone" : `gone (${this.why})`;
    return this.kind;
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      world_id: this.worldId,
      stone: this.stone,
      score: this.score,
      why: this.why,
    };
  }
}

/** What the fields of a new {@link TrayOpen} are. */
export interface TrayOpenInit {
  stone: string;
  worldId: number | null;
  kind: "unsure" | "removed" | "added";
  cause: string;
  look: string;
  score: number | null;
  handNear: boolean | null;
  seenAtArrival: boolean | null;
  candidates: readonly TrayCandidate[];
}

/**
 * A stone the rules leave open when its tray leaves (4.6.8): `unsure` (on the tray, not sure), `removed` (removed
 * unclear) or `added` (added unclear), with the cause, why the looks could not settle it (`look`, with its `score` in
 * permille), and every reading the evidence leaves (`candidates`, ranked).
 */
export class TrayOpen {
  readonly stone: string;
  readonly worldId: number | null;
  readonly kind: "unsure" | "removed" | "added";
  readonly cause: string;
  readonly look: string;
  readonly score: number | null;
  /** Added: a hand worked near it in the RENAME_T s before it was first seen (null for the other kinds). */
  readonly handNear: boolean | null;
  /** Added: its world id was on the tray at the arrival (null for the other kinds). */
  readonly seenAtArrival: boolean | null;
  readonly candidates: readonly TrayCandidate[];

  constructor(init: TrayOpenInit) {
    this.stone = init.stone;
    this.worldId = init.worldId;
    this.kind = init.kind;
    this.cause = init.cause;
    this.look = init.look;
    this.score = init.score;
    this.handNear = init.handNear;
    this.seenAtArrival = init.seenAtArrival;
    this.candidates = init.candidates;
  }

  /** `stone 20261118T000039.8Z-6-91: unsure pushed, look low 0.781: world 91 0.781 or world 92 or gone`. */
  describe(): string {
    let s = `stone ${this.stone}: ${this.kind} ${this.cause}, look ${this.look}`;
    if (this.score !== null) s += ` ${milli(this.score)}`;
    if (this.handNear === true) s += ", hand near";
    if (this.seenAtArrival === true) s += ", seen at arrival";
    return `${s}: ${this.candidates.map((c) => c.describe()).join(" or ")}`;
  }

  toJSON(): Record<string, unknown> {
    return {
      stone: this.stone,
      world_id: this.worldId,
      kind: this.kind,
      cause: this.cause,
      look: this.look,
      score: this.score,
      hand_near: this.handNear,
      seen_at_arrival: this.seenAtArrival,
      candidates: this.candidates.map((c) => c.toJSON()),
    };
  }
}

/** A clean speckle find: its score at least this (permille) and at least twice its second (4.6.12). */
export const SPECKLE_CLEAN = 300;
/** Frames between an answer's reference and its tray's arrival within which the arrival's links stand (4.6.12). */
export const SPECKLE_NEAR = 2;

/** The codes of the `identified` facts of the leaving's speckle answer (4.6.13). */
export const SPECKLE_CODES = ["speckle_same", "speckle_moved", "speckle_found"] as const;

/**
 * What the leaving's speckle answer found of a tray stone at the other moment (4.6.13, {@link TrayStone.evidence}):
 * `found` (a clean find), `not_found` (checked, no find of SPECKLE_CLEAN or more) or `undecided` (no leaving answer,
 * the stone not in it or not checked, look-alikes, or an added stone removed again).
 */
export type TrayStoneEvidence = "found" | "not_found" | "undecided";

/**
 * The confidence of a removal or an addition (4.6.13), by its kind, whether it is `certain` or `unclear`, and the
 * stone's {@link TrayStone.evidence}: the probability that the change happened, `(right + 1) / (checked + 2)` over the
 * four recordings' changes checked by the maintainers' offline look tracker (each stone followed by its look both
 * ways) and camera check (a certain addition takes the unclear additions' numbers). The same numbers in every SDK.
 */
export const CONFIDENCE: Readonly<
  Record<"removed" | "added", Readonly<Record<"certain" | "unclear", Readonly<Record<TrayStoneEvidence, number>>>>>
> = Object.freeze({
  removed: Object.freeze({
    certain: Object.freeze({ not_found: 0.98, undecided: 0.5, found: 0.25 }),
    unclear: Object.freeze({ not_found: 0.71, undecided: 0.58, found: 0.09 }),
  }),
  added: Object.freeze({
    certain: Object.freeze({ not_found: 0.96, undecided: 0.52, found: 0.02 }),
    unclear: Object.freeze({ not_found: 0.96, undecided: 0.52, found: 0.02 }),
  }),
});

/** The confidence of a move (4.6.13): 19 of 21 paired moves right. */
export const MOVED_CONFIDENCE = 0.87;

/** The codes of the leaving's speckle `identified` facts, for lookups by a fact's code. */
const SPECKLE: ReadonlySet<string | null> = new Set(SPECKLE_CODES);

/** Which moment a {@link StoneSpeckle}'s stone was checked from. */
export type SpeckleSide = "arrival" | "later";

/**
 * A tray stone in one of the unit's speckle answers (4.6.12): `side` `arrival` (the stone as it was at the answer's
 * reference, checked at its later moment) or `later` (the stone at the later moment, checked at the reference);
 * `score` and `second` as the unit sent them (null: not checked); `clean` when the score is at least 0.300 and twice
 * the second; `foundWorld` the world stone at the other moment its best place lies on, `found` the tray stone that
 * stood for it there, and `pair` the tray stone the answer pairs it with (null when there is none).
 */
export class StoneSpeckle {
  constructor(
    readonly stone: string,
    readonly side: SpeckleSide,
    readonly score: number | null,
    readonly second: number | null,
    readonly clean: boolean,
    readonly found: string | null,
    readonly foundWorld: number | null,
    readonly pair: string | null,
  ) {}

  /** The answer pairs the stone with itself: the same stone at both moments. */
  get same(): boolean {
    return this.pair === this.stone;
  }

  toJSON(): Record<string, unknown> {
    return {
      stone: this.stone,
      side: this.side,
      score: this.score,
      second: this.second,
      clean: this.clean,
      found: this.found,
      found_world: this.foundWorld,
      pair: this.pair,
    };
  }
}

/** What the fields of a new {@link TraySpeckle} are. */
export interface TraySpeckleInit {
  tray: number;
  session: number | null;
  video: string | null;
  g: number;
  t: number;
  wall: number | null;
  unitTray: number;
  ref: TrayPoint;
  at: TrayPoint;
  device: string;
  gpuMs: number;
  wallMs: number;
  stones: readonly StoneSpeckle[];
}

/**
 * One of the unit's speckle answers, read as a tray's (4.6.12): `tray` the SDK's tray number, `g`, `t` and `wall` the
 * frame it came in, `unitTray` the unit's own count, `ref` and `at` the two moments compared, the unit's `device`,
 * `gpuMs` and `wallMs`, and `stones` the tray stones in it, in tray order.
 */
export class TraySpeckle {
  readonly tray: number;
  readonly session: number | null;
  readonly video: string | null;
  readonly g: number;
  readonly t: number;
  readonly wall: number | null;
  readonly unitTray: number;
  readonly ref: TrayPoint;
  readonly at: TrayPoint;
  readonly device: string;
  readonly gpuMs: number;
  readonly wallMs: number;
  readonly stones: readonly StoneSpeckle[];

  constructor(init: TraySpeckleInit) {
    this.tray = init.tray;
    this.session = init.session;
    this.video = init.video;
    this.g = init.g;
    this.t = init.t;
    this.wall = init.wall;
    this.unitTray = init.unitTray;
    this.ref = init.ref;
    this.at = init.at;
    this.device = init.device;
    this.gpuMs = init.gpuMs;
    this.wallMs = init.wallMs;
    this.stones = init.stones;
  }

  /** The answer for that tray stone. */
  stone(stoneId: string): StoneSpeckle | null {
    return this.stones.find((s) => s.stone === stoneId) ?? null;
  }

  /** `tray 2: speckle of 0:22.5 and 2:24.2: 42 stones, 33 clean, 26 paired, 24 the same`. */
  describe(): string {
    const st = this.stones;
    return (
      `tray ${this.tray}: speckle of ${clock(this.ref.t)} and ${clock(this.at.t)}: ${st.length} stones, ` +
      `${st.filter((e) => e.clean).length} clean, ${st.filter((e) => e.pair !== null).length} paired, ` +
      `${st.filter((e) => e.same).length} the same`
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      tray: this.tray,
      session: this.session,
      video: this.video,
      g: this.g,
      t: this.t,
      wall: this.wall,
      unit_tray: this.unitTray,
      ref: { g: this.ref.g, t: this.ref.t },
      at: { g: this.at.g, t: this.at.t },
      device: this.device,
      gpu_ms: this.gpuMs,
      wall_ms: this.wallMs,
      stones: this.stones.map((s) => s.toJSON()),
    };
  }
}

/**
 * The golden `speckle.txt` form (4.6.12): for every answer `{g} {clock} ` and its describe(), then a line for each of its
 * stones: two spaces, the stone, its side, score and second to 3 places (`-` when not checked), ` clean`,
 * ` found {tray stone}` (or ` found world {id}`), ` pair {tray stone}`; `\n` after every line.
 */
export function describeSpeckleTxt(answers: Iterable<TraySpeckle>): string {
  const out: string[] = [];
  for (const a of answers) {
    out.push(`${a.g} ${clock(a.t)} ${a.describe()}\n`);
    for (const e of a.stones) {
      const sc = e.score === null || e.second === null ? "-" : `${fmt(e.score, 3)} ${fmt(e.second, 3)}`;
      let line = `  ${e.stone} ${e.side} ${sc}`;
      if (e.clean) line += " clean";
      if (e.found !== null) line += ` found ${e.found}`;
      else if (e.foundWorld !== null) line += ` found world ${e.foundWorld}`;
      if (e.pair !== null) line += ` pair ${e.pair}`;
      out.push(`${line}\n`);
    }
  }
  return out.join("");
}

/** A score as the integer the rules compare: floor(score * 1000 + 0.5) (4.6.2). */
const speckleMille = (x: number): number => Math.floor(x * 1000 + 0.5);

/** A clean find (4.6.12): its score at least SPECKLE_CLEAN (permille) and at least twice its second. */
const speckleClean = (x: SpeckleFind): boolean =>
  x.score !== null &&
  x.second !== null &&
  speckleMille(x.score) >= SPECKLE_CLEAN &&
  speckleMille(x.score) >= 2 * speckleMille(x.second);

/** What the fields of a new {@link TrayStone} are. */
export interface TrayStoneInit {
  id: string;
  worldId: number | null;
  status: TrayStoneStatus;
  sure: boolean;
  added: boolean;
  certain: boolean | null;
  born: TrayPoint;
  place: readonly [number, number];
  size: readonly [number, number];
  question?: TrayQuestion | null;
  looks?: readonly number[];
  byLook?: boolean;
  lookLost?: boolean;
  open?: TrayOpen | null;
  firstPlace?: readonly [number, number];
  leftPlace?: readonly [number, number] | null;
  touched?: number | null;
  speckle?: StoneSpeckle | null;
  bySpeckle?: boolean;
  evidence?: TrayStoneEvidence | null;
}

/**
 * A stone of a tray, with the SDK's own id: `{when first seen}-{tray}-{world id}` (`20261122T023847.0Z-1-105`; without
 * a clock `s{session}t{media seconds}-{tray}-{world id}`; a second stone first seen on the tray in the same tenth of a
 * second under the same world id takes `-2` at the end, a third `-3`). An id is never given to two stones.
 */
export class TrayStone {
  /** The tray stone's id. */
  readonly id: string;
  /** The world stone it stands for now (null while lost and once removed). */
  readonly worldId: number | null;
  /** On, lost or removed. */
  readonly status: TrayStoneStatus;
  /** Its identity is sure now: false while a `question` is open, and for good once the stone is not sure. */
  readonly sure: boolean;
  /** The SDK found no matching arrival identity. The addition may be a renamed arrival stone unless its set-down was certain. */
  readonly added: boolean;
  /**
   * Whether its fact is certain: for a removed stone its removal's (also when it was added first), for an added stone
   * that was not removed its addition's, null for the others. So an added and removed stone that was set down for
   * certain can be `certain: false`: count certain additions from the facts.
   */
  readonly certain: boolean | null;
  /** When it was first seen on the tray. */
  readonly born: TrayPoint;
  /**
   * Its place (x, y) as last known, in scene units (for a stone counted from the leaving point's world, boxed or kept
   * there, as that world has it).
   */
  readonly place: readonly [number, number];
  /**
   * Its size (long side, short side) as last known, in scene units (for a stone counted from the leaving point's
   * world, boxed or kept there, as that world has it).
   */
  readonly size: readonly [number, number];
  /** The doubt a look, or the stone's next sight (a presence question, 4.6.1), may still settle (4.6.4), or null. */
  readonly question: TrayQuestion | null;
  /** The frame `g`s of its anchor and latest look (none, one or two). */
  readonly looks: readonly number[];
  /** A look decision linked it. */
  readonly byLook: boolean;
  /** A look decision ended its link. */
  readonly lookLost: boolean;
  /** Its open entry once the tray has left, or null. */
  readonly open: TrayOpen | null;
  /** Its place (x, y) when the tray stone was made: at the arrival for the stones the tray arrived with. */
  readonly firstPlace: readonly [number, number];
  /** Its place (x, y) at the tray's leaving point when it was seen there; null otherwise, and while the tray is on. */
  readonly leftPlace: readonly [number, number] | null;
  /**
   * The frame `g` where something last touched it on this tray (a hand, a push on it or next to it, a link to another
   * world stone), or null: the report reads it.
   */
  readonly touched: number | null;
  /** The stone in the newest speckle answer of the unit read while its tray was on (4.6.12), or null. */
  readonly speckle: StoneSpeckle | null;
  /** The leaving's speckle answer linked or confirmed it (4.6.13). */
  readonly bySpeckle: boolean;
  /**
   * What the leaving's speckle answer found of it at the other moment, set as the tray leaves (4.6.13): for a stone
   * the tray arrived with, its arrival world id's find (is it on the tray as it left?); for one added and on the tray as
   * it left, its world id's (was it on the tray at the arrival?). Null while the tray is on.
   */
  readonly evidence: TrayStoneEvidence | null;

  constructor(init: TrayStoneInit) {
    this.id = init.id;
    this.worldId = init.worldId;
    this.status = init.status;
    this.sure = init.sure;
    this.added = init.added;
    this.certain = init.certain;
    this.born = init.born;
    this.place = init.place;
    this.size = init.size;
    this.question = init.question ?? null;
    this.looks = init.looks ?? [];
    this.byLook = init.byLook ?? false;
    this.lookLost = init.lookLost ?? false;
    this.open = init.open ?? null;
    this.firstPlace = init.firstPlace ?? [0, 0];
    this.leftPlace = init.leftPlace ?? null;
    this.touched = init.touched ?? null;
    this.speckle = init.speckle ?? null;
    this.bySpeckle = init.bySpeckle ?? false;
    this.evidence = init.evidence ?? null;
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      world_id: this.worldId,
      status: this.status,
      sure: this.sure,
      added: this.added,
      certain: this.certain,
      born: this.born,
      place: [...this.place],
      size: [...this.size],
      question: this.question === null ? null : this.question.toJSON(),
      looks: [...this.looks],
      by_look: this.byLook,
      look_lost: this.lookLost,
      open: this.open === null ? null : this.open.toJSON(),
      first_place: [...this.firstPlace],
      left_place: this.leftPlace === null ? null : [...this.leftPlace],
      touched: this.touched,
      speckle: this.speckle === null ? null : this.speckle.toJSON(),
      by_speckle: this.bySpeckle,
      evidence: this.evidence,
    };
  }
}

/** What the fields of a new {@link TrayFact} are. */
export interface TrayFactInit {
  kind: TrayFactKind;
  tray: number;
  session: number | null;
  video: string | null;
  stone: string | null;
  worldId: number | null;
  certain: boolean | null;
  why: string | null;
  g: number;
  t: number;
  wall: number | null;
  stones: number | null;
  sure: number | null;
  added: number | null;
  removed: number | null;
  unclear: number | null;
  code?: string | null;
  opened?: TrayPoint | null;
  fromWorld?: number | null;
  score?: number | null;
  margin?: number | null;
  bar?: number | null;
  tId?: number | null;
  open?: readonly TrayOpen[] | null;
}

/**
 * Something the interpreter says about a tray: `arrived`, `unsure`, `identified`, `removed`, `added` or `leaving`, e.g.
 * `0:45.5 tray 1: stone 20261122T023847.0Z-1-117 was removed`. A removal or an addition is certain or unclear: an
 * unclear one is reported as such, never as a fact.
 */
export class TrayFact {
  /** What it says. */
  readonly kind: TrayFactKind;
  /** The tray's number in its session, from 1. */
  readonly tray: number;
  readonly session: number | null;
  readonly video: string | null;
  /** The tray stone's id (null for arrived and leaving). */
  readonly stone: string | null;
  /** The world id the stone stands for now (null when none). */
  readonly worldId: number | null;
  /** Removed and added: the fact is certain (null for the other kinds). */
  readonly certain: boolean | null;
  /** The reason of unsure, identified, removed and added. */
  readonly why: string | null;
  /** The code of its why (`pushed`, `look_found`, `carried_away`, ...); null for arrived and leaving. */
  readonly code: string | null;
  /** Grid frame (the leaving facts carry the leaving point). */
  readonly g: number;
  /** Media seconds. */
  readonly t: number;
  /** Epoch seconds, null without a clock state. */
  readonly wall: number | null;
  /** Arrived: the tray stones at the arrival; leaving: those on the tray. */
  readonly stones: number | null;
  /** Leaving: the tray stones still sure. */
  readonly sure: number | null;
  /** Leaving: its certain additions. */
  readonly added: number | null;
  /** Leaving: its certain removals. */
  readonly removed: number | null;
  /** Leaving: its unclear facts. */
  readonly unclear: number | null;
  /** Unsure: where the question it ends opened, or null. */
  readonly opened: TrayPoint | null;
  /** Identified: the world id it stood for before (`look_moved`, `speckle_moved`), or null. */
  readonly fromWorld: number | null;
  /**
   * Identified: its score, margin (may be null) and bar, in permille (by its speckle: the clean find's score and
   * margin, and the bar SPECKLE_CLEAN).
   */
  readonly score: number | null;
  readonly margin: number | null;
  readonly bar: number | null;
  /** Leaving: the tray's bar by look (permille), null when the tray took no look. */
  readonly tId: number | null;
  /** Leaving: the open account (4.6.8). */
  readonly open: readonly TrayOpen[] | null;

  constructor(init: TrayFactInit) {
    this.kind = init.kind;
    this.tray = init.tray;
    this.session = init.session;
    this.video = init.video;
    this.stone = init.stone;
    this.worldId = init.worldId;
    this.certain = init.certain;
    this.why = init.why;
    this.code = init.code ?? null;
    this.g = init.g;
    this.t = init.t;
    this.wall = init.wall;
    this.stones = init.stones;
    this.sure = init.sure;
    this.added = init.added;
    this.removed = init.removed;
    this.unclear = init.unclear;
    this.opened = init.opened ?? null;
    this.fromWorld = init.fromWorld ?? null;
    this.score = init.score ?? null;
    this.margin = init.margin ?? null;
    this.bar = init.bar ?? null;
    this.tId = init.tId ?? null;
    this.open = init.open ?? null;
  }

  /** The fact as one line, e.g. `0:45.5 tray 1: stone 20261122T023847.0Z-1-117 was removed`. */
  describe(): string {
    return describeTrayFact(this);
  }

  /** The media time as `M:SS.d`. */
  get clock(): string {
    return clock(this.t);
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      tray: this.tray,
      session: this.session,
      video: this.video,
      stone: this.stone,
      world_id: this.worldId,
      certain: this.certain,
      why: this.why,
      code: this.code,
      g: this.g,
      t: this.t,
      wall: this.wall,
      stones: this.stones,
      sure: this.sure,
      added: this.added,
      removed: this.removed,
      unclear: this.unclear,
      opened: this.opened,
      from_world: this.fromWorld,
      score: this.score,
      margin: this.margin,
      bar: this.bar,
      t_id: this.tId,
      open: this.open === null ? null : this.open.map((o) => o.toJSON()),
    };
  }
}

/** What the fields of a new {@link Tray} are. */
export interface TrayInit {
  session: number | null;
  video: string | null;
  n: number;
  arrived: TrayPoint | null;
  leaving: TrayPoint | null;
  stones: readonly TrayStone[];
  facts: readonly TrayFact[];
  open?: readonly TrayOpen[] | null;
  tId?: number | null;
}

/**
 * A tray: `arrived` (it has arrived and settled; null until then) and `leaving` (just before it moved out; null while
 * it is on, and for a tray that never arrived), its stones in tray order and every fact about it. `open` is the open
 * account of its leaving (null until it has left) and `tId` its bar by look now (permille; null while it has taken no
 * look).
 */
export class Tray {
  readonly session: number | null;
  readonly video: string | null;
  /** The tray's number in its session, from 1. */
  readonly n: number;
  /** Where it had arrived and settled. */
  readonly arrived: TrayPoint | null;
  /** Just before it moved out. */
  readonly leaving: TrayPoint | null;
  /** Its tray stones, in tray order. */
  readonly stones: readonly TrayStone[];
  /** Every fact about it, in order. */
  readonly facts: readonly TrayFact[];
  /** The leaving fact's open account, null until the tray has left. */
  readonly open: readonly TrayOpen[] | null;
  /** Its bar by look now (permille), null while it has taken no look. */
  readonly tId: number | null;

  constructor(init: TrayInit) {
    this.session = init.session;
    this.video = init.video;
    this.n = init.n;
    this.arrived = init.arrived;
    this.leaving = init.leaving;
    this.stones = init.stones;
    this.facts = init.facts;
    this.open = init.open ?? null;
    this.tId = init.tId ?? null;
  }

  /**
   * `[arrived.t, leaving.t]`: the media span from the arrival to the leaving point, the span to replay or to show for
   * this tray; null until it has left.
   */
  window(): [number, number] | null {
    if (this.arrived === null || this.leaving === null) return null;
    return [this.arrived.t, this.leaving.t];
  }

  /** The tray stone with that id, or null. */
  stone(id: string): TrayStone | null {
    return this.stones.find((s) => s.id === id) ?? null;
  }

  /**
   * The self-check of a tray that has left (4.6.10): the codes (`C1` ... `C9`) it finds broken in the tray's facts and
   * final tray stones, sorted; an empty list means the account is consistent. A tray that never arrived passes; one
   * that has not left yet breaks C1 (it has no `leaving` fact).
   */
  check(): string[] {
    return checkTray(this);
  }

  /**
   * The tray's report (4.7): which stones were removed, added and moved, and whether that is its whole account. Null
   * until the tray has left, and for a tray that never arrived.
   */
  report(): TrayReport | null {
    return trayReport(this);
  }

  toJSON(): Record<string, unknown> {
    return {
      session: this.session,
      video: this.video,
      n: this.n,
      arrived: this.arrived,
      leaving: this.leaving,
      stones: this.stones.map((s) => s.toJSON()),
      facts: this.facts.map((f) => f.toJSON()),
      open: this.open === null ? null : this.open.map((o) => o.toJSON()),
      t_id: this.tId,
    };
  }
}

/**
 * A stone the tray arrived with, that the SDK is sure of, saw at the leaving point and that something touched, moved
 * when, once the tray's own shift is taken out, its place there is more than this many times its short side from where
 * it was first seen (4.7).
 */
export const MOVED = 0.75;

/** What a {@link TrayChange} says: the stone was removed, added, or moved on the tray. */
export type TrayChangeKind = "removed" | "added" | "moved";

/**
 * One stone of a tray report (4.7). For removed and added, `at`, `certain` and `code` are its fact's (`carried_away`,
 * `missing`, `not_found`; `set_down`, `not_recognised`); for moved, `at` and `code` are null and `certain` is true:
 * only a stone the SDK is sure of, seen at the leaving point and touched on the tray is reported moved (one that is not
 * sure may be another stone at that place). `confidence` is the probability that the change happened (4.6.13), for a
 * threshold of your own.
 */
export class TrayChange {
  /** The stone was removed, added or moved. */
  readonly kind: TrayChangeKind;
  /** The tray stone's id. */
  readonly stone: string;
  /** Its fact's point (null for moved). */
  readonly at: TrayPoint | null;
  /** Its fact is certain; always true for moved. */
  readonly certain: boolean;
  /** Its fact's code (null for moved). */
  readonly code: string | null;
  /**
   * Its final place (x, y) on the tray, in the world's scene units (x right and y up as the camera sees the tray), for
   * matching a report with another system that looks at the trays: for a removal, where the stone was last seen before
   * it was taken; for an addition or a move, its place as the tray left (its `leftPlace` when it was seen at the
   * leaving point, else where it was last seen or, for a stone counted because the leaving point's world kept it, its
   * place in that world).
   */
  readonly place: readonly [number, number];
  /**
   * Its size (long side, short side) as last known, in scene units (for a stone counted from the leaving point's
   * world, boxed or kept there, as that world has it).
   */
  readonly size: readonly [number, number];
  /** How far a moved stone moved once the tray's own shift is taken out (null for the others). */
  readonly distance: number | null;
  /**
   * The probability that the change happened (4.6.13): for a removal or an addition its class's number in
   * {@link CONFIDENCE} (by its kind, whether it is certain, and the stone's `evidence`), for a move
   * {@link MOVED_CONFIDENCE}. Keep the changes at or above a threshold of your own.
   */
  readonly confidence: number;

  constructor(
    kind: TrayChangeKind,
    stone: string,
    at: TrayPoint | null,
    certain: boolean,
    code: string | null,
    place: readonly [number, number],
    size: readonly [number, number],
    distance: number | null = null,
    confidence = 0,
  ) {
    this.kind = kind;
    this.stone = stone;
    this.at = at;
    this.certain = certain;
    this.code = code;
    this.place = place;
    this.size = size;
    this.distance = distance;
    this.confidence = confidence;
  }

  /**
   * One line: for removed and added, the clock of its fact, the kind, the stone and its final place (`from` it for a
   * removal, `at` it for an addition), then its confidence, ` (0.98)`, or ` (unclear, 0.71)` when it is not certain
   * (`0:45.5 removed 20261122T023847.0Z-1-117 from (0.68, -1.06) (0.98)`); for moved, `moved`, the stone, the distance,
   * `to` its place and its confidence.
   */
  describe(): string {
    const coord = (v: number): string => (fmt(v, 2) === "-0.00" ? "0.00" : fmt(v, 2));
    const where = `(${coord(this.place[0])}, ${coord(this.place[1])})`;
    const conf = fmt(this.confidence, 2);
    if (this.kind === "moved") return `moved ${this.stone} ${fmt(this.distance ?? 0, 2)} to ${where} (${conf})`;
    const at = this.at === null ? "" : `${clock(this.at.t)} `;
    const prep = this.kind === "removed" ? "from" : "at";
    return `${at}${this.kind} ${this.stone} ${prep} ${where} (${this.certain ? "" : "unclear, "}${conf})`;
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      stone: this.stone,
      at: this.at,
      certain: this.certain,
      code: this.code,
      place: [...this.place],
      size: [...this.size],
      distance: this.distance,
      confidence: this.confidence,
    };
  }
}

/** What the fields of a new {@link TrayReport} are. */
export interface TrayReportInit {
  session: number | null;
  video: string | null;
  tray: number;
  arrived: TrayPoint;
  left: TrayPoint;
  stones: number;
  removed: readonly TrayChange[];
  added: readonly TrayChange[];
  moved: readonly TrayChange[];
  unclear: number;
  unsure: number;
  complete: boolean;
}

/**
 * A tray's report, the SDK's simple mode (4.7): on tray `tray`, from `arrived` to `left`, which stones were
 * `removed`, `added` and `moved`. `complete` says that is the tray's whole account: every change is certain and no
 * stone is open. Otherwise `unclear` counts the changes that are not certain and `unsure` the stones on the tray as it
 * left whose identity is not sure (those added unclear aside); the tray's facts and its open account (`Tray.open`) say
 * why, stone by stone. `arrived.wall` and `left.wall` are the unit's wall clock (UTC epoch seconds) when it is known.
 */
export class TrayReport {
  readonly session: number | null;
  readonly video: string | null;
  /** The tray's number in its session, from 1. */
  readonly tray: number;
  /** Where it had arrived and settled. */
  readonly arrived: TrayPoint;
  /** Its leaving point. */
  readonly left: TrayPoint;
  /** How many stones it arrived with. */
  readonly stones: number;
  /** A change for each removal, in order. */
  readonly removed: readonly TrayChange[];
  /** A change for each addition, in order. */
  readonly added: readonly TrayChange[];
  /** A change for each stone the tray arrived with that moved on it, in tray order. */
  readonly moved: readonly TrayChange[];
  /** Removals and additions that are not certain. */
  readonly unclear: number;
  /** Stones on the tray as it left whose identity is not sure (those added unclear aside). */
  readonly unsure: number;
  /** Every change is certain and no stone is open. */
  readonly complete: boolean;

  constructor(init: TrayReportInit) {
    this.session = init.session;
    this.video = init.video;
    this.tray = init.tray;
    this.arrived = init.arrived;
    this.left = init.left;
    this.stones = init.stones;
    this.removed = init.removed;
    this.added = init.added;
    this.moved = init.moved;
    this.unclear = init.unclear;
    this.unsure = init.unsure;
    this.complete = init.complete;
  }

  /**
   * `tray 1 (2026-11-22T02:38:47.0Z), 0:22.5 to 2:24.0: 15 removed, 17 added, 0 moved, not complete: 26 unclear, 25
   * not sure`, then a line for each change, indented two spaces.
   */
  describe(): string {
    const wall = this.arrived.wall === null ? "" : ` (${iso(this.arrived.wall)})`;
    let head =
      `tray ${this.tray}${wall}, ${clock(this.arrived.t)} to ${clock(this.left.t)}: ${this.removed.length} removed, ` +
      `${this.added.length} added, ${this.moved.length} moved`;
    if (!this.complete) {
      const parts: string[] = [];
      if (this.unclear > 0) parts.push(`${this.unclear} unclear`);
      if (this.unsure > 0) parts.push(`${this.unsure} not sure`);
      head += `, not complete: ${parts.join(", ")}`;
    }
    return [head, ...[...this.removed, ...this.added, ...this.moved].map((c) => `  ${c.describe()}`)].join("\n");
  }

  toJSON(): Record<string, unknown> {
    return {
      session: this.session,
      video: this.video,
      tray: this.tray,
      arrived: this.arrived,
      left: this.left,
      stones: this.stones,
      removed: this.removed.map((c) => c.toJSON()),
      added: this.added.map((c) => c.toJSON()),
      moved: this.moved.map((c) => c.toJSON()),
      unclear: this.unclear,
      unsure: this.unsure,
      complete: this.complete,
    };
  }
}

function median(xs: readonly number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const k = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? (v[k] as number) : ((v[k - 1] as number) + (v[k] as number)) / 2;
}

/** The report of a tray that has left (4.7), from its facts and its final tray stones; null for any other. */
export function trayReport(tray: Tray): TrayReport | null {
  const facts = tray.facts;
  if (tray.arrived === null || tray.leaving === null || facts.length === 0) return null;
  const arrival = facts[0] as TrayFact;
  const leaving = facts[facts.length - 1] as TrayFact;
  if (leaving.kind !== "leaving") return null;
  const byId = new Map(tray.stones.map((s) => [s.id, s]));
  const changes = (kind: "removed" | "added"): TrayChange[] => {
    const out: TrayChange[] = [];
    for (const x of facts) {
      const s = x.kind === kind && x.stone !== null ? byId.get(x.stone) : undefined;
      if (s === undefined) continue;
      // its final place: where it was last seen before it was taken, or as the tray left
      const place = kind === "removed" || s.leftPlace === null ? s.place : s.leftPlace;
      const certain = x.certain === true;
      // its confidence (4.6.13): by the stone's evidence, set as its tray left (a stone made by hand without it has
      // no leaving answer: undecided)
      const conf = CONFIDENCE[kind][certain ? "certain" : "unclear"][s.evidence ?? "undecided"];
      out.push(
        new TrayChange(kind, s.id, { g: x.g, t: x.t, wall: x.wall }, certain, x.code, place, s.size, null, conf),
      );
    }
    return out;
  };
  // moved: only the stones it arrived with that are sure (a stone not sure counts as not sure, not as moved), at
  // their place at the leaving point (where they were seen), and only those something touched
  const kept: [TrayStone, readonly [number, number]][] = [];
  for (const s of tray.stones) {
    if (!s.added && s.status === "on" && s.sure && s.leftPlace !== null) kept.push([s, s.leftPlace]);
  }
  const moved: TrayChange[] = [];
  if (kept.length > 0) {
    // the tray's own shift: the median over the half of them that moved least (ties in tray order)
    const order = kept
      .map(([s, p], i) => [dist(s.firstPlace, p), i] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const least = order
      .slice(0, Math.floor((kept.length + 1) / 2))
      .map(([, i]) => kept[i] as [TrayStone, readonly [number, number]]);
    const mx = median(least.map(([s, p]) => p[0] - s.firstPlace[0]));
    const my = median(least.map(([s, p]) => p[1] - s.firstPlace[1]));
    for (const [s, p] of kept) {
      const d = dist([s.firstPlace[0] + mx, s.firstPlace[1] + my], p);
      if (s.touched !== null && d > MOVED * s.size[1])
        moved.push(new TrayChange("moved", s.id, null, true, null, p, s.size, round3(d), MOVED_CONFIDENCE));
    }
  }
  const unsure = tray.stones.filter((s) => s.status === "on" && !s.sure && !(s.added && s.certain === false)).length;
  const unclear = leaving.unclear ?? 0;
  return new TrayReport({
    session: tray.session,
    video: tray.video,
    tray: tray.n,
    arrived: { g: arrival.g, t: arrival.t, wall: arrival.wall },
    left: { g: leaving.g, t: leaving.t, wall: leaving.wall },
    stones: arrival.stones ?? 0,
    removed: changes("removed"),
    added: changes("added"),
    moved,
    unclear,
    unsure,
    complete: unclear === 0 && leaving.sure === leaving.stones,
  });
}

/**
 * The `trays` counts of the summary: trays opened and arrived, tray stones at the arrivals, certain and unclear facts,
 * and tray stones that stopped being sure.
 */
export interface TrayCounts {
  /** Trays (static stops of at least 2 s). */
  total: number;
  /** Trays that arrived and settled. */
  arrived: number;
  /** Tray stones at the arrivals. */
  stones: number;
  /** Certain additions. */
  added: number;
  /** Unclear additions. */
  addedUnclear: number;
  /** Certain removals. */
  removed: number;
  /** Unclear removals. */
  removedUnclear: number;
  /** Tray stones that stopped being sure. */
  unsure: number;
}

/** Counts of nothing. */
export function zeroTrayCounts(): TrayCounts {
  return {
    total: 0,
    arrived: 0,
    stones: 0,
    added: 0,
    addedUnclear: 0,
    removed: 0,
    removedUnclear: 0,
    unsure: 0,
  };
}

/** An `identified` fact of the leaving's speckle answer (a `speckle_*` code, 4.6.13). */
const bySpeckle = (x: TrayFact): boolean => x.kind === "identified" && SPECKLE.has(x.code);

/**
 * `Tray.check()`: the broken codes of the self-check (4.6.10), sorted. A tray that never arrived has nothing to check;
 * one that has not left yet breaks C1.
 */
export function checkTray(tray: Tray): string[] {
  const bad = new Set<string>();
  const facts = tray.facts;
  if (tray.arrived === null && facts.length === 0 && tray.stones.length === 0) return [];
  const first = facts[0];
  const last = facts[facts.length - 1];
  if (first?.kind !== "arrived" || last?.kind !== "leaving") bad.add("C1");
  if (facts.slice(0, -1).some((x) => x.kind === "leaving")) bad.add("C1");
  const byId = new Map(tray.stones.map((s) => [s.id, s]));
  if (byId.size !== tray.stones.length || facts.some((x) => x.stone !== null && !byId.has(x.stone))) bad.add("C2");
  const life = new Map<string, TrayFact[]>();
  for (const x of facts) {
    if (x.stone === null) continue;
    const xs = life.get(x.stone);
    if (xs === undefined) life.set(x.stone, [x]);
    else xs.push(x);
  }
  for (const xs of life.values()) {
    const kinds = xs.map((x) => x.kind);
    const count = (k: TrayFactKind): number => kinds.filter((x) => x === k).length;
    if (kinds.slice(1).includes("added") || count("unsure") > 1 || count("removed") > 1) bad.add("C3");
    xs.forEach((x, a) => {
      const k = x.kind;
      const after = xs.slice(a + 1);
      const before = kinds.slice(0, a);
      const speckle = bySpeckle(x);
      // after an unsure fact only a removal, or an identified fact of the leaving's speckle (4.6.13)
      if (k === "unsure" && after.some((y) => y.kind !== "removed" && !bySpeckle(y))) bad.add("C3");
      if (k === "removed" && after.length > 0) bad.add("C3");
      if (k === "identified" && (before.includes("removed") || (!speckle && before.includes("unsure")))) bad.add("C3");
      if (speckle && xs.slice(0, a).some(bySpeckle)) bad.add("C3"); // at most one of the leaving's speckle
    });
  }
  for (const s of tray.stones) {
    const xs = life.get(s.id) ?? [];
    const rem = xs.filter((x) => x.kind === "removed");
    if ((s.status === "removed") !== rem.length > 0 || (rem.length > 0 && rem[0]?.certain !== s.certain)) bad.add("C4");
    // sure exactly when no unsure fact comes after its identified fact of the leaving's speckle (if any)
    const unsure = xs.slice(xs.map(bySpeckle).lastIndexOf(true) + 1).some((x) => x.kind === "unsure");
    if (s.status === "on" && s.sure !== (!unsure && !(s.added && s.certain !== true))) bad.add("C4");
    if (s.question !== null) bad.add("C4");
  }
  const on = tray.stones.filter((s) => s.status === "on");
  if (first?.kind === "arrived" && first.stones !== tray.stones.filter((s) => !s.added).length) bad.add("C5");
  if (last?.kind === "leaving") checkLeaving(tray, last, on, byId, bad);
  const worlds = new Set(on.map((s) => s.worldId));
  if (worlds.size !== on.length || worlds.has(null)) bad.add("C6");
  for (const x of facts) {
    if (x.kind !== "identified") continue;
    const reached = x.score !== null && x.bar !== null && x.score >= x.bar && x.certain === null;
    if (SPECKLE.has(x.code)) {
      // one of the leaving's speckle (4.6.13): its bar is SPECKLE_CLEAN
      if (!reached || x.bar !== SPECKLE_CLEAN) bad.add("C9");
    } else if (!reached || x.bar < T_ID_MIN || (x.margin !== null && x.margin < M_ID)) bad.add("C9");
  }
  return [...bad].sort();
}

/** A stone the account settled: on the tray and sure, or removed for certain. */
const settled = (s: TrayStone): boolean =>
  (s.status === "on" && s.sure) || (s.status === "removed" && s.certain === true);

/** The leaving fact's counts and open list (C5), its entries (C7) and their candidates (C8). */
function checkLeaving(
  tray: Tray,
  leave: TrayFact,
  on: readonly TrayStone[],
  byId: ReadonlyMap<string, TrayStone>,
  bad: Set<string>,
): void {
  const want = [
    on.length,
    on.filter((s) => s.sure).length,
    tray.facts.filter((x) => x.kind === "added" && x.certain === true).length,
    tray.facts.filter((x) => x.kind === "removed" && x.certain === true).length,
    tray.facts.filter((x) => (x.kind === "removed" || x.kind === "added") && x.certain !== true).length,
  ];
  const got = [leave.stones, leave.sure, leave.added, leave.removed, leave.unclear];
  if (want.some((n, i) => n !== got[i])) bad.add("C5");
  const entries = leave.open ?? [];
  // one entry per open stone, in tray order
  const opened = entries.map((o) => o.stone);
  const wanted = tray.stones.filter((s) => !settled(s)).map((s) => s.id);
  if (opened.length !== wanted.length || wanted.some((id, i) => opened[i] !== id)) bad.add("C5");
  const sureWorld = new Set(on.filter((s) => s.sure).map((s) => s.worldId));
  for (const o of entries) {
    const c = o.candidates;
    const keys = new Set(c.map((x) => JSON.stringify([x.kind, x.worldId, x.stone])));
    const codes = o.kind === "unsure" ? UNSURE_CODES : o.kind === "removed" ? REMOVED_CAUSES : ADDED_CAUSES;
    const looks = LOOK_CODES.get(o.kind) ?? [];
    const tail = c[c.length - 1];
    if (!codes.includes(o.cause) || !looks.includes(o.look) || tail === undefined || keys.size !== c.length) {
      bad.add("C7");
    }
    if (tail === undefined) continue; // the checks below read the first and last candidate; C8 has nothing to check
    const head = c[0] as TrayCandidate;
    if (o.kind === "unsure" && (head.kind !== "world" || head.worldId !== o.worldId)) bad.add("C7");
    if (o.kind !== "added" && !c.some((x) => x.kind === "gone")) bad.add("C7");
    if ((o.kind === "removed" && tail.kind !== "unseen") || (o.kind === "added" && tail.kind !== "new")) bad.add("C7");
    for (const x of c) {
      const z = x.kind === "stone" && x.stone !== null ? byId.get(x.stone) : undefined;
      if ((z !== undefined && settled(z)) || (x.kind === "world" && sureWorld.has(x.worldId))) bad.add("C8");
    }
  }
}

/**
 * The golden `open.txt` form (4.6.9): every `leaving` fact's describe() line (with ` (bar 0.xxx)` when the tray took a
 * look), then its open entries indented two spaces, `\n` after every line.
 */
export function describeOpenTxt(facts: Iterable<TrayFact>): string {
  const lines: string[] = [];
  for (const x of facts) {
    if (x.kind !== "leaving") continue;
    lines.push(x.describe() + (x.tId === null ? "" : ` (bar ${milli(x.tId)})`));
    for (const o of x.open ?? []) lines.push(`  ${o.describe()}`);
  }
  return lines.map((line) => `${line}\n`).join("");
}

// ---- geometry (all doubles, the same in every SDK) ------------------------------------------------------------------

type P = readonly [number, number];

function dist(a: P, b: P): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function compatible(a: P, b: P): boolean {
  return (
    Math.abs(a[0] - b[0]) <= SIZE_TOL * Math.max(a[0], b[0]) && Math.abs(a[1] - b[1]) <= SIZE_TOL * Math.max(a[1], b[1])
  );
}

/** A world stone as the rules see it. */
interface Ws {
  readonly id: number;
  readonly held: boolean;
  readonly frozen: boolean;
  readonly detected: boolean;
  readonly pos: P;
  /** The quaternion's z and w. */
  readonly zw: P;
  readonly dims: P;
  /** Its look as sent (read by `usableCells`). */
  readonly look: unknown;
}

/** A world stone with an id and a usable solid (at least 2 numbers in pos and dims and 4 in q), else null. */
function worldStone(s: StoneView): Ws | null {
  const solid = s.solid as Partial<Solid> | null | undefined;
  const pos = solid?.pos;
  const dims = solid?.dims;
  const q = solid?.q;
  if (typeof s.id !== "number" || !pos || pos.length < 2 || !dims || dims.length < 2 || !q || q.length < 4) return null;
  return {
    id: s.id,
    held: HELD.has(s.mode),
    frozen: s.shape === "frozen",
    detected: Boolean(s.detected),
    pos: [pos[0], pos[1]],
    zw: [q[2], q[3]],
    dims: [dims[0], dims[1]],
    look: s.look,
  };
}

function sizeOf(w: Ws): P {
  return [Math.max(w.dims[0], w.dims[1]), Math.min(w.dims[0], w.dims[1])];
}

/** The cosine and sine of the stone's turn about the vertical, from its quaternion, without trigonometry. */
function turn(w: Ws): P {
  const [z, ww] = w.zw;
  const n = ww * ww + z * z;
  if (n === 0) return [1, 0];
  return [(ww * ww - z * z) / n, (2 * z * ww) / n];
}

/** The stone's box, grown by `m`, covers the point `p`. */
function covers(w: Ws, p: P, m: number): boolean {
  const [c, s] = turn(w);
  const dx = p[0] - w.pos[0];
  const dy = p[1] - w.pos[1];
  return Math.abs(c * dx + s * dy) <= w.dims[0] / 2 + m && Math.abs(-s * dx + c * dy) <= w.dims[1] / 2 + m;
}

/** The largest share of this stone's box (5 x 5 points) that one other stone's box covers. */
function overlapShare(w: Ws, world: readonly Ws[]): number {
  const [c, s] = turn(w);
  const d = w.dims;
  const [x0, y0] = w.pos;
  const pts: P[] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const u = ((i + 0.5) / 5) * d[0] - d[0] / 2;
      const v = ((j + 0.5) / 5) * d[1] - d[1] / 2;
      pts.push([x0 + c * u - s * v, y0 + s * u + c * v]);
    }
  }
  const reach = Math.max(d[0], d[1]);
  let best = 0;
  for (const o of world) {
    if (o.id === w.id || dist(o.pos, w.pos) > (reach + Math.max(o.dims[0], o.dims[1])) / 2) continue;
    best = Math.max(best, pts.filter((p) => covers(o, p, 0)).length);
  }
  return best / 25;
}

function insideBoard(b: Rect | null, p: P): boolean {
  if (b === null) return true;
  const c = Math.cos(b.theta);
  const s = Math.sin(b.theta);
  const dx = p[0] - b.cx;
  const dy = p[1] - b.cy;
  return Math.abs(c * dx + s * dy) <= b.hw * 1.05 + 0.02 && Math.abs(-s * dx + c * dy) <= b.hh * 1.05 + 0.02;
}

/** The proleptic Gregorian date (year, month, day) of a day count since 1970-01-01. */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = pyDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = pyDiv(doe - pyDiv(doe, 1460) + pyDiv(doe, 36524) - pyDiv(doe, 146096), 365);
  const doy = doe - (365 * yoe + pyDiv(yoe, 4) - pyDiv(yoe, 100));
  const mp = pyDiv(5 * doy + 2, 153);
  const d = doy - pyDiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const pad = (x: number, n: number): string => String(x).padStart(n, "0");

/** A wall time (UTC epoch seconds) to the tenth of a second, rounded as `stamp()` rounds it: `2026-11-22T02:38:47.0Z`. */
export function iso(wall: number): string {
  const n = Math.floor(wall * 10 + 0.5);
  const secs = pyDiv(n, 10);
  const [y, m, d] = civilFromDays(pyDiv(secs, 86400));
  const r = pyMod(secs, 86400);
  return (
    `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(pyDiv(r, 3600), 2)}:${pad(pyDiv(pyMod(r, 3600), 60), 2)}:` +
    `${pad(pyMod(r, 60), 2)}.${pyMod(n, 10)}Z`
  );
}

/**
 * When a stone was first seen: the UTC wall time to the tenth (`20261122T023847.0Z`), else the session and the media
 * seconds (`s1795314878t22.5`: world ids start again in a new session, and a seek can show the same time again).
 */
export function stamp(wall: number | null, t: number, session: number | null): string {
  if (wall === null) return `s${session ?? 0}t${fmt(t, 1)}`;
  const n = Math.floor(wall * 10 + 0.5);
  const secs = pyDiv(n, 10);
  const [y, m, d] = civilFromDays(pyDiv(secs, 86400));
  const r = pyMod(secs, 86400);
  return (
    `${pad(y, 4)}${pad(m, 2)}${pad(d, 2)}T${pad(pyDiv(r, 3600), 2)}${pad(pyDiv(pyMod(r, 3600), 60), 2)}` +
    `${pad(pyMod(r, 60), 2)}.${pyMod(n, 10)}Z`
  );
}

// ---- the rules ------------------------------------------------------------------------------------------------------

/** A world event as the rules see it. */
interface Ev {
  readonly type: string;
  readonly id: number | null;
  /** A hand event: lift, hinge, carry, place, drop, gone, or a push with a side. */
  readonly hand: boolean;
  /** A delete because a hand emptied the place. */
  readonly byHand: boolean;
  /** A delete because a hand took the stone: why `hand` or `carried-away` (a busy frame, 4.6.1). */
  readonly took: boolean;
}

/** A frame's world as the rules see it: the stones with a usable solid, and of a world id the frame has twice the first. */
interface TrayWorld {
  readonly r: FrameRef;
  readonly stones: readonly Ws[];
  /** The stone of each id. */
  readonly byId: ReadonlyMap<number, Ws>;
  readonly events: readonly Ev[];
  /** Both hands free (or without a state). */
  readonly free: boolean;
  /** A hand is flagged `untrusted`. */
  readonly untrusted: boolean;
  /** Every stone confirmed (`stats.confirmed == stats.stones`). */
  readonly confirmed: boolean;
  readonly board: Rect | null;
}

const handFree = (h: HandState | undefined): boolean => (h?.state ?? "free") === "free";
const handUntrusted = (h: HandState | undefined): boolean => Boolean(h?.untrusted);

function trayWorld(w: WorldLayer, r: FrameRef): TrayWorld {
  const stones: Ws[] = [];
  const byId = new Map<number, Ws>();
  const seen = new Set<unknown>();
  for (const s of w.stones ?? []) {
    const first = !seen.has(s.id);
    seen.add(s.id);
    const ws = first ? worldStone(s) : null;
    if (ws === null) continue; // the rules leave out a stone without a usable solid, and a world id's later stones
    stones.push(ws);
    byId.set(ws.id, ws);
  }
  const events = (w.events ?? []).map(
    (e): Ev => ({
      type: e.type,
      id: typeof e.id === "number" ? e.id : null,
      hand: HAND_EVENTS.has(e.type) || (e.type === "push" && Boolean(e.side)),
      byHand: e.type === "delete" && e.why === "hand",
      took: e.type === "delete" && (e.why === "hand" || e.why === "carried-away"),
    }),
  );
  return {
    r,
    stones,
    byId,
    events,
    free: handFree(w.hands?.left) && handFree(w.hands?.right),
    untrusted: handUntrusted(w.hands?.left) || handUntrusted(w.hands?.right),
    confirmed: (w.stats?.confirmed ?? null) === (w.stats?.stones ?? null),
    board: w.draw?.board ?? null,
  };
}

/** A verified positive observation of a track at the departure boundary. */
interface BoundaryObservation {
  readonly calmG: number;
  readonly stone: Ws;
  latest: Ws;
  readonly t: number;
  readonly neighbours: Set<number>;
}

/** A world stone no tray stone stands for (yet). */
interface Unid {
  /** Consecutive inventory history for a possible observation just after the leaving point. */
  lastFrame: number | null;
  positiveFrames: number;
  boundary: BoundaryObservation | null;
  readonly born: FrameRef;
  place: P;
  size: P;
  seen: number;
  last: P | null;
  /** A look decision unlinked it (4.6.5): never added for certain. */
  readonly freed: boolean;
  /** A size change of a linked world stone made it (4.6.1 step 4): never added for certain. */
  readonly resized: boolean;
}

const unidOf = (w: Ws, born: FrameRef, freed = false, resized = false): Unid => ({
  born,
  lastFrame: null,
  positiveFrames: 0,
  boundary: null,
  place: w.pos,
  size: sizeOf(w),
  seen: 0,
  last: null,
  freed,
  resized,
});

/** A stored look of a world stone (4.6.3): the frame it came on, the stone's place and size there. */
interface Look {
  readonly wid: number;
  readonly cells: LookCells;
  readonly g: number;
  readonly t: number;
  readonly place: P;
  readonly size: P;
  taken: boolean;
  /** The world stone was detected on the look's frame: only such a look is an anchor. */
  readonly detected: boolean;
}

/**
 * An unseen run's first sight (4.6.1, presence questions): when and where its stone was first detected after the run's
 * first calm moment, whether a busy frame or a push frame came from its last sight up to then, and whether another
 * world stone of its size stood within NEAR of the place where it was last seen.
 */
interface Again {
  readonly t: number;
  readonly place: P;
  readonly busy: boolean;
  readonly push: boolean;
  readonly crowd: boolean;
}

/**
 * A stone's unseen run (4.6.1, presence questions): its world id, the place and the time it was last seen (`s1`), the
 * time of the run's first calm moment (`c1`), at which its world stone was not detected, and its first sight after
 * that calm moment.
 */
interface Watch {
  readonly wid: number;
  readonly place: P;
  readonly seenT: number;
  readonly c1T: number;
  again: Again | null;
  /**
   * A busy or push frame later than `c1` came while its world stone was not detected, or frames the rules could not
   * read came (4.6.1).
   */
  spoilt: boolean;
}

/** An unseen run that is not spoilt. */
const newWatch = (wid: number, place: P, seenT: number, c1T: number, again: Again | null = null): Watch => ({
  wid,
  place,
  seenT,
  c1T,
  again,
  spoilt: false,
});

/** A doubt held open for a look to settle, or for the stone's next sight (a presence question, 4.6.1). */
interface Question {
  readonly cause: string;
  readonly why: string;
  since: number;
  readonly opened: FrameRef;
  /**
   * A presence question (4.6.1): the unseen run it was opened with, kept until the question is settled or ends; seeing
   * the stone again settles it.
   */
  watch: Watch | null;
}

/** A pair of the look step: (world id or tray index, permille score or null, its pair count or null). */
type Pair = readonly [number, number | null, number | null];

/** A decided pair: the row, the world stone, its score, margin and bar. */
interface Best {
  readonly row: number;
  readonly wid: number;
  readonly score: number;
  readonly margin: number | null;
  readonly bar: number;
}

/**
 * One run of the look step (4.6.5): rows (tray index, since), columns (world ids), each row's pairs, each pair's
 * (bar, best rival) by `row,world id`, and the decided pair with the highest score.
 */
interface Run {
  readonly rows: readonly (readonly [number, number])[];
  readonly cols: readonly number[];
  readonly pairs: ReadonlyMap<number, readonly Pair[]>;
  readonly info: ReadonlyMap<string, readonly [number, number | null]>;
  readonly best: Best | null;
}

/** A tray stone's working state. */
interface St {
  readonly id: string;
  readonly index: number;
  world: number | null;
  worldT: number;
  size: P;
  frozen: boolean;
  place: P;
  seenT: number;
  readonly born: FrameRef;
  /** Its place when it was made. */
  readonly firstPlace: P;
  status: TrayStoneStatus;
  /** Not given up: a stone in question keeps it (its view's `sure` is false meanwhile). */
  sure: boolean;
  added: boolean;
  certain: boolean | null;
  lostT: number;
  lostK: number;
  carriedAway: boolean;
  dropped: boolean;
  emptied: boolean;
  handled: boolean;
  pushed: boolean;
  ghost: number;
  /** The snapshot the stone was last on the tray at, and its place there. */
  atK: number;
  at: P;
  // by look (4.6.3-4.6.8)
  chain: Look[];
  question: Question | null;
  doubted: boolean;
  byLook: boolean;
  lookLost: boolean;
  lostByLook: boolean;
  lifted: boolean;
  /** The frame of its latest disturbance since the snapshot. */
  disturbed: number | null;
  lostG: number;
  late: boolean;
  box: boolean;
  unsureCode: string;
  unsureFromT: number;
  unidRec: Unid | null;
  leftNow: boolean;
  addedNow: boolean;
  open: TrayOpen | null;
  /** A world stone a look unlinked was pushed next to it since the snapshot (doubted as a neighbour). */
  freedPush: boolean;
  /** Its place at the latest calm frame, if it was on the tray and seen in it (4.7). */
  calmPlace: P | null;
  /** Its place at the leaving point, if it was on the tray and seen there (4.7). */
  leftPlace: P | null;
  /** The frame where something last touched it: a disturbance, or a link to another world stone (4.7). */
  touched: number | null;
  /** The stone in the newest speckle answer read while the tray was on (4.6.12). */
  speckle: StoneSpeckle | null;
  /** The world id it was made with: for a stone the tray arrived with, its arrival world id (4.6.13). */
  readonly firstWorld: number;
  /** The leaving's speckle answer linked or confirmed it (4.6.13). */
  bySpeckle: boolean;
  /** What the leaving's speckle answer found of it at the other moment, set as the tray leaves (4.6.13). */
  evidence: TrayStoneEvidence | null;
  /** Its current unseen run (4.6.1, presence questions); it ends when the stone is seen at a calm moment or lost. */
  run1: Watch | null;
  /**
   * Its current unseen run is on probation: it began at a calm moment that settled the stone's presence question
   * without showing it, so the calm moment that shows it again must settle that run too (4.6.1).
   */
  once: boolean;
  /** The latest time it was handled (a `lift`, `carry`, `hinge` or `place` on its link) or held (4.6.1). */
  handledT: number | null;
  /**
   * The latest time a hand touched its link: a hand event, a `push` with a `side`, or a `delete` with why `hand` or
   * `carried-away` on its world id (4.6.1, certain removals).
   */
  handT: number | null;
  /** The time of the last calm moment before its latest loss (4.6.1, certain removals). */
  lostCalmT: number;
}

/** The last observed row and its contemporaries, kept through at most two omitted frames. */
interface Blink {
  first: FrameRef;
  prior: Ws;
  previousRows: readonly Ws[];
  neighbours: ReadonlySet<number>;
  unid?: Unid;
}

/** The returning track must be strictly closer to its own prior position than to a compatible peer. */
function sameBlinkStone(row: Ws, blink: Blink): boolean {
  const distance = dist(row.pos, blink.prior.pos);
  const size = sizeOf(row);
  return (
    distance <= RENAME_D &&
    compatible(size, sizeOf(blink.prior)) &&
    !blink.previousRows.some(
      (other) =>
        other.id !== row.id &&
        other.detected &&
        !other.held &&
        compatible(size, sizeOf(other)) &&
        dist(row.pos, other.pos) <= distance,
    )
  );
}

function observedPlace(s: St, tw: TrayWorld): P | null {
  const ws = s.world === null ? undefined : tw.byId.get(s.world);
  return s.status === "on" && ws?.detected && !ws.held ? ws.pos : null;
}

/** A complete observation from this visit with the links and positions seen there. */
interface VisitSnapshot {
  world: TrayWorld;
  places: Map<St, { id: number; pos: P }>;
}

/** The open tray's working state (dropped when it leaves; what is kept is its {@link Tray}). */
interface OpenTray {
  readonly n: number;
  readonly ids: Set<number>;
  arrived: FrameRef | null;
  leaving: FrameRef | null;
  board: Rect | null;
  readonly stones: St[];
  readonly link: Map<number, St>;
  unid: Map<number, Unid>;
  /** Brief absences. An unidentified stone is parked here while its row is missing. */
  readonly blinks: Map<number, Blink>;
  /** First frame of each brief inventory omission, including tracks without a tray link. */
  readonly missingSince: Map<number, number>;
  readonly marks: [number, P][];
  k: number;
  settleT: number;
  calmRef: FrameRef | null;
  calmWorld: TrayWorld | null;
  /** The leaving point's world (set as the tray leaves: its positive evidence at departure). */
  leaveWorld: TrayWorld | null;
  worked: boolean;
  last: TrayWorld | null;
  unclear: number;
  /** The tray's certain additions (its leaving counts them, also a stone removed unclear later). */
  certainAdded: number;
  readonly facts: TrayFact[];
  // by look (4.6.3-4.6.8): the look store, the gauge, twins, a memo of scores, the leaving's last run
  readonly store: Map<number, Look>;
  alike: number | null;
  alikeN: number;
  took: boolean;
  readonly twins: Set<string>;
  readonly memo: Map<string, readonly [number, number] | null>;
  idsAtArrival: ReadonlySet<number>;
  lastRun: Run | null;
  open: TrayOpen[] | null;
  /**
   * A look changed a link, doubted a stone v1 trusts, or kept a twin from v1's certain removal: links and trust may
   * differ from v1's from here on, so no certain removal or addition after it (4.6.7).
   */
  relinked: boolean;
  /** The time of the tray's latest hand mark: a look older than it settles no question. */
  lastMarkT: number | null;
  /**
   * The time of the latest busy frame: a hand not free or flagged `untrusted`, a hand event, a held world stone, or a
   * `delete` why `hand` or `carried-away` (4.6.1, presence questions); a frame after frames the rules could not read
   * is one too.
   */
  busyT: number | null;
  /**
   * The time of the latest push frame: a `push` event (any id, with a side or not), or a frame after frames the rules
   * could not read (4.6.1).
   */
  pushT: number | null;
  /** The frame `g` of the last snapshot. */
  settleG: number | null;
  /** The links as the tray arrived (world id to tray stone id), for the speckle answers (4.6.12). */
  arrivalLinks: ReadonlyMap<number, string>;
  /** The unit's speckle answers read for the tray while it was on, oldest first (4.6.13). */
  readonly answers: WorldSpeckle[];
  /** The leaving's answer (4.6.13), set as the tray leaves (null when none is the leaving's). */
  leavingAnswer: WorldSpeckle | null;
}

/**
 * The tray stone id `id`, or, when one of the tray's `stones` already has it (a stone and its world id seen again within
 * the same tenth of a second), the first of `id`-2, `id`-3, ... that none has (4.6). Exported for the tests.
 */
export function uniqueId(stones: readonly { readonly id: string }[], id: string): string {
  const taken = new Set(stones.map((s) => s.id));
  let uid = id;
  for (let k = 2; taken.has(uid); k++) uid = `${id}-${k}`;
  return uid;
}

function newStone(tr: OpenTray, id: string, w: Ws, born: FrameRef): St {
  return {
    id: uniqueId(tr.stones, id),
    index: tr.stones.length,
    world: w.id,
    worldT: born.t,
    size: sizeOf(w),
    frozen: w.frozen,
    place: w.pos,
    seenT: born.t,
    born,
    firstPlace: w.pos,
    status: "on",
    sure: true,
    added: false,
    certain: null,
    lostT: 0,
    lostK: 0,
    carriedAway: false,
    dropped: false,
    emptied: false,
    handled: false,
    pushed: false,
    ghost: 0,
    atK: -1,
    at: [0, 0],
    chain: [],
    question: null,
    doubted: false,
    byLook: false,
    lookLost: false,
    lostByLook: false,
    lifted: false,
    disturbed: null,
    lostG: 0,
    late: false,
    box: false,
    unsureCode: "",
    unsureFromT: 0,
    unidRec: null,
    leftNow: false,
    addedNow: false,
    open: null,
    freedPush: false,
    calmPlace: null,
    leftPlace: null,
    touched: null,
    run1: null,
    once: false,
    handledT: null,
    handT: null,
    lostCalmT: 0,
    speckle: null,
    firstWorld: w.id,
    bySpeckle: false,
    evidence: null,
  };
}

const stoneView = (s: St): TrayStone =>
  new TrayStone({
    id: s.id,
    worldId: s.world,
    status: s.status,
    sure: s.sure && s.question === null,
    added: s.added,
    certain: s.certain,
    born: s.born,
    place: s.place,
    size: s.size,
    question:
      s.question === null
        ? null
        : new TrayQuestion(s.question.cause, s.question.why, s.question.since, s.question.opened),
    looks: s.chain.map((e) => e.g),
    byLook: s.byLook,
    lookLost: s.lookLost,
    open: s.open,
    firstPlace: s.firstPlace,
    leftPlace: s.leftPlace,
    touched: s.touched,
    speckle: s.speckle,
    bySpeckle: s.bySpeckle,
    evidence: s.evidence,
  });

const byNumber = (a: number, b: number): number => a - b;
/** Nearest first, then by the key. */
const byNear = (a: readonly [number, number], b: readonly [number, number]): number => a[0] - b[0] || a[1] - b[1];

/**
 * On the tray and sure, never in question or not sure on this tray, and not linked by a look: without looks exactly
 * v1's "on the tray and sure".
 */
const trusted = (s: St): boolean => s.status === "on" && s.sure && !s.doubted && !s.byLook;

/** Sure, not in question, never lifted on this tray and not disturbed since the last snapshot. */
const untouched = (s: St): boolean => s.sure && s.question === null && !s.lifted && s.disturbed === null;

/** The first frame whose looks count for a hand doubt: after the stone's latest disturbance (4.6.4). */
export const sinceOf = (s: Pick<St, "disturbed">, r: FrameRef): number =>
  s.disturbed === null ? r.g : s.disturbed + 1;

function handsNear(tr: OpenTray, since: number, places: readonly P[]): boolean {
  for (let i = tr.marks.length - 1; i >= 0; i--) {
    const [t, p] = tr.marks[i] as [number, P];
    if (t < since) break;
    if (places.some((q) => dist(p, q) <= HAND_R)) return true;
  }
  return false;
}

/**
 * A world stone could be this lost stone: unidentified, or standing for a tray stone that is not trusted, of a
 * compatible size, first seen after it was last seen (less RENAME_T) or at its place.
 */
/**
 * A hand touched the lost stone's link from its last calm moment (or RENAME_T before it was last seen, if that is
 * earlier) up to its loss: a stone does not leave a tray by itself (4.6.1, certain removals).
 */
function handTook(s: St): boolean {
  return s.handT !== null && s.handT >= Math.min(s.lostCalmT, s.seenT - RENAME_T);
}

function rivals(tr: OpenTray, s: St): boolean {
  const near = (size: P, t: number, place: P): boolean =>
    compatible(size, s.size) && (t >= s.seenT - RENAME_T || dist(place, s.place) <= RENAME_D);
  for (const u of tr.unid.values()) if (near(u.size, u.born.t, u.place)) return true;
  return tr.stones.some((o) => o.status === "on" && !trusted(o) && near(o.size, o.worldT, o.place));
}

/**
 * A stored look still describes its stone: the stone is here, not held, within NEAR of where the look was read, and no
 * hand mark after the look lies within HAND_R of that place.
 */
function fresh(tr: OpenTray, e: Look, tw: TrayWorld): boolean {
  const ws = tw.byId.get(e.wid);
  if (ws === undefined || ws.held || dist(ws.pos, e.place) > NEAR) return false;
  for (let i = tr.marks.length - 1; i >= 0; i--) {
    const [t, p] = tr.marks[i] as [number, P];
    if (t <= e.t) break;
    if (dist(p, e.place) <= HAND_R) return false;
  }
  return true;
}

/** The tray's bar by look (4.6.3), in permille. */
const tIdOf = (tr: OpenTray): number =>
  tr.alike === null || tr.alikeN < GAUGE_MIN ? T_ID_START : Math.max(T_ID_MIN, tr.alike + GAP);

/** (permille score, pairs) of look a against look b, or null; each pair of looks is scored once a tray. */
function scoreOf(tr: OpenTray, a: Look, b: Look): readonly [number, number] | null {
  const key = `${a.wid},${a.g},${b.wid},${b.g}`;
  let x = tr.memo.get(key);
  if (x === undefined) {
    const r = pairCells(a.cells, b.cells);
    x = r === null ? null : [lookPermille(r[0]), r[1]];
    tr.memo.set(key, x);
  }
  return x;
}

/**
 * A tray stone's chain against a look L: against its anchor, or its latest when that scores higher; a chain look that
 * is L itself (the same world stone and frame) is not scored.
 */
function chainScore(tr: OpenTray, s: St, look: Look): readonly [number, number] | null {
  let best: readonly [number, number] | null = null;
  for (const c of s.chain) {
    if (c.wid === look.wid && c.g === look.g) continue;
    const x = scoreOf(tr, look, c);
    if (x !== null && (best === null || x[0] > best[0])) best = x;
  }
  return best;
}

/**
 * The leaving's evidence (4.6.1, Leaving; 4.6.7, step 4) that the unidentified world stone W is the lost tray stone S,
 * which a pair needs: their looks agree (S's chain against W's stored look: at least the tray's bar over at least N_ID
 * cells); or, when the looks do not disagree (below T_DIFF over at least N_ID cells), nothing could have put another
 * stone there: W was first seen at or after S was last seen, less RENAME_T, and no hand mark from the earliest of S's
 * last sight, S's loss and W's first sight, less RENAME_T, lies within HAND_R of S's place or of W's. Exported for
 * the unit tests (not from the package).
 */
export function sameStone(tr: OpenTray, s: St, wid: number, u: Unid): boolean {
  const e = tr.store.get(wid);
  const x = e !== undefined && s.chain.length > 0 ? chainScore(tr, s, e) : null;
  if (x !== null && x[1] >= N_ID) {
    if (x[0] >= tIdOf(tr)) return true;
    if (x[0] < T_DIFF) return false;
  }
  return (
    u.born.t >= s.seenT - RENAME_T &&
    !handsNear(tr, Math.min(s.seenT, s.lostT, u.born.t) - RENAME_T, [s.place, u.place])
  );
}

/** Makes `look` the latest of the stone's chain, after its anchor. */
function setLatest(s: St, look: Look): void {
  s.chain = [s.chain[0] as Look, look]; // only a stone with a chain has a latest look
}

/** A pair of a row or a column with a world stone or tray stone `key`, from its chain score. */
const pairOf = (key: number, x: readonly [number, number] | null): Pair =>
  x === null ? [key, null, null] : [key, x[0], x[1]];

/** The pair reaches the tray's bar `tid` with enough cells. */
const hits = (p: Pair, tid: number): boolean => p[1] !== null && p[2] !== null && p[1] >= tid && p[2] >= N_ID;

/**
 * When an open world stone was first seen on this tray: its unidentified record, or its tray stone's link.
 */
function firstSeen(tr: OpenTray, wid: number): number {
  const u = tr.unid.get(wid);
  return u === undefined ? (tr.link.get(wid) as St).worldT : u.born.t;
}

/**
 * A tray stone without a chain (not `s`) could be on world stone `wid`: linked to it, within D_NEIGH of it, or
 * disturbed since the last snapshot within D_MATCH of it. No score rules it out, so no decision on `wid`.
 */
export function unscored(tr: Pick<OpenTray, "stones">, s: St, wid: number, here: P, size: P): boolean {
  return tr.stones.some((o) => {
    if (o === s || o.status === "removed" || o.chain.length > 0 || !compatible(o.size, size)) return false;
    const d = dist(o.place, here);
    return (o.status === "on" && o.world === wid) || d <= D_NEIGH || (o.disturbed !== null && d <= D_MATCH);
  });
}

// ---- presence questions (4.6.1) ----

/** A stone's open unseen runs: its own, and its presence question's (null where there is none). */
const runsOf = (s: St): readonly (Watch | null)[] => [s.run1, s.question === null ? null : s.question.watch];

/**
 * Frames the rules could not read came before the frame at `t`: it counts as a busy and a push frame, and every open
 * unseen run (a stone's, and a presence question's) is spoilt, its stone detected or not (4.6.1).
 */
function unread(tr: OpenTray, t: number): void {
  tr.busyT = tr.busyT === null ? t : Math.max(tr.busyT, t);
  tr.pushT = tr.pushT === null ? t : Math.max(tr.pushT, t);
  for (const s of tr.stones) for (const rec of runsOf(s)) if (rec !== null) rec.spoilt = true;
}

/**
 * Another world stone of the stone's size within NEAR of the place where it was last seen before its unseen run: a
 * sight there can not tell the two apart (4.6.1).
 */
function crowded(s: St, w: Watch, tw: TrayWorld): boolean {
  return tw.stones.some(
    (ws) => ws.id !== w.wid && !ws.held && compatible(sizeOf(ws), s.size) && dist(ws.pos, w.place) <= NEAR,
  );
}

/**
 * A look of the stone's world stone read since it was last seen, still fresh, that reaches the bar against the chain
 * of another tray stone the look step pairs looks with (lost, or on the tray in question): that stone may be on this
 * world stone, so no sight settles the question (4.6.1).
 */
function lookAgainst(tr: OpenTray, s: St, w: Watch, tw: TrayWorld): boolean {
  const e = tr.store.get(w.wid);
  if (e === undefined || e.t <= w.seenT || !fresh(tr, e, tw)) return false;
  const bar = tIdOf(tr);
  for (const o of tr.stones) {
    if (o === s || o.chain.length === 0 || !o.sure || !compatible(o.size, e.size)) continue;
    if (!(o.status === "lost" || (o.status === "on" && o.question !== null))) continue;
    const sc = chainScore(tr, o, e);
    if (sc !== null && sc[0] >= bar && sc[1] >= N_ID) return true;
  }
  return false;
}

/**
 * Nothing could have changed the stone since it was last seen (4.6.1): its run is not spoilt, it was not handled or
 * held since, no hand mark since lies within HAND_R of its last place or of its place now, and no look of its world
 * stone since shows another open stone ({@link lookAgainst}).
 */
function watchOpen(tr: OpenTray, s: St, w: Watch, tw: TrayWorld): boolean {
  if (s.handledT !== null && s.handledT >= w.seenT) return false;
  if (w.spoilt) return false;
  if (handsNear(tr, w.seenT, [w.place, s.place])) return false;
  return !lookAgainst(tr, s, w, tw);
}

/**
 * The sight half of a settle (4.6.1, presence questions): linked to the run's world stone; first seen after the run's
 * first calm moment within NEAR of where it was last seen before the run, with no busy or push frame from that last
 * sight up to then and no other stone of its size within NEAR of that place then; seen within NEAR of that place last,
 * after that calm moment; and no other stone of its size within NEAR of it now.
 */
function seenAgain(s: St, w: Watch, tw: TrayWorld): boolean {
  const a = w.again;
  if (a === null || dist(a.place, w.place) > NEAR || a.busy || a.push || a.crowd) return false;
  return (
    s.status === "on" && s.world === w.wid && s.seenT > w.c1T && dist(s.place, w.place) <= NEAR && !crowded(s, w, tw)
  );
}

/**
 * The leaving may leave the last snapshot's own frame uncounted for this stone (4.6.1, Leaving): its unseen run is
 * open ({@link watchOpen}), and no busy frame and no push frame came since it was last seen.
 */
function cleanSince(tr: OpenTray, s: St, tw: TrayWorld): boolean {
  const r = s.run1;
  if (r === null || !watchOpen(tr, s, r, tw)) return false;
  return !((tr.busyT !== null && tr.busyT >= r.seenT) || (tr.pushT !== null && tr.pushT >= r.seenT));
}

/**
 * The watch of an unseen doubt (a copy of the stone's unseen run): none for a stone with a chain (only a look settles
 * its question), when another cause of the settle's step 1 holds now, or when something could have changed the stone
 * since it was last seen (4.6.1).
 */
function watchOf(tr: OpenTray, s: St, k: number, births: readonly (readonly [P, P])[], tw: TrayWorld): Watch | null {
  const r = s.run1;
  if (s.chain.length > 0 || r === null || r.wid !== s.world || r.spoilt || s.pushed || s.freedPush) return null;
  const pushedNext = tr.stones.some(
    (o) => o !== s && o.pushed && o.atK === k && compatible(o.size, s.size) && dist(o.at, s.at) <= HAND_R,
  );
  if (pushedNext) return null;
  const appeared = births.some(
    ([place, size]) => compatible(size, s.size) && Math.min(dist(place, s.place), dist(place, s.at)) <= HAND_R,
  );
  if (s.handled && appeared) return null;
  const w = newWatch(r.wid, r.place, r.seenT, r.c1T, r.again);
  return watchOpen(tr, s, w, tw) ? w : null;
}

// ---- the leaving's speckle answer (4.6.13) ----

/**
 * The leaving's answer: the newest answer read while the tray was on whose later moment is within SPECKLE_NEAR frames
 * of the leaving point `r`, else null. (A later moment further from the leaving point comes before hand work on the
 * tray: the leaving point is a calm frame unless hands worked after it.)
 */
function leavingAnswer(tr: OpenTray, r: FrameRef): WorldSpeckle | null {
  for (let i = tr.answers.length - 1; i >= 0; i--) {
    const sp = tr.answers[i] as WorldSpeckle;
    if (Math.abs(sp.at.g - r.g) <= SPECKLE_NEAR) return sp;
  }
  return null;
}

/** A pair of the leaving's answer that links a tray stone (4.6.13). */
interface SpeckleTarget {
  readonly s: St;
  /** The pair's world id at the later moment. */
  readonly c: number;
  /** The pair's find for its fact: the arrival stone's when clean, else the later stone's (if the answer has one). */
  readonly x: SpeckleFind | undefined;
  /** The stone's status and world id before the pairs link. */
  readonly status: TrayStoneStatus;
  readonly w0: number | null;
}

/**
 * The leaving answer's pairs that link a tray stone (4.6.13), in the answer's order: each pair `[c, r]` whose arrival
 * stone (the tray stone `r` was linked to at the arrival) was not added and is on the tray or lost, and whose `c` is a
 * world stone of the leaving point's world (else of the last frame's, `tw`), not held. A world id or a stone in an
 * earlier such pair is skipped, and so is a pair that would move a trusted stone to another world stone or give a
 * trusted stone's world stone to another: on look-alike pavers a pair can join two neighbours, while a stone nothing
 * disturbed has not moved. A pair whose clean find has no score (no find of `c`, or one without a score) links
 * nothing, unless its stone is sure and already on `c` (it is confirmed, with no fact): a unit pairs only stones it
 * found, so this is a malformed answer, and the trays read it without failing.
 */
function speckleTargets(tr: OpenTray, sp: WorldSpeckle, tw: TrayWorld): SpeckleTarget[] {
  const point = tr.leaveWorld as TrayWorld; // set as the tray leaves, before its last settle
  const byTray = new Map(tr.stones.map((s) => [s.id, s]));
  const refs = new Map(sp.refs.map((x) => [x.id, x]));
  const later = new Map(sp.stones.map((x) => [x.id, x]));
  const targets: SpeckleTarget[] = [];
  const claimed = new Set<number>();
  const used = new Set<St>();
  for (const [c, r] of sp.pairs) {
    const s = byTray.get(tr.arrivalLinks.get(r) as string); // none when r was no tray stone's at the arrival
    const ws = point.byId.get(c) ?? tw.byId.get(c);
    const open = s !== undefined && !s.added && (s.status === "on" || s.status === "lost");
    if (!open || ws === undefined || ws.held || claimed.has(c) || used.has(s)) continue;
    const y = tr.link.get(c);
    if ((trusted(s) && s.world !== c) || (y !== undefined && y !== s && trusted(y))) continue;
    const xr = refs.get(r);
    const x = xr !== undefined && speckleClean(xr) ? xr : later.get(c);
    if (x?.score == null && !(s.status === "on" && s.world === c && s.sure)) continue;
    targets.push({ s, c, x, status: s.status, w0: s.world });
    claimed.add(c);
    used.add(s);
  }
  return targets;
}

/** What the leaving's answer found of one world id (4.6.13). */
type SpeckleRead = "paired" | "clean" | "alike" | "none" | "absent";

/** A stone's evidence by what the leaving's answer found of it (4.6.13). */
const EVIDENCE: Readonly<Record<SpeckleRead, TrayStoneEvidence>> = {
  none: "not_found",
  alike: "undecided",
  absent: "undecided",
  clean: "found",
  paired: "found",
};

/**
 * What the leaving's answer `sp` found of world id `wid` (4.6.13): `paired` (in one of the unit's pairs), `clean` (a
 * clean find in no pair), `alike` (a find of at least SPECKLE_CLEAN that is not twice its second: look-alikes), `none`
 * (no find of SPECKLE_CLEAN) or `absent` (no leaving answer, or the id is not in it, or not checked). `side` is
 * `arrival` for an arrival stone's world id (the answer's refs), `later` for a later one's (its stones).
 */
function speckleRead(sp: WorldSpeckle | null, side: SpeckleSide, wid: number): SpeckleRead {
  if (sp === null) return "absent";
  const x = (side === "arrival" ? sp.refs : sp.stones).find((f) => f.id === wid);
  if (x?.score == null) return "absent";
  if (sp.pairs.some(([c, r]) => (side === "arrival" ? r : c) === wid)) return "paired";
  if (speckleClean(x)) return "clean";
  return speckleMille(x.score) >= SPECKLE_CLEAN ? "alike" : "none";
}

/**
 * A stone's evidence as its tray leaves (4.6.13): a stone the tray arrived with by its arrival world id's find (is it
 * on the tray as it left?), one added and on the tray by its world id's (was it on the tray at the arrival?); an added
 * stone removed again is `undecided`.
 */
function stoneEvidence(tr: OpenTray, s: St): TrayStoneEvidence {
  if (!s.added) return EVIDENCE[speckleRead(tr.leavingAnswer, "arrival", s.firstWorld)];
  if (s.status !== "on") return "undecided";
  return EVIDENCE[speckleRead(tr.leavingAnswer, "later", s.world as number)];
}

/**
 * The rules of section 4.6 for one session: `feed` it the worlds of the session's frames in order (not revisions), tell
 * it where frames it could not read came (`skipped`), `close()` it when the session ends. Each tray that leaves goes to
 * `onClose` as its {@link Tray}. Used by {@link InterpreterCore}; pure, no I/O.
 */
export class TrayLedger {
  private n = 0;
  private tray: OpenTray | null = null;
  /**
   * Frames of the current static stop until it lasts STOP_MIN, each with whether frames the rules could not read came
   * before it.
   */
  private stop: (readonly [TrayWorld, boolean])[] = [];
  /** The current stop is a tray visit. */
  private on = false;
  private calm = 0;
  private visitStart = 0;
  private ordinaryCalm = 0;
  private quietEpoch = 0;
  private cleanCandidate: VisitSnapshot | null = null;
  private visitFallback: VisitSnapshot | null = null;
  private readonly partialUnseen = new Map<St, { id: number; g: number; epoch: number }>();
  /** The first frame of the calm run. */
  private calmG = 0;
  private quiet = 0;
  /** Frames the rules could not read came before the next world fed (4.6.1). */
  private hole = false;
  /** The tray that left last: a speckle answer after it left is for it (4.6.12). */
  private lastClosed: OpenTray | null = null;

  constructor(
    private readonly counts: TrayCounts,
    private readonly session: number | null,
    private readonly video: string | null,
    private readonly onClose: (tray: Tray) => void,
  ) {}

  /** The open tray's links now: world id to tray stone id (empty between trays). */
  links(): Map<number, string> {
    const out = new Map<number, string>();
    if (this.tray !== null) for (const [wid, s] of this.tray.link) out.set(wid, s.id);
    return out;
  }

  /** The open tray (null between trays). */
  current(): Tray | null {
    return this.tray === null ? null : this.view(this.tray);
  }

  /**
   * Frames the rules could not read came here (a frame without a world, a `g` gap, a `gap` or `reset` side event, a
   * revision): the next world fed counts as a busy and a push frame (4.6.1).
   */
  skipped(): void {
    this.hole = true;
  }

  /** The world of the session's next frame (not a revision); returns the tray facts it made. */
  feed(w: WorldLayer, ref: FrameRef): TrayFact[] {
    const out: TrayFact[] = [];
    const hole = this.hole;
    this.hole = false;
    if (w.motion !== "static") {
      this.stop = [];
      this.on = false;
      return out;
    }
    const tw = trayWorld(w, ref);
    if (this.on) {
      this.frame(tw, out, hole);
      return out;
    }
    this.stop.push([tw, hole]);
    if (tw.r.t - this.stopStart().r.t < STOP_MIN) return out;
    this.begin(out);
    for (const [s, h] of this.stop) this.frame(s, out, h);
    this.stop = [];
    return out;
  }

  /** The first frame of the current static stop (there is one). */
  private stopStart(): TrayWorld {
    return (this.stop[0] as readonly [TrayWorld, boolean])[0];
  }

  /** The session ended (or the replay or stream): the open tray leaves. Returns the facts of its leaving. */
  close(): TrayFact[] {
    const out: TrayFact[] = [];
    this.closeTray(out);
    this.stop = [];
    this.on = false;
    return out;
  }

  private view(tr: OpenTray): Tray {
    return new Tray({
      session: this.session,
      video: this.video,
      n: tr.n,
      arrived: tr.arrived,
      leaving: tr.leaving,
      stones: tr.stones.map(stoneView),
      facts: [...tr.facts],
      open: tr.open === null ? null : [...tr.open],
      tId: tr.took ? tIdOf(tr) : null,
    });
  }

  /** Says a fact about the tray (and the stone `s`) at `r`: in the tray's own list and in the frame's. */
  private fact(
    kind: TrayFactKind,
    tr: OpenTray,
    s: St | null,
    r: FrameRef,
    out: TrayFact[],
    extra: Partial<TrayFactInit>,
  ): void {
    const f = new TrayFact({
      kind,
      tray: tr.n,
      session: this.session,
      video: this.video,
      stone: s === null ? null : s.id,
      worldId: s === null ? null : s.world,
      certain: null,
      why: null,
      g: r.g,
      t: r.t,
      wall: r.wall,
      stones: null,
      sure: null,
      added: null,
      removed: null,
      unclear: null,
      ...extra,
    });
    tr.facts.push(f);
    out.push(f);
  }

  private begin(out: TrayFact[]): void {
    const ids = new Set<number>();
    const first = this.stopStart();
    for (const s of first.stones) if (!s.held) ids.add(s.id);
    const tr = this.tray;
    tr?.missingSince.clear();
    const shared = [...ids].filter((id) => tr?.ids.has(id)).length;
    // a visit continues the open tray only when nearly all (nine tenths) of its first frame's stones were seen on the
    // tray: a new board under the camera may carry many of the last board's world ids (4.6.1)
    if (!(tr !== null && ids.size > 0 && 10 * shared >= 9 * ids.size)) {
      this.closeTray(out);
      this.n += 1;
      this.counts.total += 1;
      this.tray = {
        n: this.n,
        ids: new Set(),
        arrived: null,
        leaving: null,
        board: null,
        stones: [],
        link: new Map(),
        unid: new Map(),
        blinks: new Map(),
        missingSince: new Map(),
        marks: [],
        k: -1,
        settleT: 0,
        calmRef: null,
        calmWorld: null,
        leaveWorld: null,
        worked: false,
        last: null,
        unclear: 0,
        certainAdded: 0,
        facts: [],
        store: new Map(),
        alike: null,
        alikeN: 0,
        took: false,
        twins: new Set(),
        memo: new Map(),
        idsAtArrival: new Set(),
        lastRun: null,
        open: null,
        relinked: false,
        lastMarkT: null,
        busyT: null,
        pushT: null,
        settleG: null,
        arrivalLinks: new Map(),
        answers: [],
        leavingAnswer: null,
      };
    } else {
      // Observation history cannot cross unread moving frames, even on a tray that continues at the next stop.
      tr.last = null;
      if (tr.arrived !== null) {
        unread(tr, first.r.t);
        this.finishBlinks(tr);
      }
    }
    this.visitStart = first.r.g;
    this.ordinaryCalm = 0;
    this.quietEpoch = 0;
    this.cleanCandidate = null;
    this.visitFallback = null;
    this.partialUnseen.clear();
    this.on = true;
    this.calm = 0;
    this.quiet = 0;
  }

  /** Hand work anywhere on the tray can hide a replacement during an omission. */
  private undisturbed(tw: TrayWorld): boolean {
    return (
      tw.free &&
      !tw.untrusted &&
      !tw.stones.some((s) => s.held) &&
      !tw.events.some((e) => e.hand || e.took || e.type === "push")
    );
  }

  /** Preserve a short quiet omission only across consecutive observations of the same compatible stone. */
  private updateBlinks(tr: OpenTray, tw: TrayWorld, hole: boolean): void {
    const previous = tr.last;
    if (previous === null) return; // a new visit after unread moving frames
    const continuous = previous.r.g + 1 === tw.r.g && !hole;
    const free = continuous && this.undisturbed(tw);
    const quiet = free && tw.events.length === 0;
    for (const [id, blink] of tr.blinks) {
      const row = tw.byId.get(id);
      const neighbours = this.blinkNeighbours(blink.prior, tw);
      const noNewRival = [...neighbours].every((wid) => blink.neighbours.has(wid));
      if (quiet && row === undefined && noNewRival && tw.r.g - blink.first.g < BLINK_FRAMES) {
        blink.neighbours = neighbours;
        continue;
      }
      tr.blinks.delete(id);
      if (
        free &&
        noNewRival &&
        row?.detected &&
        sameBlinkStone(row, blink) &&
        !tw.events.some((e) => e.id === id && e.type !== "confirm" && e.type !== "freeze")
      ) {
        if (blink.unid !== undefined) tr.unid.set(id, blink.unid);
      } else if (!tw.events.some((e) => e.id === id && ENDS.has(e.type))) {
        this.endBlink(tr, id, blink.first);
      }
    }
    if (!quiet || !this.undisturbed(previous)) return;
    for (const [id, prior] of previous.byId) {
      if (tw.byId.has(id) || !prior.detected || prior.held) continue;
      const unid = tr.unid.get(id);
      if (!tr.link.has(id) && unid === undefined) continue;
      const neighbours = this.blinkNeighbours(prior, tw);
      const before = this.blinkNeighbours(prior, previous);
      if (![...neighbours].every((wid) => before.has(wid))) continue;
      tr.blinks.set(id, { first: tw.r, prior, unid, neighbours, previousRows: previous.stones });
      tr.unid.delete(id);
    }
  }

  /** Other visible tracks that could be the missing stone at its last observed place. */
  private blinkNeighbours(prior: Ws, tw: TrayWorld, includeKept = false): Set<number> {
    const neighbours = new Set<number>();
    const size = sizeOf(prior);
    for (const s of tw.stones) {
      if (
        s.id !== prior.id &&
        (s.detected || includeKept) &&
        !s.held &&
        compatible(sizeOf(s), size) &&
        dist(s.pos, prior.pos) <= RENAME_D
      )
        neighbours.add(s.id);
    }
    return neighbours;
  }

  private finishBlinks(tr: OpenTray): void {
    for (const [id, blink] of tr.blinks) this.endBlink(tr, id, blink.first);
    tr.blinks.clear();
  }

  /**
   * A kept track can establish occupancy at departure when several positive observations include one just after
   * the selected calm point. Retain that actual observation only while the same track and its surroundings persist.
   */
  private observeBoundary(tr: OpenTray, previous: TrayWorld | null, tw: TrayWorld, hole: boolean): void {
    const consecutive = !hole && previous !== null && previous.r.g + 1 === tw.r.g;
    const quiet = consecutive && this.undisturbed(tw);
    const calmG = tr.calmRef?.g;
    const atBoundary =
      quiet && tr.blinks.size > 0 && previous.r.g === calmG && tw.events.length === 0 && this.undisturbed(previous);
    for (const [id, u] of tr.unid) {
      const row = tw.byId.get(id) as Ws; // unidentified entries only survive while this world contains the row
      if (!consecutive || u.lastFrame !== previous.r.g) u.positiveFrames = 0;
      if (!quiet || u.lastFrame !== previous.r.g) u.boundary = null;
      const obs = u.boundary;
      if (
        obs !== null &&
        (obs.calmG !== calmG ||
          !row.frozen ||
          tw.r.t < obs.t ||
          tw.r.t - obs.t > RENAME_T ||
          !compatible(sizeOf(obs.stone), sizeOf(row)) ||
          dist(obs.stone.pos, row.pos) > RENAME_D ||
          tw.events.some((e) => e.id === id && e.type !== "confirm" && e.type !== "freeze") ||
          overlapShare(row, tw.stones) >= OVERLAP ||
          [...this.blinkNeighbours(row, tw, true)].some((wid) => !obs.neighbours.has(wid)))
      )
        u.boundary = null;
      else if (obs !== null && row.detected) obs.latest = row;
      if (atBoundary && u.born.g < calmG && u.positiveFrames >= 2 && row.frozen && row.detected) {
        const old = previous.byId.get(id) as Ws; // the earlier positive readings belong to this continuous track
        if (
          !old.detected &&
          old.frozen &&
          compatible(sizeOf(old), sizeOf(row)) &&
          dist(old.pos, row.pos) <= NEAR &&
          overlapShare(row, tw.stones) < OVERLAP
        ) {
          const neighbours = this.blinkNeighbours(old, previous, true);
          if ([...this.blinkNeighbours(row, tw, true)].every((wid) => neighbours.has(wid)))
            u.boundary = { calmG, stone: row, latest: row, t: tw.r.t, neighbours };
        }
      }
      u.lastFrame = tw.r.g;
      if (row.detected) u.positiveFrames = Math.min(2, u.positiveFrames + 1);
    }
  }

  private endBlink(tr: OpenTray, id: number, first: FrameRef): void {
    const s = tr.link.get(id);
    if (s !== undefined) {
      tr.link.delete(id);
      this.lose(tr, s, first);
    }
  }

  /** Withhold short, unexplained inventory drops from both arrival and departure timing. */
  private inventoryGap(tr: OpenTray, tw: TrayWorld, hole: boolean): boolean {
    const previous = tr.last;
    const missing = tr.missingSince;
    if (previous === null || previous.r.g + 1 !== tw.r.g || hole || tw.events.length || !this.undisturbed(tw)) {
      missing.clear();
      return false;
    }
    for (const [id, first] of missing) {
      if (tw.byId.has(id) || tw.r.g - first >= BLINK_FRAMES) missing.delete(id);
    }
    for (const id of previous.byId.keys()) {
      if (!tw.byId.has(id)) missing.set(id, tw.r.g);
    }
    return missing.size > 0;
  }

  private frame(tw: TrayWorld, out: TrayFact[], hole: boolean): void {
    const tr = this.tray as OpenTray;
    const { r } = tw;
    const t = r.t;
    for (const id of tw.byId.keys()) tr.ids.add(id);
    const previous = tr.last;
    if (tr.arrived !== null) this.updateBlinks(tr, tw, hole);
    const paused = this.inventoryGap(tr, tw, hole) || tr.blinks.size > 0;
    tr.last = tw;
    this.storeLooks(tr, tw);
    const hand = tw.events.some((e) => e.hand);
    const change = tw.events.some((e) => CHANGES.has(e.type));
    this.quiet = tw.events.some((e) => e.type === "new") ? 0 : this.quiet + 1;
    const quietFrame = !hole && this.undisturbed(tw) && !change;
    this.ordinaryCalm = quietFrame ? this.ordinaryCalm + 1 : 0;
    if (!quietFrame) {
      this.cleanCandidate = null;
      this.quietEpoch++;
    }
    const stale = tr.calmRef !== null && tr.calmRef.g < this.visitStart;
    if (stale && paused && this.ordinaryCalm >= CALM && this.cleanCandidate !== null)
      this.visitFallback = this.cleanCandidate;
    if (!paused) {
      this.calm = tw.free && !hand && !change ? this.calm + 1 : 0;
      if (this.calm === 1) this.calmG = r.g;
    }
    if (!tw.free || hand || tw.untrusted || tw.stones.some((ws) => ws.held) || tw.events.some((e) => e.took)) {
      // a busy frame (4.6.1, presence questions): a hand at work, an untrusted hand, a held world stone, or a stone a
      // hand took away
      tr.busyT = t;
    }
    if (tw.events.some((e) => e.type === "push")) tr.pushT = t; // a push frame
    if (hole) unread(tr, t); // frames the rules could not read came before this one (4.6.1)
    if (tr.arrived === null) {
      if (!paused && this.calm >= CALM && this.quiet >= QUIET && tw.confirmed) {
        // looks read before the calm run that ends here may show another stone: hands worked since
        for (const [wid, e] of tr.store) if (e.g < this.calmG) tr.store.delete(wid);
        this.arrive(tr, tw, out);
        tr.arrivalLinks = new Map([...tr.link].map(([wid, s]) => [wid, s.id])); // 4.6.12
        tr.calmWorld = tw;
        tr.idsAtArrival = new Set(tr.ids);
        this.lookWork(tr, tw, r, out);
      }
      return;
    }
    // 1. where hands worked
    for (const e of tw.events) {
      if (!(e.hand || e.byHand) || e.id === null) continue;
      const place = tw.byId.get(e.id)?.pos ?? tr.link.get(e.id)?.place;
      if (place === undefined) continue;
      tr.marks.push([t, place]);
      tr.lastMarkT = t;
    }
    // 2. the leaving point
    if (hand) tr.worked = true;
    if (!paused && this.calm >= CALM) {
      tr.calmRef = r;
      tr.calmWorld = tw;
      tr.worked = false;
    }
    // 3. the world's events on linked stones (and the disturbances and lifts the look rules read)
    const ends: number[] = [];
    const late: number[] = [];
    for (const e of tw.events) {
      if (e.id === null) continue;
      const s = tr.link.get(e.id);
      if (s === undefined) {
        if (e.type === "push") {
          late.push(e.id);
          const u = tr.unid.get(e.id);
          if (u?.freed === true) this.freedPush(tr, u, r);
        }
        continue;
      }
      if (e.hand || e.took) s.handT = t;
      if (HANDLED.has(e.type)) {
        s.handled = true;
        s.lifted = true;
        s.disturbed = r.g;
        s.touched = r.g;
        s.handledT = t;
      } else if (e.type === "push") this.push(tr, s, r);
      else if (ENDS.has(e.type) && !ends.includes(e.id)) ends.push(e.id);
    }
    for (const id of ends) {
      const s = tr.link.get(id) as St;
      tr.link.delete(id);
      for (const e of tw.events) {
        if (e.id !== id) continue;
        s.carriedAway ||= e.type === "gone";
        s.dropped ||= e.type === "drop";
        s.emptied ||= e.byHand;
      }
      this.lose(tr, s, r);
    }
    // a busy frame or a push frame spoils the unseen run of a linked stone not detected on it (4.6.1)
    if (tr.busyT === t || tr.pushT === t) {
      for (const [id, s] of tr.link) {
        const ws = tw.byId.get(id);
        if (ws === undefined || ws.detected) continue;
        for (const rec of runsOf(s)) if (rec !== null && t > rec.seenT) rec.spoilt = true;
      }
    }
    // 4. linked stones in this frame's world
    for (const id of [...tr.link.keys()].sort(byNumber)) {
      const s = tr.link.get(id) as St;
      const ws = tw.byId.get(id);
      if (ws === undefined) {
        if (tr.blinks.has(id)) continue;
        tr.link.delete(id);
        this.lose(tr, s, r);
        continue;
      }
      if (ws.held) {
        s.handled = true;
        s.lifted = true;
        s.disturbed = r.g;
        s.touched = r.g;
        s.handledT = t;
        continue;
      }
      if (ws.frozen) {
        if (s.frozen && !compatible(sizeOf(ws), s.size)) {
          tr.link.delete(id);
          this.doubt(tr, s, "its world stone changed size", "size_changed", r, out, r.g + 1);
          this.lose(tr, s, r);
          tr.unid.set(id, unidOf(ws, r, false, true));
          continue;
        }
        if (!s.frozen) {
          s.size = sizeOf(ws);
          s.frozen = true;
        }
      }
      if (ws.detected) {
        s.place = ws.pos;
        s.seenT = t;
        for (const rec of runsOf(s)) {
          // the run's first sight (4.6.1)
          if (rec === null || rec.again !== null || t <= rec.c1T || rec.spoilt) continue;
          rec.again = {
            t,
            place: s.place,
            busy: tr.busyT !== null && tr.busyT >= rec.seenT,
            push: tr.pushT !== null && tr.pushT >= rec.seenT,
            crowd: crowded(s, rec, tw),
          };
        }
      }
    }
    // 5. world stones no tray stone stands for
    for (const ws of tw.stones) {
      if (tr.link.has(ws.id) || tr.unid.has(ws.id) || ws.held) continue;
      if (insideBoard(tr.board, ws.pos)) tr.unid.set(ws.id, unidOf(ws, r));
    }
    for (const [id, u] of tr.unid) {
      const ws = tw.byId.get(id);
      if (ws === undefined) {
        tr.unid.delete(id);
        continue;
      }
      if (ws.detected) u.place = ws.pos;
      u.size = sizeOf(ws);
    }
    // 6. renames, then a push on an id linked only now (lost at step 3, renamed at step 6) as step 3 reads it;
    // 7. the settle at a calm moment, the look work in a later calm frame
    this.renames(tr, tw, out);
    for (const id of new Set(late)) {
      const s = tr.link.get(id);
      if (s !== undefined) this.push(tr, s, r);
    }
    if (paused && this.ordinaryCalm === CALM) {
      // The inventory is incomplete, but other linked rows can explicitly say they were not detected.
      for (const s of tr.stones) {
        if (s.status === "on" && s.sure && s.world !== null && tw.byId.get(s.world)?.detected === false) {
          const earlier = this.partialUnseen.get(s);
          if (earlier !== undefined && earlier.id === s.world && earlier.epoch !== this.quietEpoch)
            this.doubt(tr, s, "not seen at two calm moments", "unseen", r, out, r.g);
          this.partialUnseen.set(s, { id: s.world, g: r.g, epoch: this.quietEpoch });
        }
      }
    }
    if (!paused) {
      if (this.calm === CALM) this.settle(tr, tw, r, false, out);
      else if (this.calm > CALM) this.lookWork(tr, tw, r, out);
      if (stale && quietFrame && (tr.calmRef as FrameRef).g < this.visitStart) {
        const places: VisitSnapshot["places"] = new Map();
        for (const s of tr.stones) {
          const pos = observedPlace(s, tw);
          if (s.world !== null && pos !== null) places.set(s, { id: s.world, pos });
        }
        this.cleanCandidate = { world: tw, places };
      }
      if (tr.calmRef === r) {
        // a calm frame: each stone's place in it, if it was seen in it (4.7)
        for (const s of tr.stones) s.calmPlace = observedPlace(s, tw);
      }
    }
    this.observeBoundary(tr, previous, tw, hole);
  }

  /**
   * A push on tray stone `s`'s world stone: `s` is pushed, and every tray stone of a compatible size next to it in the
   * last snapshot is disturbed.
   */
  private push(tr: OpenTray, s: St, r: FrameRef): void {
    s.pushed = true;
    s.disturbed = r.g;
    s.touched = r.g;
    const k = tr.k;
    for (const o of tr.stones) {
      if (o !== s && s.atK === k && o.atK === k && compatible(o.size, s.size) && dist(o.at, s.at) <= HAND_R) {
        o.disturbed = r.g;
        o.touched = r.g;
      }
    }
  }

  /**
   * A push on a world stone a look unlinked (freed): every tray stone of a compatible size next to it in the last
   * snapshot is doubted at the settle as a pushed stone's neighbour is (by looks only).
   */
  private freedPush(tr: OpenTray, u: Unid, r: FrameRef): void {
    for (const o of tr.stones) {
      if (o.atK !== tr.k || !compatible(o.size, u.size) || dist(o.at, u.place) > HAND_R) continue;
      o.freedPush = true;
      o.disturbed = r.g;
      o.touched = r.g;
    }
  }

  private arrive(tr: OpenTray, tw: TrayWorld, out: TrayFact[]): void {
    const { r } = tw;
    tr.arrived = r;
    tr.board = tw.board;
    const st = stamp(r.wall, r.t, this.session);
    for (const ws of tw.stones) {
      if (ws.held || !insideBoard(tr.board, ws.pos)) continue;
      const s = newStone(tr, `${st}-${tr.n}-${ws.id}`, ws, r);
      s.calmPlace = ws.detected ? ws.pos : null;
      tr.stones.push(s);
      tr.link.set(ws.id, s);
    }
    this.counts.arrived += 1;
    this.counts.stones += tr.stones.length;
    this.fact("arrived", tr, null, r, out, { stones: tr.stones.length });
    this.snapshot(tr, r);
  }

  private snapshot(tr: OpenTray, r: FrameRef): void {
    tr.k += 1;
    for (const s of tr.stones) {
      s.handled = false;
      s.pushed = false;
      s.freedPush = false;
      s.disturbed = null;
      if (s.status === "on") {
        s.atK = tr.k;
        s.at = s.place;
      }
    }
    tr.settleT = r.t;
    tr.settleG = r.g;
    tr.calmRef = r;
    tr.worked = false;
  }

  private lose(tr: OpenTray, s: St, r: FrameRef): void {
    s.run1 = null; // a lost stone's unseen run ends (4.6.1): never spoilt while unlinked; on probation, it fails
    s.world = null;
    s.status = "lost";
    s.lostT = r.t;
    s.lostK = tr.k;
    s.lostG = r.g;
    s.lostByLook = false;
    s.lostCalmT = tr.settleT;
  }

  // ---- doubts and questions (4.6.4) ----

  /**
   * Where a reason of 4.6.1 holds: a question for a stone with a chain (not for a box doubt), else `unsure`; an
   * `unseen` doubt with a watch (a stone without a chain that nothing could have changed since it was last seen) is a
   * presence question (4.6.1, 4.6.4). A later `unseen` doubt changes nothing in a presence question; a doubt of any
   * other cause ends it.
   */
  private doubt(
    tr: OpenTray,
    s: St,
    why: string,
    cause: string,
    r: FrameRef,
    out: TrayFact[],
    since: number,
    watch: Watch | null = null,
  ): void {
    if (!s.sure) return;
    s.doubted = true;
    const q = s.question;
    if (q !== null && q.watch !== null) {
      if (cause === "unseen") return; // still not seen: nothing new
      q.watch = null; // any other doubt: seeing it again no longer settles it
    }
    if ((s.chain.length > 0 && cause !== "overlap") || (watch !== null && q === null)) {
      if (q === null) s.question = { cause, why, since, opened: r, watch };
      else if (since > q.since) q.since = since;
      return;
    }
    if (cause === "overlap") s.box = true;
    this.unsure(tr, s, why, cause, r, out);
  }

  /** The fact `unsure`: the stone is not sure for good; a question ends undecided with its own why and code. */
  private unsure(tr: OpenTray, s: St, why: string, cause: string, r: FrameRef, out: TrayFact[]): void {
    const q = s.question;
    s.sure = false;
    s.question = null;
    this.counts.unsure += 1;
    s.unsureCode = q === null ? cause : q.cause;
    s.unsureFromT = q === null ? r.t : q.opened.t;
    this.fact("unsure", tr, s, r, out, {
      why: q === null ? why : q.why,
      code: s.unsureCode,
      opened: q === null ? null : q.opened,
    });
  }

  /** A question ends undecided (before a certain removal, or when the tray leaves). */
  private endQuestion(tr: OpenTray, s: St, r: FrameRef, out: TrayFact[]): void {
    const q = s.question;
    if (q !== null) this.unsure(tr, s, q.why, q.cause, r, out);
  }

  /** Links a lost tray stone to an unidentified world stone of this frame (its fact names the new world id). */
  private relink(
    tr: OpenTray,
    s: St,
    wid: number,
    tw: TrayWorld,
    sure: boolean,
    why: string,
    cause: string,
    r: FrameRef,
    out: TrayFact[],
  ): void {
    const u = tr.unid.get(wid) as Unid;
    tr.unid.delete(wid);
    const ws = tw.byId.get(wid) as Ws;
    s.world = wid;
    s.status = "on";
    s.touched = r.g;
    s.worldT = u.born.t;
    s.carriedAway = false;
    s.dropped = false;
    s.emptied = false;
    s.place = ws.pos;
    if (ws.detected) s.seenT = r.t;
    tr.link.set(wid, s);
    if (sure) return;
    if (cause !== "matched_at_leaving") this.doubt(tr, s, why, cause, r, out, r.g + 1);
    else if (s.sure) {
      // never a question
      s.doubted = true;
      this.unsure(tr, s, why, cause, r, out);
    }
  }

  /** A lost stone and one unidentified stone at its place, within RENAME_T s of the loss: the world renamed it. */
  private renames(tr: OpenTray, tw: TrayWorld, out: TrayFact[]): void {
    const lost = tr.stones.filter((s) => s.status === "lost" && !s.dropped);
    if (lost.length === 0 || tr.unid.size === 0) return;
    const fits = (o: St, u: Unid): boolean =>
      Math.abs(u.born.t - o.lostT) <= RENAME_T && compatible(u.size, o.size) && dist(u.place, o.place) <= RENAME_D;
    for (const s of lost) {
      const near = [...tr.unid].filter(([, u]) => fits(s, u));
      if (near.length !== 1) continue;
      const [wid, u] = near[0] as [number, Unid];
      if (lost.some((o) => o !== s && o.status === "lost" && fits(o, u))) continue;
      const sure =
        s.sure &&
        s.question === null &&
        s.lostK === tr.k &&
        !s.carriedAway &&
        !s.emptied &&
        !handsNear(tr, Math.min(s.lostT, u.born.t) - RENAME_T, [s.place, u.place]);
      this.relink(tr, s, wid, tw, sure, "found again, not for sure", "found_again", tw.r, out);
    }
  }

  private settle(tr: OpenTray, tw: TrayWorld, r: FrameRef, last: boolean, out: TrayFact[]): void {
    const t = r.t;
    const k = tr.k;
    const world = tw.stones.filter((w) => !w.held);
    const births: [P, P][] = [];
    for (const u of tr.unid.values()) if (u.born.t > tr.settleT) births.push([u.place, u.size]);
    for (const s of tr.stones)
      if (s.status === "on" && !trusted(s) && s.worldT > tr.settleT) births.push([s.place, s.size]);
    // 1. sure stones (and stones in question), one by one in tray order: is the world still showing them?
    // the leaving tests the last frame again only when it is not the last snapshot's own frame, or when something
    // could have changed the stone since it was last seen (4.6.1, Leaving)
    const sameFrame = last && tw.r.g === tr.settleG; // the leaving's world is the tray's last frame
    // at the leaving, the stones its speckle answer pairs are not tested: the answer settles them (4.6.13)
    const sp = last ? leavingAnswer(tr, r) : null;
    const paired = new Set(sp === null ? [] : speckleTargets(tr, sp, tw).map((x) => x.s));
    for (const s of tr.stones) {
      if (s.status !== "on" || !s.sure || s.atK !== k || paired.has(s)) continue;
      const ws = tw.byId.get(s.world as number); // a stone on the tray stands for a world stone
      const earlier = this.partialUnseen.get(s);
      const independent = earlier !== undefined && earlier.g !== tw.r.g && (last || earlier.epoch !== this.quietEpoch);
      if (independent) this.partialUnseen.delete(s);
      if (independent && earlier.id === s.world && ws?.detected === false) {
        this.doubt(tr, s, "not seen at two calm moments", "unseen", r, out, r.g);
        continue;
      }
      const q = s.question;
      let settled = false;
      if (q !== null && q.watch !== null) {
        // a presence question (4.6.1)
        if (!watchOpen(tr, s, q.watch, tw)) {
          // something could have changed it: it ends
          this.unsure(tr, s, q.why, q.cause, r, out);
          continue;
        }
        if (seenAgain(s, q.watch, tw)) {
          // seen again: settled, sure again, no fact
          s.question = null;
          s.ghost = 0;
          s.run1 = null;
          settled = true;
        }
      }
      if (ws !== undefined && overlapShare(ws, world) >= OVERLAP) {
        this.doubt(tr, s, "its box overlaps another stone", "overlap", r, out, r.g);
        continue;
      }
      if (ws !== undefined && !ws.detected) {
        // on the leaving, the last snapshot's own frame with nothing since its last sight was tested there
        if (!(sameFrame && cleanSince(tr, s, tw))) {
          s.ghost += 1;
          if (s.ghost === 1) {
            s.run1 = newWatch(ws.id, s.place, s.seenT, t);
            if (settled) s.once = true; // settled on a calm moment that does not show it: its next run is on probation
          }
          if (s.ghost >= GHOST) {
            const asked = s.question;
            if (asked !== null && asked.watch !== null) {
              // still watched, still not seen: the step's later reasons are still tested
              this.doubt(tr, s, "not seen at two calm moments", "unseen", r, out, r.g);
            } else {
              const wt = watchOf(tr, s, k, births, tw);
              s.once = false;
              this.doubt(tr, s, "not seen at two calm moments", "unseen", r, out, r.g, wt);
              const opened = s.question;
              if (wt !== null && opened !== null && opened.watch === wt && seenAgain(s, wt, tw)) {
                // seen since the first unseen calm moment: settled; not detected now, so this calm moment starts its
                // next unseen run, on probation
                s.question = null;
                s.ghost = 1;
                s.once = true;
                s.run1 = newWatch(ws.id, s.place, s.seenT, t);
              }
              continue;
            }
          }
        }
      } else {
        const run = s.run1;
        const once = s.once;
        s.ghost = 0;
        s.run1 = null;
        s.once = false;
        if (once && !(run !== null && watchOpen(tr, s, run, tw) && seenAgain(s, run, tw))) {
          // its run on probation ends with a sight that does not settle it: something could have changed the stone
          // while it was out of sight (4.6.1)
          this.doubt(tr, s, "not seen at two calm moments", "unseen", r, out, r.g);
          continue;
        }
      }
      if (s.pushed) {
        this.doubt(tr, s, "it was pushed", "pushed", r, out, sinceOf(s, r));
        continue;
      }
      const pushedNext = tr.stones.some(
        (o) => o !== s && o.pushed && o.atK === k && compatible(o.size, s.size) && dist(o.at, s.at) <= HAND_R,
      );
      if (pushedNext || s.freedPush) {
        this.doubt(tr, s, "a stone next to it was pushed", "neighbour_pushed", r, out, sinceOf(s, r));
        continue;
      }
      const appeared = births.some(
        ([place, size]) => compatible(size, s.size) && Math.min(dist(place, s.place), dist(place, s.at)) <= HAND_R,
      );
      if (s.handled && appeared) {
        const why = "a stone appeared next to it while a hand held it";
        this.doubt(tr, s, why, "appeared", r, out, sinceOf(s, r));
      }
    }
    // 2. the look work
    this.lookWork(tr, tw, r, out);
    if (last) {
      // the leaving's speckle answer (4.6.13): the unit's pairs confirm, relink and find stones again
      this.speckleLeaving(tr, tw, r, out);
      this.leave(tr, tw, r, out);
      return;
    }
    // 3. certain removals, on a tray that is not relinked: v1's rule (lost before this calm moment or RENAME_T ago,
    //    its place empty, nothing that could be it); a twin keeps a stone v1 removes, and relinks the tray
    for (const s of tr.stones) {
      if (tr.relinked) break;
      if (s.status !== "lost" || (s.lostK >= k && t - s.lostT < RENAME_T)) continue;
      if (world.some((w) => covers(w, s.place, MARGIN)) || rivals(tr, s) || !handTook(s)) continue;
      if (tr.twins.has(s.id)) {
        tr.relinked = true;
        break;
      }
      this.endQuestion(tr, s, r, out);
      s.status = "removed";
      s.certain = true;
      this.counts.removed += 1;
      const code = s.carriedAway ? "carried_away" : "missing";
      this.fact("removed", tr, s, r, out, {
        certain: true,
        why: code.replace("_", " "),
        code,
      });
    }
    // 4. certain additions: an unidentified stone at the same place at two calm moments in a row, not freed by a look
    //    nor made by a size change, while no tray stone of its size is lost or not trusted, on a tray not relinked
    const doubtful = tr.stones
      .filter((s) => s.status === "lost" || (s.status === "on" && !trusted(s)))
      .map((s) => s.size);
    for (const wid of [...tr.unid.keys()].sort(byNumber)) {
      const u = tr.unid.get(wid) as Unid;
      const ws = tw.byId.get(wid) as Ws; // what is unidentified is in this frame's world
      if (!ws.detected) {
        u.seen = 0;
        u.last = null;
        continue;
      }
      u.seen = u.last !== null && dist(u.last, u.place) <= NEAR ? u.seen + 1 : 1;
      u.last = u.place;
      if (u.seen < 2 || u.freed || u.resized || tr.relinked) continue;
      if (!doubtful.some((z) => compatible(u.size, z))) this.mint(tr, wid, ws, true, r, out);
    }
    // 5. the snapshot
    this.snapshot(tr, r);
  }

  /**
   * The unit's pairs at the leaving (4.6.13), before its questions end: a stone already on its pair's world stone is
   * confirmed (its question ends; one that was not sure is sure again, fact `identified`, `speckle_same`); any other is
   * linked to it, sure (`speckle_moved` from another world stone, `speckle_found` for a lost stone): the stone that
   * stood there is lost, and the world stone the moved stone stood on is unidentified again (freed) when it is on the
   * board, not held and in no pair.
   */
  private speckleLeaving(tr: OpenTray, tw: TrayWorld, r: FrameRef, out: TrayFact[]): void {
    const sp = leavingAnswer(tr, r);
    tr.leavingAnswer = sp;
    if (sp === null) return;
    const point = tr.leaveWorld as TrayWorld; // set as the tray leaves, before its last settle
    const targets = speckleTargets(tr, sp, tw);
    const claimed = new Set(targets.map((x) => x.c));
    for (const { s, c, status, w0 } of targets) {
      if (status === "on" && w0 === c) continue; // confirmed: its link stays
      const y = tr.link.get(c);
      tr.link.delete(c);
      if (y !== undefined && y !== s) this.lose(tr, y, r);
      const u = tr.unid.get(c);
      tr.unid.delete(c);
      if (s.status === "on" && tr.link.get(s.world as number) === s) {
        const old = s.world as number; // a stone on the tray stands for a world stone
        tr.link.delete(old);
        const ws0 = tw.byId.get(old);
        if (!claimed.has(old) && ws0 !== undefined && !ws0.held && insideBoard(tr.board, ws0.pos))
          tr.unid.set(old, unidOf(ws0, r, true));
      }
      const ws = (point.byId.get(c) ?? tw.byId.get(c)) as Ws; // a pair's world stone is in one of them
      s.worldT = u !== undefined ? u.born.t : y !== undefined ? y.worldT : r.t;
      s.world = c;
      s.status = "on";
      s.touched = r.g;
      s.carriedAway = false;
      s.dropped = false;
      s.emptied = false;
      s.place = ws.pos;
      if (ws.detected) s.seenT = r.t;
      tr.link.set(c, s);
      s.atK = tr.k; // its place in the last snapshot: where the answer found it
      s.at = s.place;
    }
    for (const { s, c, x, status, w0 } of targets) {
      s.question = null;
      s.bySpeckle = true;
      let code: string;
      let why: string;
      let from: number | null = null;
      if (status === "on" && w0 === c) {
        if (s.sure) continue; // sure, or a question settled: no fact
        code = "speckle_same";
        why = "confirmed by its speckle";
      } else if (status === "lost") {
        code = "speckle_found";
        why = "found again by its speckle";
      } else {
        code = "speckle_moved";
        why = "recognised by its speckle";
        from = w0;
      }
      s.sure = true;
      // the pair's find: a stone that gets a fact has one with a score (below the bar, the self-check's C9 fails)
      const { score, second } = x as SpeckleFind;
      const p = speckleMille(score as number);
      this.fact("identified", tr, s, r, out, {
        why,
        code,
        fromWorld: from,
        score: p,
        margin: second === null ? null : p - speckleMille(second),
        bar: SPECKLE_CLEAN,
      });
    }
  }

  /**
   * The rest of the leaving (4.6.7): questions end, v1's pairing (only pairs with evidence), unclear removals and
   * additions, the open account, the snapshot.
   */
  private leave(tr: OpenTray, tw: TrayWorld, r: FrameRef, out: TrayFact[]): void {
    for (const s of tr.stones) this.endQuestion(tr, s, r, out);
    const pairs: [number, number, number][] = [];
    for (const s of tr.stones) {
      if (s.status !== "lost") continue;
      for (const [wid, u] of tr.unid) {
        if (compatible(u.size, s.size) && dist(u.place, s.place) <= LEAVE_D && sameStone(tr, s, wid, u))
          pairs.push([dist(u.place, s.place), s.index, wid]);
      }
    }
    // nearest first, then in tray order, then by world id
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const usedS = new Set<number>();
    const usedW = new Set<number>();
    for (const [, i, wid] of pairs) {
      if (usedS.has(i) || usedW.has(wid)) continue;
      usedS.add(i);
      usedW.add(wid);
      this.relink(tr, tr.stones[i] as St, wid, tw, false, "matched when the tray left", "matched_at_leaving", r, out);
    }
    for (const s of tr.stones) {
      if (s.status !== "lost") continue;
      s.status = "removed";
      s.certain = false;
      s.leftNow = true;
      tr.unclear += 1;
      this.counts.removedUnclear += 1;
      this.fact("removed", tr, s, r, out, {
        certain: false,
        why: "not found when the tray left",
        code: "not_found",
      });
    }
    for (const wid of [...tr.unid.keys()].sort(byNumber)) {
      const ws = tw.byId.get(wid) as Ws; // what is unidentified is in the last world
      const observation = (tr.unid.get(wid) as Unid).boundary;
      const atPoint = tr.leaveWorld?.byId.get(wid);
      let row: Ws | null = null;
      if (ws.detected) row = ws;
      else if (observation?.calmG === r.g) row = observation.latest;
      else if (atPoint !== undefined && !atPoint.held) {
        // detected, not held, in the leaving point's world: positive evidence too (no hand worked since); or kept
        // there, not held, less than OVERLAP of its box under another unheld stone's: the world kept it on the tray
        // although the model did not box it there (version 7)
        const unheld = (tr.leaveWorld as TrayWorld).stones.filter((w) => !w.held);
        if (atPoint.detected || overlapShare(atPoint, unheld) < OVERLAP) row = atPoint;
      }
      if (row !== null) this.mint(tr, wid, row, false, r, out);
    }
    tr.open = this.openAccount(tr, tw);
    tr.unid = new Map();
    this.snapshot(tr, r);
  }

  private mint(tr: OpenTray, wid: number, ws: Ws, certain: boolean, r: FrameRef, out: TrayFact[]): void {
    const u = tr.unid.get(wid) as Unid;
    tr.unid.delete(wid);
    const s = newStone(tr, `${stamp(u.born.wall, u.born.t, this.session)}-${tr.n}-${wid}`, ws, u.born);
    s.sure = certain;
    s.added = true;
    s.certain = certain;
    s.doubted = !certain;
    s.unidRec = u;
    s.addedNow = !certain;
    tr.stones.push(s);
    tr.link.set(wid, s);
    if (certain) {
      tr.certainAdded += 1;
      this.counts.added += 1;
    } else {
      tr.unclear += 1;
      this.counts.addedUnclear += 1;
    }
    this.fact("added", tr, s, r, out, {
      certain,
      why: certain ? "set down" : "not recognised when the tray left",
      code: certain ? "set_down" : "not_recognised",
    });
  }

  // ---- looks on the tray (4.6.3) ----

  /**
   * The look store: forget the ids of this frame's look clearers and of stones gone, then keep this frame's usable
   * looks of stones not held inside the board (any place before the arrival).
   */
  private storeLooks(tr: OpenTray, tw: TrayWorld): void {
    const store = tr.store;
    for (const e of tw.events) if (LOOK_CLEARERS.has(e.type) && e.id !== null) store.delete(e.id);
    for (const wid of store.keys()) if (!tw.byId.has(wid)) store.delete(wid);
    for (const ws of tw.stones) {
      if (ws.held || !insideBoard(tr.board, ws.pos)) continue;
      const c = usableCells(ws.look);
      if (c === null) continue;
      store.set(ws.id, {
        wid: ws.id,
        cells: c,
        g: tw.r.g,
        t: tw.r.t,
        place: ws.pos,
        size: sizeOf(ws),
        taken: false,
        detected: ws.detected,
      });
    }
  }

  // ---- the look work (4.6.5) ----

  private lookWork(tr: OpenTray, tw: TrayWorld, r: FrameRef, out: TrayFact[]): void {
    this.takeLooks(tr, tw, r, out);
    this.anchors(tr, tw);
    for (;;) {
      const run = this.lookRun(tr, tw);
      tr.lastRun = run;
      if (run.best === null) return;
      this.apply(tr, run.best, tw, r, out);
    }
  }

  private takeLooks(tr: OpenTray, tw: TrayWorld, r: FrameRef, out: TrayFact[]): void {
    const store = tr.store;
    const take = [...store.values()].filter((e) => !e.taken && fresh(tr, e, tw)).sort((a, b) => a.wid - b.wid);
    for (const e of take.slice(0, N_TAKE)) {
      e.taken = true;
      tr.took = true;
      const ws = tw.byId.get(e.wid) as Ws;
      const here = ws.pos;
      const size = sizeOf(ws);
      // the gauge: how alike two different stones of this tray look, both ways
      const partners: [number, number][] = [];
      for (const o of tw.stones) {
        const x = store.get(o.id);
        if (o.id === e.wid || x === undefined || !x.taken || !fresh(tr, x, tw)) continue;
        if (!insideBoard(tr.board, o.pos) || !compatible(sizeOf(o), size)) continue;
        const d = dist(o.pos, here);
        if (d >= 0.5 * size[0]) partners.push([d, o.id]);
      }
      partners.sort(byNear);
      for (const [, oid] of partners.slice(0, GAUGE_K)) {
        const other = store.get(oid) as Look;
        let m: number | null = null;
        for (const x of [scoreOf(tr, e, other), scoreOf(tr, other, e)])
          if (x !== null && (m === null || x[0] > m)) m = x[0];
        if (m === null) continue;
        tr.alike = tr.alike === null ? m : Math.max(tr.alike, m);
        tr.alikeN += 1;
      }
      // the own compare of a sure stone with a chain
      const s = tr.link.get(e.wid);
      if (s === undefined || s.chain.length === 0 || !untouched(s)) continue;
      const sc = chainScore(tr, s, e);
      if (sc === null || sc[1] < N_ID) continue;
      if (sc[0] >= tIdOf(tr)) setLatest(s, e);
      else if (sc[0] < T_DIFF) {
        if (trusted(s)) tr.relinked = true; // v1 trusts it: from here on what the tray trusts may differ from v1's
        this.doubt(tr, s, "its look changed", "look_changed", r, out, e.g);
      }
    }
  }

  private anchors(tr: OpenTray, tw: TrayWorld): void {
    for (const s of tr.stones) {
      if (s.status !== "on" || s.chain.length > 0) continue;
      const e = tr.store.get(s.world as number); // a stone on the tray stands for a world stone
      if (e === undefined || !e.taken || !fresh(tr, e, tw)) continue;
      if (untouched(s) && e.detected && s.ghost === 0) s.chain = [e];
      else s.late = true;
    }
  }

  /**
   * One run of the look step: rows (open tray stones with a chain), columns (open world stones with a fresh taken
   * look), their pairs, neighbours, hits and twins, and the decided pair with the highest score.
   */
  private lookRun(tr: OpenTray, tw: TrayWorld): Run {
    const tid = tIdOf(tr);
    const store = tr.store;
    const rows: [St, number][] = [];
    for (const s of tr.stones) {
      if (s.chain.length === 0 || !s.sure) continue;
      const q = s.question;
      if (s.status === "on") {
        if (q !== null) rows.push([s, q.since]);
      } else if (s.status === "lost") {
        if (q === null) rows.push([s, s.lostG + 1]);
        else rows.push([s, s.lostByLook ? q.since : Math.max(s.lostG + 1, q.since)]);
      }
    }
    const cols: Ws[] = [];
    for (const ws of tw.stones) {
      if (ws.held || !insideBoard(tr.board, ws.pos)) continue;
      const e = store.get(ws.id);
      if (e === undefined || !e.taken || !fresh(tr, e, tw)) continue;
      const y = tr.link.get(ws.id);
      if (y === undefined ? !tr.unid.has(ws.id) : y.sure && y.question === null) continue;
      cols.push(ws);
    }
    const pairs = new Map<number, Pair[]>(); // row index -> [(world id, S, n)] nearest first
    const lastMark = tr.lastMarkT;
    for (const [s, since] of rows) {
      const near: [number, number][] = [];
      const gone = s.status === "lost" && (s.carriedAway || s.emptied);
      for (const ws of cols) {
        const d = dist(s.place, ws.pos);
        const e = store.get(ws.id) as Look;
        if (!compatible(s.size, sizeOf(ws)) || d > D_MATCH || e.g < since) continue;
        if ((lastMark !== null && e.t < lastMark) || (gone && firstSeen(tr, ws.id) <= s.lostT)) continue;
        near.push([d, ws.id]);
      }
      near.sort(byNear);
      pairs.set(
        s.index,
        near.slice(0, K_PAIR).map(([, wid]) => pairOf(wid, chainScore(tr, s, store.get(wid) as Look))),
      );
    }
    const neigh = new Map<number, Pair[]>(); // world id -> [(tray index, S, n)] nearest first
    const twins = new Set<number>();
    for (const ws of cols) {
      const here = ws.pos;
      const size = sizeOf(ws);
      const close: [number, number][] = [];
      for (const o of tr.stones) {
        if (o.status !== "on" || o.chain.length === 0 || !compatible(o.size, size)) continue;
        const d = dist(o.place, here);
        if (d <= D_NEIGH) close.push([d, o.index]);
      }
      close.sort(byNear);
      const look = store.get(ws.id) as Look;
      const ns = close.slice(0, K_NEIGH).map(([, i]) => pairOf(i, chainScore(tr, tr.stones[i] as St, look)));
      neigh.set(ws.id, ns);
      const h = new Set<number>();
      for (const p of ns) if (hits(p, tid)) h.add(p[0]);
      for (const [i, ps] of pairs) if (ps.some((p) => p[0] === ws.id && hits(p, tid))) h.add(i);
      if (h.size < 2) continue;
      twins.add(ws.id);
      for (const i of h) tr.twins.add((tr.stones[i] as St).id);
    }
    // decided pairs: a decided pair has no scored rival within M_ID, so no two share a row or a world stone
    const decided: Best[] = [];
    const info = new Map<string, readonly [number, number | null]>(); // `row,world id` -> (bar, best rival)
    for (const [s] of rows) {
      const i = s.index;
      const ps = pairs.get(i) as Pair[];
      for (const [wid, sc, n] of ps) {
        const ws = tw.byId.get(wid) as Ws;
        const here = ws.pos;
        const size = sizeOf(ws);
        const alone =
          s.status === "on" &&
          s.world === wid &&
          !tr.stones.some(
            (o) =>
              o !== s &&
              o.status !== "removed" &&
              o.chain.length === 0 &&
              compatible(o.size, size) &&
              dist(o.place, here) <= D_NEIGH,
          );
        const bar = alone ? tid : Math.max(tid, T_FIRM);
        const rivals: number[] = [];
        for (const [w2, s2] of ps) if (w2 !== wid && s2 !== null) rivals.push(s2);
        for (const [j, qs] of pairs)
          if (j !== i) for (const [w2, s2] of qs) if (w2 === wid && s2 !== null) rivals.push(s2);
        for (const [j, s2] of neigh.get(wid) as Pair[]) if (j !== i && s2 !== null) rivals.push(s2);
        const top = rivals.length === 0 ? null : Math.max(...rivals);
        info.set(`${i},${wid}`, [bar, top]);
        if (twins.has(wid) || sc === null || n === null || n < N_ID || sc < bar) continue;
        if (rivals.some((x) => sc - x < M_ID) || unscored(tr, s, wid, here, size)) continue;
        decided.push({
          row: i,
          wid,
          score: sc,
          margin: top === null ? null : sc - top,
          bar,
        });
      }
    }
    // the highest score, then the first row (rows are in tray order)
    const high = Math.max(...decided.map((d) => d.score));
    const best = decided.find((d) => d.score === high) ?? null;
    return {
      rows: rows.map(([s, since]) => [s.index, since] as const),
      cols: cols.map((w) => w.id),
      pairs,
      info,
      best,
    };
  }

  /** A decided pair: a question settled, or a stone linked by its look (fact `identified`). */
  private apply(tr: OpenTray, best: Best, tw: TrayWorld, r: FrameRef, out: TrayFact[]): void {
    const s = tr.stones[best.row] as St;
    const wid = best.wid;
    const look = tr.store.get(wid) as Look;
    if (s.status === "on" && s.world === wid) {
      s.question = null;
      setLatest(s, look);
      return;
    }
    const wasLost = s.status === "lost";
    const y = tr.link.get(wid);
    if (y !== undefined) {
      tr.link.delete(wid);
      this.lose(tr, y, r);
      y.lostByLook = true;
      y.lookLost = true;
    }
    let w0: number | null = null;
    if (s.status === "on") {
      w0 = s.world as number; // a stone on the tray stands for a world stone
      tr.link.delete(w0);
      const ws0 = tw.byId.get(w0);
      if (ws0 !== undefined && !ws0.held && insideBoard(tr.board, ws0.pos)) tr.unid.set(w0, unidOf(ws0, r, true));
    }
    // a column is unidentified or linked
    const u = tr.unid.get(wid);
    tr.unid.delete(wid);
    const ws = tw.byId.get(wid) as Ws;
    s.world = wid;
    s.status = "on";
    s.touched = r.g;
    s.worldT = u === undefined ? (y as St).worldT : u.born.t;
    s.carriedAway = false;
    s.dropped = false;
    s.emptied = false;
    s.place = ws.pos;
    if (ws.detected) s.seenT = r.t;
    tr.link.set(wid, s);
    s.question = null;
    s.byLook = true;
    s.atK = tr.k; // its place in the last snapshot: where the look found it
    s.at = s.place;
    tr.relinked = true;
    setLatest(s, look);
    this.fact("identified", tr, s, r, out, {
      why: wasLost ? "found again by its look" : "recognised by its look",
      code: wasLost ? "look_found" : "look_moved",
      fromWorld: w0,
      score: best.score,
      margin: best.margin,
      bar: best.bar,
    });
  }

  // ---- the open account (4.6.8) ----

  private openAccount(tr: OpenTray, tw: TrayWorld): TrayOpen[] {
    const run = tr.lastRun as Run; // the leaving's look work ran
    const rows = new Set(run.rows.map(([i]) => i));
    const sureWorld = new Set<number | null>();
    const stoneOn = new Map<number | null, string>();
    for (const s of tr.stones) {
      if (s.status !== "on") continue;
      stoneOn.set(s.world, s.id);
      if (s.sure) sureWorld.add(s.world);
    }
    const free = tw.stones.filter((w) => !w.held && insideBoard(tr.board, w.pos) && !sureWorld.has(w.id));
    const entries: TrayOpen[] = [];
    for (const s of tr.stones) {
      let o: TrayOpen;
      if (s.addedNow) o = this.openAdded(tr, s, run);
      else if (s.leftNow) o = this.openStone(tr, s, "removed", run, rows, free, stoneOn, tw);
      else if (s.status === "on" && !s.sure) o = this.openStone(tr, s, "unsure", run, rows, free, stoneOn, tw);
      else continue;
      s.open = o;
      entries.push(o);
    }
    return entries;
  }

  private openStone(
    tr: OpenTray,
    s: St,
    kind: "unsure" | "removed",
    run: Run,
    rows: ReadonlySet<number>,
    free: readonly Ws[],
    stoneOn: ReadonlyMap<number | null, string>,
    tw: TrayWorld,
  ): TrayOpen {
    const i = s.index;
    let cause: string;
    if (kind === "unsure")
      cause = s.unsureCode; // every unsure fact has its code
    else if (s.lookLost) cause = "look_lost";
    else if (s.byLook) cause = "by_look";
    else if (tr.twins.has(s.id)) cause = "twins";
    else if (tr.relinked) cause = "relinked";
    else if (s.lostK === tr.k) cause = "lost_late";
    else if (tw.stones.some((w) => !w.held && covers(w, s.place, MARGIN))) cause = "covered";
    else if (rivals(tr, s)) cause = "rivals";
    else if (!handTook(s)) cause = "no_hand";
    else cause = "unchecked";
    const ps = run.pairs.get(i) ?? [];
    let look: string;
    let score: number | null = null;
    if (s.chain.length === 0) look = s.late ? "late" : "none";
    else if (s.box) look = "box";
    else if (!rows.has(i) || ps.length === 0) look = "stale";
    else
      [look, score] = tieOr(
        run,
        ps.map((p) => [i, p] as const),
        "low",
      );
    const scores = new Map<number, number | null>(ps.map(([wid, sc]) => [wid, sc]));
    const scoreAt = (wid: number): number | null => {
      const x = scores.get(wid);
      return x === undefined ? null : x;
    };
    const cands: TrayCandidate[] = [];
    if (s.status === "on") cands.push(candidate("world", s.world, s.id, scoreAt(s.world as number), null));
    const scored: [number, number][] = [];
    const unscored: [number, number][] = [];
    for (const ws of free) {
      if (ws.id === s.world || !compatible(s.size, sizeOf(ws)) || dist(s.place, ws.pos) > LEAVE_D) continue;
      const sc = scoreAt(ws.id);
      if (sc === null) unscored.push([dist(s.place, ws.pos), ws.id]);
      else scored.push([-sc, ws.id]);
    }
    for (const [, wid] of [...scored.sort(byNear), ...unscored.sort(byNear)])
      cands.push(candidate("world", wid, stoneOn.get(wid) ?? null, scoreAt(wid), null));
    let why: string | null = null;
    if (kind === "removed" && s.carriedAway) why = "carried_away";
    else if (kind === "removed" && s.emptied) why = "emptied";
    else if (kind === "removed" && s.dropped) why = "dropped";
    else {
      const since = kind === "removed" ? s.lostT : s.unsureFromT;
      if (tr.marks.some(([mt, mp]) => mt >= since && dist(mp, s.place) <= HAND_R)) why = "hand";
    }
    cands.push(candidate("gone", null, null, null, why));
    if (kind === "removed") cands.push(candidate("unseen", null, null, null, null));
    return new TrayOpen({
      stone: s.id,
      worldId: s.world,
      kind,
      cause,
      look,
      score,
      handNear: null,
      seenAtArrival: null,
      candidates: cands,
    });
  }

  private openAdded(tr: OpenTray, s: St, run: Run): TrayOpen {
    // an unclear addition is linked, with its unidentified record
    const u = s.unidRec as Unid;
    const wid = s.world as number;
    let cause: string;
    if (u.freed) cause = "freed";
    else if (u.resized) cause = "size_changed";
    else if (tr.relinked) cause = "relinked";
    else if (
      tr.stones.some(
        (z) =>
          z !== s && !z.addedNow && compatible(z.size, s.size) && (z.leftNow || (z.status === "on" && !trusted(z))),
      )
    )
      cause = "doubtful";
    else if (u.seen < 2) cause = "seen_once";
    else cause = "unchecked";
    const mine: (readonly [number, Pair])[] = [];
    for (const i of [...run.pairs.keys()].sort(byNumber))
      for (const p of run.pairs.get(i) as Pair[]) if (p[0] === wid) mine.push([i, p]);
    let look = "none";
    let score: number | null = null;
    if (run.cols.includes(wid)) [look, score] = tieOr(run, mine, "new");
    const handNear = tr.marks.some(
      ([mt, mp]) => u.born.t - RENAME_T <= mt && mt <= u.born.t && dist(mp, u.place) <= HAND_R,
    );
    const scores = new Map<number, number | null>(mine.map(([i, p]) => [i, p[1]]));
    const scoreAt = (i: number): number | null => {
      const x = scores.get(i);
      return x === undefined ? null : x;
    };
    const scored: [number, number][] = [];
    const unscored: [number, number][] = [];
    for (const z of tr.stones) {
      if (z === s || z.addedNow || !(z.leftNow || (z.status === "on" && !z.sure))) continue;
      if (!compatible(z.size, s.size) || dist(z.place, u.place) > LEAVE_D) continue;
      const sc = scoreAt(z.index);
      if (sc === null) unscored.push([dist(z.place, u.place), z.index]);
      else scored.push([-sc, z.index]);
    }
    const cands = [...scored.sort(byNear), ...unscored.sort(byNear)].map(([, i]) =>
      candidate("stone", null, (tr.stones[i] as St).id, scoreAt(i), null),
    );
    cands.push(candidate("new", null, null, null, null));
    return new TrayOpen({
      stone: s.id,
      worldId: wid,
      kind: "added",
      cause,
      look,
      score,
      handNear,
      seenAtArrival: tr.idsAtArrival.has(wid),
      candidates: cands,
    });
  }

  /** Makes the open tray leave: its final account (section 4.6, Leaving), then it goes to `onClose`. */
  private closeTray(out: TrayFact[]): void {
    const tr = this.tray;
    if (tr === null) return;
    this.tray = null;
    if (tr.arrived === null) {
      this.onClose(this.view(tr)); // it never arrived
      return;
    }
    this.finishBlinks(tr);
    const tw = tr.last as TrayWorld; // set by the frame it arrived in
    const calm = tr.calmRef as FrameRef; // set at arrival
    const fallback = !tr.worked && calm.g < this.visitStart ? this.visitFallback : null;
    const leave = fallback?.world.r ?? (tr.worked ? tw.r : calm);
    tr.leaving = leave;
    // each stone's place at the leaving point, if it was seen there (4.7), before the last settle
    for (const s of tr.stones) {
      if (fallback !== null) {
        const saved = fallback.places.get(s);
        s.leftPlace = saved !== undefined && saved.id === s.world ? saved.pos : null;
      } else s.leftPlace = tr.worked ? observedPlace(s, tw) : s.calmPlace;
    }
    // what is unidentified is in the last world (each frame drops the rest): a guard for the pairing; a stone first
    // seen after the leaving point is not on the tray that leaves (the next tray's, as it comes in)
    tr.unid = new Map([...tr.unid].filter(([wid, u]) => tw.byId.has(wid) && u.born.g <= leave.g));
    const leaveWorld = fallback?.world ?? (tr.worked ? tw : (tr.calmWorld as TrayWorld));
    tr.leaveWorld = leaveWorld;
    const linksBeforeSettle = new Map(tr.stones.map((s) => [s, s.world]));
    this.settle(tr, tw, leave, true, out);
    // A stone first linked by the final settle gets the place of its final id at the leaving point.
    for (const s of tr.stones) {
      if (s.world === null || linksBeforeSettle.get(s) === s.world) continue;
      s.leftPlace = observedPlace(s, leaveWorld);
    }
    // what the leaving's speckle answer found of each stone at the other moment (4.6.13)
    for (const s of tr.stones) s.evidence = stoneEvidence(tr, s);
    let on = 0;
    let sure = 0;
    let removed = 0;
    for (const s of tr.stones) {
      if (s.status === "on") on += 1;
      if (s.status === "on" && s.sure) sure += 1;
      if (s.status === "removed" && s.certain === true) removed += 1;
    }
    this.fact("leaving", tr, null, leave, out, {
      stones: on,
      sure,
      added: tr.certainAdded, // a stone added for certain stays counted when it is removed unclear later
      removed,
      unclear: tr.unclear,
      open: [...(tr.open as TrayOpen[])],
      tId: tr.took ? tIdOf(tr) : null,
    });
    this.lastClosed = tr;
    this.onClose(this.view(tr));
  }

  /**
   * Reads one of the unit's speckle answers, from the world of frame `here` (fed already): its tray and the tray stones
   * in it, or null when it is no tray's (4.6.12). `linksBefore(g)` gives the tray links before frame `g` (the core
   * keeps them for revisions). The open tray keeps it: the rules read the leaving's answer as the tray leaves (4.6.13).
   */
  speckle(
    sp: WorldSpeckle,
    here: FrameRef,
    linksBefore: (g: number) => ReadonlyMap<number, string>,
  ): TraySpeckle | null {
    const rg = sp.ref.g;
    const ag = sp.at.g;
    let tr = this.tray;
    if (tr === null || tr.arrived === null || rg < tr.arrived.g - SPECKLE_NEAR) {
      tr = this.lastClosed;
      if (tr === null || tr.arrived === null || tr.leaving === null) return null;
      if (!(tr.arrived.g - SPECKLE_NEAR <= rg && rg <= tr.leaving.g)) return null;
    }
    const arrived = tr.arrived;
    const closed = tr !== this.tray;
    const mine = new Set(tr.stones.map((s) => s.id));
    const own = (links: ReadonlyMap<number, string>): Map<number, string> =>
      new Map([...links].filter(([, sid]) => mine.has(sid)));
    const refLinks = own(Math.abs(rg - arrived.g) <= SPECKLE_NEAR ? tr.arrivalLinks : linksBefore(rg));
    const atLinks = own(linksBefore(ag));
    const byRef = new Map<number, number>();
    const byAt = new Map<number, number>();
    for (const [c, r] of sp.pairs) {
      byAt.set(c, r);
      byRef.set(r, c);
    }
    const entry = (
      sid: string,
      side: SpeckleSide,
      x: SpeckleFind,
      other: ReadonlyMap<number, string>,
      pairWorld: number | undefined,
    ): StoneSpeckle => {
      const at = x.at ?? null;
      return new StoneSpeckle(
        sid,
        side,
        x.score ?? null,
        x.second ?? null,
        speckleClean(x),
        at === null ? null : (other.get(at) ?? null),
        at,
        pairWorld === undefined ? null : (other.get(pairWorld) ?? null),
      );
    };
    const got = new Map<string, StoneSpeckle>();
    for (const x of sp.refs) {
      // a stone as it was at the reference, checked at the later moment
      const sid = refLinks.get(x.id);
      if (sid !== undefined && !got.has(sid)) got.set(sid, entry(sid, "arrival", x, atLinks, byRef.get(x.id)));
    }
    for (const x of sp.stones) {
      // a stone at the later moment, checked at the reference
      const sid = atLinks.get(x.id);
      if (sid !== undefined && !got.has(sid)) got.set(sid, entry(sid, "later", x, refLinks, byAt.get(x.id)));
    }
    if (!closed) {
      tr.answers.push(sp); // the leaving reads its own (4.6.13)
      for (const s of tr.stones) s.speckle = got.get(s.id) ?? s.speckle;
    }
    return new TraySpeckle({
      tray: tr.n,
      session: this.session,
      video: this.video,
      g: here.g,
      t: here.t,
      wall: here.wall,
      unitTray: sp.tray,
      ref: { g: rg, t: sp.ref.t, wall: null },
      at: { g: ag, t: sp.at.t, wall: null },
      device: sp.device,
      gpuMs: sp.gpu_ms,
      wallMs: sp.wall_ms,
      stones: tr.stones.flatMap((s) => {
        const e = got.get(s.id);
        return e === undefined ? [] : [e];
      }),
    });
  }
}

/** A candidate of an open entry. */
const candidate = (
  kind: TrayCandidateKind,
  worldId: number | null,
  stone: string | null,
  score: number | null,
  why: string | null,
): TrayCandidate => new TrayCandidate({ kind, worldId, stone, score, why });

/**
 * Why the looks could not settle an entry from its pairs (each with its row): `tie` when a pair reached its bar with
 * enough cells, with the best such score, else `other`, with the best score (null when none).
 */
function tieOr(run: Run, ps: readonly (readonly [number, Pair])[], other: string): [string, number | null] {
  const ties: number[] = [];
  const scored: number[] = [];
  for (const [i, [wid, sc, n]] of ps) {
    if (sc === null) continue; // a pair has both its score and its count, or neither
    scored.push(sc);
    const bar = (run.info.get(`${i},${wid}`) as readonly [number, number | null])[0];
    if ((n as number) >= N_ID && sc >= bar) ties.push(sc);
  }
  if (ties.length > 0) return ["tie", Math.max(...ties)];
  return [other, scored.length > 0 ? Math.max(...scored) : null];
}
