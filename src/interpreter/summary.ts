import { clock, fmt } from "./text.js";
import { zeroTrayCounts, type TrayCounts } from "./trays.js";

/** Keys of `events` in the summary: the world event types plus `other`. */
export const SUMMARY_EVENT_KEYS = [
  "new",
  "confirm",
  "freeze",
  "push",
  "lift",
  "hinge",
  "carry",
  "place",
  "drop",
  "gone",
  "delete",
  "split",
  "other",
] as const;

/** The hand states the summary counts. */
export const HAND_STATES = ["free", "touch", "grasp", "hinge", "carry"] as const;

export type SummaryEventKey = (typeof SUMMARY_EVENT_KEYS)[number];
export type HandStateName = (typeof HAND_STATES)[number];

/** The JSON form of a summary: exactly the keys of SDK-DESIGN.md section 4.4 (numbers rounded to 3 decimals). */
export interface SummaryJson {
  frames: number;
  frames_with_world: number;
  missing_world: number;
  revisions: number;
  sessions: number;
  first_g: number | null;
  last_g: number | null;
  first_t: number | null;
  last_t: number | null;
  media_seconds: number;
  gaps: number;
  events: Record<SummaryEventKey, number>;
  moves: {
    total: number;
    placed: number;
    dropped: number;
    carried_away: number;
    removed: number;
    interrupted: number;
    partial: number;
    carried: number;
    mean_duration: number | null;
    mean_distance: number | null;
  };
  push_bursts: { total: number; pushes: number; left: number; right: number; both: number };
  stones: { last: number | null; max: number; confirmed_last: number | null };
  trays: {
    total: number;
    arrived: number;
    stones: number;
    added: number;
    added_unclear: number;
    removed: number;
    removed_unclear: number;
    unsure: number;
  };
  hands: { left: Record<HandStateName, number>; right: Record<HandStateName, number> };
}

/** A summary's JSON as {@link Summary.fromJSON} reads it: one made before trays were counted has no `trays`. */
export type SummaryJsonInput = Omit<SummaryJson, "trays"> & { trays?: SummaryJson["trays"] };

/** Counters of a replay or of a live interpreter so far, with {@link Summary.describe} and {@link Summary.toJSON}. */
export class Summary {
  /** Frames fed (a revision counts in `revisions`). */
  readonly frames: number;
  readonly framesWithWorld: number;
  /** Frames whose world was missing (after backfill for streams, as recorded for replays). */
  readonly missingWorld: number;
  readonly revisions: number;
  readonly sessions: number;
  readonly firstG: number | null;
  readonly lastG: number | null;
  readonly firstT: number | null;
  readonly lastT: number | null;
  /** Sum over sessions of (last t - first t). */
  readonly mediaSeconds: number;
  /** Times `g` increased by more than 1 between consecutive frames of a session. */
  readonly gaps: number;
  readonly events: Readonly<Record<SummaryEventKey, number>>;
  readonly moves: {
    readonly total: number;
    readonly placed: number;
    readonly dropped: number;
    readonly carriedAway: number;
    readonly removed: number;
    readonly interrupted: number;
    readonly partial: number;
    readonly carried: number;
    /** Mean duration of the closed moves that are not partial or interrupted; null when there are none. */
    readonly meanDuration: number | null;
    /** Mean distance of the moves with a distance; null when there are none. */
    readonly meanDistance: number | null;
  };
  readonly pushBursts: {
    readonly total: number;
    readonly pushes: number;
    readonly left: number;
    readonly right: number;
    readonly both: number;
  };
  readonly stones: { readonly last: number | null; readonly max: number; readonly confirmedLast: number | null };
  /** Trays and tray stones (section 4.6): trays, arrivals, stones at the arrivals, certain and unclear facts. */
  readonly trays: Readonly<TrayCounts>;
  /** Seconds per hand state: each frame with a world adds its step (SDK-DESIGN.md 4.5; 0.2 s on a recorded video). */
  readonly hands: {
    readonly left: Readonly<Record<HandStateName, number>>;
    readonly right: Readonly<Record<HandStateName, number>>;
  };

  constructor(json: SummaryJsonInput) {
    this.frames = json.frames;
    this.framesWithWorld = json.frames_with_world;
    this.missingWorld = json.missing_world;
    this.revisions = json.revisions;
    this.sessions = json.sessions;
    this.firstG = json.first_g;
    this.lastG = json.last_g;
    this.firstT = json.first_t;
    this.lastT = json.last_t;
    this.mediaSeconds = json.media_seconds;
    this.gaps = json.gaps;
    this.events = { ...json.events };
    const m = json.moves;
    this.moves = {
      total: m.total,
      placed: m.placed,
      dropped: m.dropped,
      carriedAway: m.carried_away,
      removed: m.removed,
      interrupted: m.interrupted,
      partial: m.partial,
      carried: m.carried,
      meanDuration: m.mean_duration,
      meanDistance: m.mean_distance,
    };
    this.pushBursts = { ...json.push_bursts };
    this.stones = { last: json.stones.last, max: json.stones.max, confirmedLast: json.stones.confirmed_last };
    const tr = json.trays;
    this.trays =
      tr === undefined
        ? zeroTrayCounts()
        : {
            total: tr.total,
            arrived: tr.arrived,
            stones: tr.stones,
            added: tr.added,
            addedUnclear: tr.added_unclear,
            removed: tr.removed,
            removedUnclear: tr.removed_unclear,
            unsure: tr.unsure,
          };
    this.hands = { left: { ...json.hands.left }, right: { ...json.hands.right } };
  }

  /**
   * A summary from its JSON form (e.g. a published `<video>.summary.json`; one made before trays were counted has no
   * `trays`, read as zeros).
   */
  static fromJSON(json: SummaryJsonInput): Summary {
    return new Summary(json);
  }

  /** The JSON form, with exactly the keys of section 4.4. */
  toJSON(): SummaryJson {
    const m = this.moves;
    return {
      frames: this.frames,
      frames_with_world: this.framesWithWorld,
      missing_world: this.missingWorld,
      revisions: this.revisions,
      sessions: this.sessions,
      first_g: this.firstG,
      last_g: this.lastG,
      first_t: this.firstT,
      last_t: this.lastT,
      media_seconds: this.mediaSeconds,
      gaps: this.gaps,
      events: { ...this.events },
      moves: {
        total: m.total,
        placed: m.placed,
        dropped: m.dropped,
        carried_away: m.carriedAway,
        removed: m.removed,
        interrupted: m.interrupted,
        partial: m.partial,
        carried: m.carried,
        mean_duration: m.meanDuration,
        mean_distance: m.meanDistance,
      },
      push_bursts: { ...this.pushBursts },
      stones: { last: this.stones.last, max: this.stones.max, confirmed_last: this.stones.confirmedLast },
      trays: {
        total: this.trays.total,
        arrived: this.trays.arrived,
        stones: this.trays.stones,
        added: this.trays.added,
        added_unclear: this.trays.addedUnclear,
        removed: this.trays.removed,
        removed_unclear: this.trays.removedUnclear,
        unsure: this.trays.unsure,
      },
      hands: { left: { ...this.hands.left }, right: { ...this.hands.right } },
    };
  }

  /** The text form: nine lines, each ending with `\n` (section 4.4). */
  describe(): string {
    const d = (x: number | null): string => (x === null ? "-" : String(x));
    const m = this.moves;
    const p = this.pushBursts;
    const tr = this.trays;
    const meanD = m.meanDuration === null ? "-" : fmt(m.meanDuration, 1);
    const meanU = m.meanDistance === null ? "-" : fmt(m.meanDistance, 2);
    const lines = [
      `frames: ${this.frames} (with world ${this.framesWithWorld}, without ${this.missingWorld}, revisions ${this.revisions})`,
      `media: ${clock(this.mediaSeconds)}, sessions ${this.sessions}, gaps ${this.gaps}`,
      `stones: last ${d(this.stones.last)}, max ${this.stones.max}, confirmed ${d(this.stones.confirmedLast)}`,
      `moves: ${m.total} (placed ${m.placed}, dropped ${m.dropped}, carried away ${m.carriedAway}, ` +
        `removed ${m.removed}, interrupted ${m.interrupted}, partial ${m.partial}, carried ${m.carried}), ` +
        `mean ${meanD} s, ${meanU} units`,
      `push bursts: ${p.total} (left ${p.left}, right ${p.right}, both ${p.both}), pushes ${p.pushes}`,
      `events: ${SUMMARY_EVENT_KEYS.map((k) => `${k} ${this.events[k]}`).join(", ")}`,
      `trays: ${tr.total} (arrived ${tr.arrived}), stones at arrival ${tr.stones}, added ${tr.added} ` +
        `(+${tr.addedUnclear} unclear), removed ${tr.removed} (+${tr.removedUnclear} unclear), not sure ${tr.unsure}`,
    ];
    for (const side of ["left", "right"] as const) {
      lines.push(`${side} hand: ${HAND_STATES.map((k) => `${k} ${clock(this.hands[side][k])}`).join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
