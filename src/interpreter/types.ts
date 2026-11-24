import type { Frame, Point3, Rect, StoneView, WorldEventType, WorldStats } from "../models.js";
import { clock, describeActivity, describeEvent } from "./text.js";
import type { Summary } from "./summary.js";
import type { Tray, TrayFact, TraySpeckle } from "./trays.js";

/** A frame reference of an activity: grid frame, media time, and wall time (epoch seconds, null without a clock). */
export interface FrameRef {
  readonly g: number;
  readonly t: number;
  readonly wall: number | null;
}

/** What the fields of a new {@link FactoryEvent} are. */
export interface FactoryEventInit {
  type: string;
  g: number;
  t: number;
  wall: number | null;
  session: number | null;
  video: string | null;
  stoneId: number | null;
  hand: string | null;
  why: string | null;
  into: readonly number[] | null;
  source: string | null;
  stone: StoneView | null;
  /** The tray stone the world id stood for on the open tray before this frame (default null). */
  trayStone?: string | null;
}

/** A typed world event: what the world says happened in a frame, e.g. `21:17.8 Right hand lifts stone 2660`. */
export class FactoryEvent {
  /** The wire name: new, confirm, freeze, push, lift, hinge, carry, place, drop, gone, delete, split (or a newer one). */
  readonly type: WorldEventType | (string & Record<never, never>);
  /** Grid frame. */
  readonly g: number;
  /** Media seconds. */
  readonly t: number;
  /**
   * Server epoch seconds from the newest clock state, `anchor_wall + (t - anchor_media) / rate` (the contract's
   * formula, without the warm-up hold that `SessionClock.wallOf` adds after a select or seek); null until one is known.
   */
  readonly wall: number | null;
  readonly session: number | null;
  readonly video: string | null;
  /**
   * The stone's id (the wire `id`): the world's id, which the engine's tracker can rename and reuse. For an id that
   * holds over time, see {@link FactoryEvent.trayStone}.
   */
  readonly stoneId: number | null;
  /** The hand (the wire `side`): left, right, both, or null. */
  readonly hand: string | null;
  readonly why: string | null;
  readonly into: readonly number[] | null;
  readonly source: string | null;
  /** The stone's snapshot in this frame's world, or null. */
  readonly stone: StoneView | null;
  /**
   * The SDK's own id of the stone the world id stood for on the open tray before this frame (null when it stood for
   * none): an id that is never given to another stone (section 4.6, `trays()`).
   */
  readonly trayStone: string | null;

  constructor(init: FactoryEventInit) {
    this.type = init.type;
    this.g = init.g;
    this.t = init.t;
    this.wall = init.wall;
    this.session = init.session;
    this.video = init.video;
    this.stoneId = init.stoneId;
    this.hand = init.hand;
    this.why = init.why;
    this.into = init.into;
    this.source = init.source;
    this.stone = init.stone;
    this.trayStone = init.trayStone ?? null;
  }

  /** `"{clock} {sentence}"`, e.g. `0:20.5 Both hands push stone 90`. */
  describe(): string {
    return describeEvent(this);
  }

  /** The media time as `M:SS.d`. */
  get clock(): string {
    return clock(this.t);
  }

  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      g: this.g,
      t: this.t,
      wall: this.wall,
      session: this.session,
      video: this.video,
      stone_id: this.stoneId,
      hand: this.hand,
      why: this.why,
      into: this.into,
      source: this.source,
      tray_stone: this.trayStone,
    };
  }
}

/** How a move ended. */
export type MoveOutcome = "placed" | "dropped" | "carried_away" | "removed" | "interrupted";

/** One stone taken and put somewhere: from `lift`/`hinge` to `place`, `drop`, `gone` or `delete`. */
export class Move {
  readonly kind = "move" as const;
  readonly stoneId: number | null;
  /** left, right, or both once two hands took part; null when no event had a side. */
  hand: string | null;
  readonly start: FrameRef;
  /** Null while the move is open. */
  end: FrameRef | null = null;
  /** `solid.pos` when it started (null if the stone or its solid was absent, or for a partial move). */
  readonly from: Point3 | null;
  /** `solid.pos` where it was placed or dropped. */
  to: Point3 | null = null;
  /** Distance of `from` and `to` in x, y (template units), rounded to 3 decimals. */
  distance: number | null = null;
  carried = false;
  tipped: boolean;
  /** True for a move whose start was not seen (a stream joined in the middle of a carry). */
  readonly partial: boolean;
  /** Null while open. */
  outcome: MoveOutcome | null = null;
  /** `end.t - start.t` in seconds; null while open. */
  duration: number | null = null;
  readonly session: number | null;
  readonly video: string | null;

  constructor(init: {
    stoneId: number | null;
    hand: string | null;
    start: FrameRef;
    from: Point3 | null;
    tipped: boolean;
    partial: boolean;
    session: number | null;
    video: string | null;
  }) {
    this.stoneId = init.stoneId;
    this.hand = init.hand;
    this.start = init.start;
    this.from = init.from;
    this.tipped = init.tipped;
    this.partial = init.partial;
    this.session = init.session;
    this.video = init.video;
  }

  /** The move's sentence, e.g. `1:19.2 Left hand takes stone 155 away (1.0 s)`. */
  describe(): string {
    return describeActivity({
      kind: "move",
      hand: this.hand,
      start: this.start,
      end: this.end ?? this.start,
      duration: this.duration ?? 0,
      stoneId: this.stoneId,
      outcome: this.outcome,
      carried: this.carried,
      tipped: this.tipped,
      partial: this.partial,
      distance: this.distance,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      stone_id: this.stoneId,
      hand: this.hand,
      start: this.start,
      end: this.end,
      from: this.from,
      to: this.to,
      distance: this.distance,
      carried: this.carried,
      tipped: this.tipped,
      partial: this.partial,
      outcome: this.outcome,
      duration: this.duration,
      session: this.session,
      video: this.video,
    };
  }
}

/** A hand pushing stones about: pushes of one side less than 1.0 s apart. */
export class PushBurst {
  readonly kind = "push" as const;
  readonly hand: string;
  readonly start: FrameRef;
  /** The frame of the latest push. */
  last: FrameRef;
  /** `last` once closed; null while open. */
  end: FrameRef | null = null;
  /** Unique stone ids, ascending. */
  readonly stones: number[] = [];
  /** Push events counted. */
  pushes = 0;
  /** `end.t - start.t`; null while open. */
  duration: number | null = null;
  readonly session: number | null;
  readonly video: string | null;

  constructor(init: { hand: string; start: FrameRef; session: number | null; video: string | null }) {
    this.hand = init.hand;
    this.start = init.start;
    this.last = init.start;
    this.session = init.session;
    this.video = init.video;
  }

  /** The burst's sentence, e.g. `0:20.5 Both hands push stones 86, 90 and 94 (6 pushes in 0.6 s)`. */
  describe(): string {
    return describeActivity({
      kind: "push",
      hand: this.hand,
      start: this.start,
      end: this.end ?? this.last,
      duration: this.duration ?? this.last.t - this.start.t,
      stones: this.stones,
      pushes: this.pushes,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      hand: this.hand,
      start: this.start,
      end: this.end,
      stones: this.stones,
      pushes: this.pushes,
      duration: this.duration,
      session: this.session,
      video: this.video,
    };
  }
}

/** A move or a push burst. */
export type Activity = Move | PushBurst;

/** A hand of the state: the world's hand state, its stone, and the cards layer's title (e.g. "Holding a stone"). */
export interface HandInfo {
  readonly state: "free" | "touch" | "grasp" | "hinge" | "carry" | null;
  readonly stone: number | null;
  readonly card: string | null;
}

/** The Interpreter's state after a frame. */
export interface InterpreterState {
  readonly session: number | null;
  readonly video: string | null;
  readonly g: number | null;
  /** Media seconds. */
  readonly t: number | null;
  /** Epoch seconds from the newest clock state, null until one is known. */
  readonly wall: number | null;
  /** The stones of the newest world, by id. */
  readonly stones: ReadonlyMap<number, StoneView>;
  readonly hands: { readonly left: HandInfo; readonly right: HandInfo };
  /** `world.draw.board`. */
  readonly board: Rect | null;
  /** `world.stats`. */
  readonly stats: WorldStats | null;
  /** Moves not yet closed, by stone id. */
  readonly openMoves: ReadonlyMap<number | null, Move>;
  /** The open tray with its tray stones (null between trays). */
  readonly tray: Tray | null;
  /** The summary counters so far (section 4.4). */
  readonly counters: Summary;
}

/** What one frame changed. */
export interface Update {
  /** The frame; null only on the final update of a replay or of an Interpreter's stream that ended. */
  readonly frame: Frame | null;
  /** New events of this frame, typed, in world order. */
  readonly events: readonly FactoryEvent[];
  /** Activities completed by this frame. */
  readonly activities: readonly Activity[];
  /**
   * The tray facts this frame made (after a session change, first those of the old session's tray leaving); the final
   * update has those of the open tray leaving.
   */
  readonly trayFacts: readonly TrayFact[];
  /** The unit's speckle answer this frame's world carried, read as a tray's (SDK-DESIGN.md 4.6.12): at most one. */
  readonly speckle: readonly TraySpeckle[];
  /** The state after this frame. */
  readonly state: InterpreterState;
  /** The frame is a revision of one already seen (a higher `world.rev`). */
  readonly isRevision: boolean;
  /** The frame is a duplicate and was dropped (only {@link InterpreterCore.feed} returns these). */
  readonly isDuplicate: boolean;
  /** The frame's late layers were read back by the stream (backfill). */
  readonly isBackfill: boolean;
  /**
   * The last update of a replay, or of an Interpreter's stream that ended (`resume: false`): `frame` is null,
   * `activities` holds what `end()` closed and `trayFacts` the facts of the open tray leaving.
   */
  readonly isFinal: boolean;
}
