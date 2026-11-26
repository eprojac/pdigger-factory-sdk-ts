/**
 * The Interpreter's pure synchronous state machine (SDK-DESIGN.md sections 2.4 and 4): frames in, typed events,
 * activities, state and text out. Streams and replays feed it; it does no I/O. It follows the Interpreter rules of
 * SDK-DESIGN.md rule for rule; the golden files in fixtures/golden/ hold every SDK to the same text from the same
 * recording.
 *
 * @module
 */
import type {
  CardsLayer,
  Frame,
  HandState,
  Point3,
  Rect,
  StoneView,
  WorldEvent,
  WorldLayer,
  WorldStats,
} from "../models.js";
import { Summary, SUMMARY_EVENT_KEYS, HAND_STATES, type HandStateName, type SummaryJson } from "./summary.js";
import { round3 } from "./text.js";
import {
  TRAYS_KEPT,
  TrayLedger,
  zeroTrayCounts,
  type Tray,
  type TrayCounts,
  type TrayFact,
  type TraySpeckle,
} from "./trays.js";
import {
  FactoryEvent,
  Move,
  PushBurst,
  type Activity,
  type FrameRef,
  type HandInfo,
  type InterpreterState,
  type MoveOutcome,
  type Update,
} from "./types.js";

const EVENT_TYPES: ReadonlySet<string> = new Set(SUMMARY_EVENT_KEYS.filter((k) => k !== "other"));
const HAND_STATE_SET: ReadonlySet<string> = new Set(HAND_STATES);
const BURST_SIDES: ReadonlySet<string> = new Set(["left", "right", "both"]);
const CLOSING: Readonly<Record<string, MoveOutcome>> = {
  place: "placed",
  drop: "dropped",
  gone: "carried_away",
  delete: "removed",
};
/** Pushes of one side at most this many seconds apart are one burst. */
export const BURST_GAP = 1.0;
/** Per-g bookkeeping (emitted event keys, world revisions) is kept for this many frames behind the newest. */
const KEEP_FRAMES = 4096;

/** The clock fields the core reads to give wall times (a `State` or an SSE `clock` event). */
export interface ClockAnchor {
  session?: number | null;
  revision?: number | null;
  playing?: boolean | null;
  rate?: number | null;
  anchor_wall: number;
  anchor_media: number;
  hold_until?: number | null;
}

/** One point of a stone's track: where its solid was at a grid frame. */
export interface TrackPoint {
  readonly g: number;
  readonly t: number;
  readonly pos: Point3;
}

/** Options of an {@link InterpreterCore}. */
export interface InterpreterCoreOptions {
  /** Points kept per stone track (default 512, like the server's paths). */
  trackPoints?: number;
  /** Stones whose tracks are kept (default 4096, the most recently moved). */
  trackStones?: number;
  /** Trays that have left that `trays()` keeps, the newest (default {@link TRAYS_KEPT}, 256; 0 keeps every one). */
  traysKept?: number;
}

interface Counters {
  frames: number;
  framesWithWorld: number;
  missingWorld: number;
  revisions: number;
  sessions: number;
  firstG: number | null;
  lastG: number | null;
  firstT: number | null;
  lastT: number | null;
  mediaSeconds: number;
  gaps: number;
  events: Record<string, number>;
  moves: Record<string, number>;
  bursts: Record<string, number>;
  stonesLast: number | null;
  stonesMax: number;
  confirmedLast: number | null;
}

function zeroHands(): Record<HandStateName, number> {
  return { free: 0, touch: 0, grasp: 0, hinge: 0, carry: 0 };
}

/**
 * The milliseconds a new frame adds to its hands' states (SDK-DESIGN.md 4.5): the media time since the session's
 * previous new frame `prev` when that frame is the grid step before it (`g === prev.g + 1`), in whole milliseconds, half
 * up, when that is at least 1 ms and below 2^31 ms; otherwise the session's previous step (`prev.step`: a frame after a
 * gap, a `t` not after the previous one or not a finite number), and 200 (one grid frame of a recorded video) for a
 * session's first frame.
 */
export function handStep(prev: { g: number; t: number; step: number } | null, g: number, t: number): number {
  if (prev === null) return 200;
  if (g === prev.g + 1) {
    const x = (t - prev.t) * 1000 + 0.5;
    if (x >= 1 && x < 2 ** 31) return Math.floor(x);
  }
  return prev.step;
}

/** The key that tells one event of a frame from another: (type, id, side, into). */
export function eventKey(e: WorldEvent): string {
  return JSON.stringify([e.type ?? null, e.id ?? null, e.side ?? null, e.into ?? null]);
}

function compareKeys(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number | string;
    const y = b[i] as number | string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function sortKey(a: Activity): (number | string)[] {
  const first =
    a.kind === "move" ? (a.stoneId ?? Number.NEGATIVE_INFINITY) : a.stones.length > 0 ? (a.stones[0] as number) : -1;
  const end = a.end as FrameRef;
  return [end.g, a.start.g, a.kind === "move" ? 0 : 1, first, a.hand ?? ""];
}

/** Sorts activities closed together (section 4.3): end g, start g, moves before pushes, stone id, hand. */
export function sortActivities(list: Activity[]): Activity[] {
  return list.sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
}

/**
 * The Interpreter's state machine. `feed(frame)` returns what the frame changed (frames in the order received);
 * `setClock(state)` takes the clock states and `gap()` the stream's `gap` and `reset` events as they come; `end()` (or
 * `finish()`) closes what is open (moves as `interrupted`, the open tray leaves) at the end of a replay or stream;
 * `summary()` gives the counters so far and `trays()` the trays with their tray stones (section 4.6).
 */
export class InterpreterCore {
  private session: number | null = null;
  private video: string | null = null;
  private g: number | null = null;
  private t: number | null = null;
  private stones: ReadonlyMap<number, StoneView> = new Map();
  private hands: WorldLayer["hands"] = {};
  private board: Rect | null = null;
  private stats: WorldStats | null = null;
  private cards: CardsLayer | null = null;
  private moves = new Map<number | null, Move>();
  private bursts = new Map<string, PushBurst>();
  private emitted = new Map<number, Set<string>>();
  private revs = new Map<number, number>();
  /** g to the tray links before that frame (world id to tray stone id), for its revisions. */
  private links = new Map<number, ReadonlyMap<number, string>>();
  private lastLinks: ReadonlyMap<number, string> | null = null;
  private lastWorldRef: FrameRef | null = null;
  /** The newest clock state of each of the last 8 sessions, oldest first. */
  private clocks: ClockAnchor[] = [];
  private sessionFirstT: number | null = null;
  private sessionLastT: number | null = null;
  private prevG: number | null = null;
  // the moves' durations and distances, summed in the order they came
  private durSum = 0;
  private durN = 0;
  private distSum = 0;
  private distN = 0;
  /** Milliseconds per hand and state: each new frame with a world adds its step (handStep). */
  private readonly handMs = { left: zeroHands(), right: zeroHands() };
  /** The session's previous new frame and its step, for the steps. */
  private stepPrev: { g: number; t: number; step: number } | null = null;
  private readonly tracks = new Map<number, TrackPoint[]>();
  private readonly trackPoints: number;
  private readonly trackStones: number;
  private readonly trayCounts: TrayCounts = zeroTrayCounts();
  /** The trays of the current session (section 4.6). */
  private ledger: TrayLedger;
  /** Trays that have left, oldest first (the newest `traysKept`, across sessions). */
  private readonly kept: Tray[] = [];
  /** The unit's speckle answers read, oldest first (the newest {@link SPECKLE_KEPT}, across sessions; 4.6.12). */
  private readonly answers: TraySpeckle[] = [];
  private readonly traysKept: number;
  private readonly c: Counters = {
    frames: 0,
    framesWithWorld: 0,
    missingWorld: 0,
    revisions: 0,
    sessions: 0,
    firstG: null,
    lastG: null,
    firstT: null,
    lastT: null,
    mediaSeconds: 0,
    gaps: 0,
    events: Object.fromEntries(SUMMARY_EVENT_KEYS.map((k) => [k, 0])),
    moves: { total: 0, placed: 0, dropped: 0, carried_away: 0, removed: 0, interrupted: 0, partial: 0, carried: 0 },
    bursts: { total: 0, pushes: 0, left: 0, right: 0, both: 0 },
    stonesLast: null,
    stonesMax: 0,
    confirmedLast: null,
  };

  constructor(options: InterpreterCoreOptions = {}) {
    this.trackPoints = options.trackPoints ?? 512;
    this.trackStones = options.trackStones ?? 4096;
    this.traysKept = options.traysKept ?? TRAYS_KEPT;
    this.ledger = this.newLedger(null, null);
  }

  /**
   * Takes a clock state (a `clock` stream event, a recording's clock line, or `getSession`). The wall times of a
   * session's frames come from that session's newest state, so the frames of a session that ended keep theirs after
   * the next session's clock has come. A state with a lower `revision` than the one kept for its session is older and
   * is ignored; the states of the last 8 sessions are kept. `null` forgets them all.
   */
  setClock(state: ClockAnchor | null): void {
    if (state === null) {
      this.clocks = [];
      return;
    }
    const session = state.session ?? null;
    const old = this.clocks.find((c) => (c.session ?? null) === session);
    if (old !== undefined && (state.revision ?? 0) < (old.revision ?? 0)) return;
    this.clocks = this.clocks.filter((c) => c !== old);
    this.clocks.push(state);
    if (this.clocks.length > 8) this.clocks.shift();
  }

  /**
   * The stream dropped frames here (a `gap` or a `reset` event): the tray rules count the next frame as one after
   * frames they could not read, as after a frame without a world, a jump in `g` or a revision (SDK-DESIGN.md 4.6.1,
   * presence questions).
   */
  gap(): void {
    this.ledger.skipped();
  }

  /**
   * Wall time (epoch seconds) at which the shared playhead shows (or showed) media time `t` in session `session`, from
   * that session's newest clock state, as {@link SessionClock.wallOf}: `start + (t - anchor_media) / rate`, where
   * `start` is `max(anchor_wall, hold_until)` while playing and `anchor_wall` while paused. Null without a clock state
   * of the session, or when the rate is not above 0.
   */
  wallOf(session: number | null, t: number): number | null {
    for (const c of [...this.clocks].reverse()) {
      if ((c.session ?? null) !== session) continue;
      if (!(typeof c.rate === "number" && c.rate > 0)) return null;
      const held = typeof c.hold_until === "number" ? Math.max(c.anchor_wall, c.hold_until) : c.anchor_wall;
      return (c.playing === true ? held : c.anchor_wall) + (t - c.anchor_media) / c.rate;
    }
    return null;
  }

  private ref(f: Frame): FrameRef {
    return { g: f.g, t: f.t, wall: this.wallOf(f.session ?? null, f.t) };
  }

  /** Feeds one frame; returns its events, the activities it completed, its tray facts and the state after it. */
  feed(f: Frame): Update {
    const events: FactoryEvent[] = [];
    const acts: Activity[] = [];
    let facts: TrayFact[] = [];
    const sess = f.session ?? null;
    const g = f.g;
    const t = f.t;
    const w: WorldLayer | null = f.world ?? null;
    const rev = w?.rev || 0;
    if (sess !== this.session) {
      this.closeSession(acts);
      facts = this.ledger.close(); // the old session's tray leaves
      this.session = sess;
      this.video = f.video ?? null;
      this.ledger = this.newLedger(sess, this.video);
      this.stones = new Map();
      this.hands = {};
      this.cards = null; // the next video's card titles come with its own cards
      this.board = null;
      this.stats = null;
      this.emitted = new Map();
      this.revs = new Map();
      this.links = new Map();
      this.lastLinks = null;
      this.tracks.clear();
      this.lastWorldRef = null;
      this.c.sessions += 1;
      this.sessionFirstT = null;
      this.prevG = null;
      this.stepPrev = null;
    } else if (this.prevG !== null && g <= this.prevG) {
      // an already seen grid frame: a revision (higher world.rev) or a duplicate (dropped)
      const seen = this.revs.get(g);
      if (w !== null && seen !== undefined && rev > seen) {
        this.c.revisions += 1;
        this.revs.set(g, rev);
        const keys = this.keysOf(g);
        const links = this.links.get(g) ?? NO_LINKS; // a revised event's tray stone is the one before its own frame
        for (const e of w.events ?? []) {
          const k = eventKey(e);
          if (keys.has(k)) continue;
          keys.add(k);
          events.push(this.makeEvent(f, e, w, links));
        }
        const closed: Activity[] = [];
        this.applyActivities(f, w, events, closed);
        this.emit(closed, acts);
        if (g >= (this.g as number)) this.takeState(w); // the cards come only with new frames
        this.ledger.skipped(); // a frame again, which the tray rules never read: it may hold a hand at work (4.6.1)
        return this.update(f, events, acts, [], true, false);
      }
      return this.update(f, events, acts, [], false, true);
    }
    // a new grid frame of this session
    const c = this.c;
    c.frames += 1;
    if (c.firstG === null) {
      c.firstG = g;
      c.firstT = t;
    }
    c.lastG = g;
    c.lastT = t;
    if (this.prevG !== null && g > this.prevG + 1) {
      c.gaps += 1;
      this.ledger.skipped(); // dropped frames: the tray rules could not read them (4.6.1)
    }
    this.prevG = g;
    const step = handStep(this.stepPrev, g, t);
    this.stepPrev = { g, t, step };
    if (this.sessionFirstT === null) this.sessionFirstT = t;
    this.sessionLastT = t;
    this.g = g;
    this.t = t;
    if (f.cards) this.cards = f.cards;
    // the tray links before this frame: its events', later its revisions', and the speckle answers', which also read
    // those of a frame without a world (4.6.12; one copy while they do not change)
    let links: ReadonlyMap<number, string> = this.ledger.links();
    if (this.lastLinks !== null && sameLinks(links, this.lastLinks)) links = this.lastLinks;
    this.links.set(g, links);
    this.lastLinks = links;
    if (w === null) {
      c.missingWorld += 1;
      this.ledger.skipped(); // a frame the tray rules can not read (4.6.1)
      return this.update(f, events, acts, facts, false, false);
    }
    c.framesWithWorld += 1;
    this.revs.set(g, rev);
    // stale push bursts close before this frame's events
    const closed: Activity[] = [];
    for (const [side, b] of [...this.bursts]) if (t - b.last.t > BURST_GAP) closed.push(this.endBurst(side));
    const keys = this.keysOf(g);
    for (const e of w.events ?? []) {
      keys.add(eventKey(e));
      events.push(this.makeEvent(f, e, w, links));
    }
    this.applyActivities(f, w, events, closed);
    this.emit(closed, acts);
    this.takeState(w);
    this.recordTracks(g, t, w);
    const ref = this.ref(f);
    this.lastWorldRef = ref;
    const n = (w.stones ?? []).length;
    c.stonesLast = n;
    c.stonesMax = Math.max(c.stonesMax, n);
    c.confirmedLast = w.stats?.confirmed ?? null;
    for (const side of ["left", "right"] as const) {
      const st = w.hands?.[side]?.state;
      if (st !== undefined && HAND_STATE_SET.has(st)) this.handMs[side][st] = this.handMs[side][st] + step;
    }
    this.prune(g);
    facts.push(...this.ledger.feed(w, ref));
    const speckle: TraySpeckle[] = [];
    if (w.speckle !== undefined) {
      // read after the trays took the frame (4.6.12)
      const answer = this.ledger.speckle(w.speckle, ref, (k) => this.links.get(k) ?? NO_LINKS);
      if (answer !== null) {
        speckle.push(answer);
        this.answers.push(answer);
        this.answers.splice(0, Math.max(0, this.answers.length - SPECKLE_KEPT)); // the newest
      }
    }
    return this.update(f, events, acts, facts, false, false, speckle);
  }

  /**
   * The end of the replay or stream, as the final update (`frame` null, `isFinal`): open moves close as `interrupted`,
   * open push bursts close (the update's `activities`, sorted), and the open tray leaves (its facts are the update's
   * `trayFacts`).
   */
  end(): Update {
    const acts: Activity[] = [];
    this.closeSession(acts);
    const facts = this.ledger.close();
    this.ledger = this.newLedger(null, null);
    this.session = null;
    return { ...this.update(null, [], acts, facts, false, false), isFinal: true };
  }

  /**
   * {@link InterpreterCore.end}'s activities: open moves close (as `interrupted`) and push bursts, e.g. at the end of a
   * replay; the open tray leaves (its facts are in `trays()`).
   */
  finish(): Activity[] {
    return [...this.end().activities];
  }

  /**
   * The trays so far, oldest first: those that have left (the newest `traysKept`, across sessions) and the open one.
   * Each has its `arrived` and `leaving` points, its tray stones and its facts (section 4.6).
   */
  trays(): Tray[] {
    const open = this.ledger.current();
    return open === null ? [...this.kept] : [...this.kept, open];
  }

  /**
   * The unit's speckle answers read so far, oldest first (the newest 1024, across sessions), each with its tray and the
   * tray stones in it (SDK-DESIGN.md 4.6.12). An answer that comes after its tray left is here, not in the tray.
   */
  speckle(): TraySpeckle[] {
    return [...this.answers];
  }

  private newLedger(session: number | null, video: string | null): TrayLedger {
    return new TrayLedger(this.trayCounts, session, video, (tray) => {
      this.kept.push(tray);
      if (this.traysKept > 0 && this.kept.length > this.traysKept) this.kept.shift();
    });
  }

  /** The counters so far (section 4.4). The open session's media seconds count up to its newest frame. */
  summary(): Summary {
    const c = this.c;
    let media = c.mediaSeconds;
    if (this.session !== null && this.sessionFirstT !== null)
      media += (this.sessionLastT as number) - this.sessionFirstT;
    const hands = { left: zeroHands(), right: zeroHands() };
    for (const side of ["left", "right"] as const)
      for (const k of HAND_STATES) hands[side][k] = round3(this.handMs[side][k] / 1000);
    const json: SummaryJson = {
      frames: c.frames,
      frames_with_world: c.framesWithWorld,
      missing_world: c.missingWorld,
      revisions: c.revisions,
      sessions: c.sessions,
      first_g: c.firstG,
      last_g: c.lastG,
      first_t: c.firstT === null ? null : round3(c.firstT),
      last_t: c.lastT === null ? null : round3(c.lastT),
      media_seconds: round3(media),
      gaps: c.gaps,
      events: { ...c.events } as SummaryJson["events"],
      moves: {
        total: c.moves.total as number,
        placed: c.moves.placed as number,
        dropped: c.moves.dropped as number,
        carried_away: c.moves.carried_away as number,
        removed: c.moves.removed as number,
        interrupted: c.moves.interrupted as number,
        partial: c.moves.partial as number,
        carried: c.moves.carried as number,
        mean_duration: this.durN === 0 ? null : round3(this.durSum / this.durN),
        mean_distance: this.distN === 0 ? null : round3(this.distSum / this.distN),
      },
      push_bursts: {
        total: c.bursts.total as number,
        pushes: c.bursts.pushes as number,
        left: c.bursts.left as number,
        right: c.bursts.right as number,
        both: c.bursts.both as number,
      },
      stones: { last: c.stonesLast, max: c.stonesMax, confirmed_last: c.confirmedLast },
      trays: {
        total: this.trayCounts.total,
        arrived: this.trayCounts.arrived,
        stones: this.trayCounts.stones,
        added: this.trayCounts.added,
        added_unclear: this.trayCounts.addedUnclear,
        removed: this.trayCounts.removed,
        removed_unclear: this.trayCounts.removedUnclear,
        unsure: this.trayCounts.unsure,
      },
      hands,
    };
    return new Summary(json);
  }

  /** The state after the newest frame. */
  get state(): InterpreterState {
    return {
      session: this.session,
      video: this.video,
      g: this.g,
      t: this.t,
      wall: this.t === null ? null : this.wallOf(this.session, this.t),
      stones: this.stones,
      hands: { left: this.handInfo("left"), right: this.handInfo("right") },
      board: this.board,
      stats: this.stats,
      openMoves: new Map(this.moves),
      tray: this.ledger.current(),
      counters: this.summary(),
    };
  }

  /** The path of a stone's solid in this session (oldest first, at most `trackPoints`), from the frames fed. */
  track(stoneId: number): readonly TrackPoint[] {
    return this.tracks.get(stoneId) ?? [];
  }

  private recordTracks(g: number, t: number, w: WorldLayer): void {
    for (const s of w.stones ?? []) {
      const pos = s.solid?.pos;
      if (typeof s.id !== "number" || !pos) continue;
      let path = this.tracks.get(s.id);
      const lastPoint = path?.[path.length - 1];
      if (lastPoint && lastPoint.pos[0] === pos[0] && lastPoint.pos[1] === pos[1] && lastPoint.pos[2] === pos[2])
        continue;
      if (path) this.tracks.delete(s.id);
      else path = [];
      path.push({ g, t, pos: [pos[0], pos[1], pos[2]] });
      if (path.length > this.trackPoints) path.splice(0, path.length - this.trackPoints);
      this.tracks.set(s.id, path);
      if (this.tracks.size > this.trackStones) this.tracks.delete(this.tracks.keys().next().value as number);
    }
  }

  private handInfo(side: "left" | "right"): HandInfo {
    const h: HandState | undefined = this.hands[side];
    const card = this.cards?.[side];
    return { state: h?.state ?? null, stone: h?.stone ?? null, card: card?.title ?? null };
  }

  private update(
    f: Frame | null,
    events: FactoryEvent[],
    acts: Activity[],
    trayFacts: TrayFact[],
    isRevision: boolean,
    isDuplicate: boolean,
    speckle: TraySpeckle[] = [],
  ): Update {
    return {
      frame: f,
      events,
      activities: acts,
      trayFacts,
      speckle,
      state: this.state,
      isRevision,
      isDuplicate,
      isBackfill: false,
      isFinal: false,
    };
  }

  private keysOf(g: number): Set<string> {
    let keys = this.emitted.get(g);
    if (!keys) {
      keys = new Set();
      this.emitted.set(g, keys);
    }
    return keys;
  }

  private prune(g: number): void {
    if (this.emitted.size <= 2 * KEEP_FRAMES) return;
    const oldest = g - KEEP_FRAMES;
    for (const k of [...this.emitted.keys()]) if (k < oldest) this.emitted.delete(k);
    for (const k of [...this.revs.keys()]) if (k < oldest) this.revs.delete(k);
    for (const k of [...this.links.keys()]) if (k < oldest) this.links.delete(k);
  }

  private closeSession(out: Activity[]): void {
    if (this.session === null) return;
    const closed: Activity[] = [];
    const ids = [...this.moves.keys()].sort(
      (a, b) => (a ?? Number.NEGATIVE_INFINITY) - (b ?? Number.NEGATIVE_INFINITY),
    );
    for (const sid of ids) {
      const m = this.moves.get(sid) as Move;
      m.outcome = "interrupted";
      m.end = this.lastWorldRef as FrameRef; // a move opens only in a frame with a world
      m.duration = m.end.t - m.start.t;
      m.to = null;
      m.distance = null;
      closed.push(m);
    }
    this.moves = new Map();
    for (const side of [...this.bursts.keys()]) closed.push(this.endBurst(side));
    this.emit(closed, out);
    if (this.sessionFirstT !== null) this.c.mediaSeconds += (this.sessionLastT as number) - this.sessionFirstT;
  }

  private emit(closed: Activity[], out: Activity[]): void {
    sortActivities(closed);
    for (const a of closed) this.countActivity(a);
    out.push(...closed);
  }

  private endBurst(side: string): PushBurst {
    const b = this.bursts.get(side) as PushBurst;
    this.bursts.delete(side);
    b.end = b.last;
    b.duration = b.end.t - b.start.t;
    return b;
  }

  private countActivity(a: Activity): void {
    const c = this.c;
    if (a.kind === "push") {
      c.bursts.total = (c.bursts.total as number) + 1;
      c.bursts.pushes = (c.bursts.pushes as number) + a.pushes;
      c.bursts[a.hand] = (c.bursts[a.hand] as number) + 1; // bursts exist only for left, right and both
      return;
    }
    const m = c.moves;
    const outcome = a.outcome as MoveOutcome;
    m.total = (m.total as number) + 1;
    m[outcome] = (m[outcome] as number) + 1;
    if (a.partial) m.partial = (m.partial as number) + 1;
    if (a.carried) m.carried = (m.carried as number) + 1;
    if (!a.partial && outcome !== "interrupted") {
      this.durSum += a.duration as number;
      this.durN += 1;
    }
    if (a.distance !== null) {
      this.distSum += a.distance;
      this.distN += 1;
    }
  }

  private makeEvent(f: Frame, e: WorldEvent, w: WorldLayer, links: ReadonlyMap<number, string>): FactoryEvent {
    const id = e.id ?? null;
    let stone: StoneView | null = null;
    for (const s of w.stones ?? []) {
      if ((s.id ?? null) === id) {
        stone = s;
        break;
      }
    }
    const type = String(e.type ?? "");
    const key = EVENT_TYPES.has(type) ? type : "other";
    this.c.events[key] = (this.c.events[key] as number) + 1;
    return new FactoryEvent({
      type,
      g: f.g,
      t: f.t,
      wall: this.wallOf(f.session ?? null, f.t),
      session: f.session ?? null,
      video: f.video ?? null,
      stoneId: id,
      hand: e.side ?? null,
      why: e.why ?? null,
      into: e.into ?? null,
      source: e.source ?? null,
      stone,
      trayStone: id === null ? null : (links.get(id) ?? null),
    });
  }

  private applyActivities(f: Frame, w: WorldLayer, events: readonly FactoryEvent[], closed: Activity[]): void {
    const ref = this.ref(f);
    const byId = new Map<number | null, StoneView>();
    for (const s of w.stones ?? []) byId.set(s.id ?? null, s);
    const pos = (sid: number | null): Point3 | null => {
      const p = byId.get(sid)?.solid?.pos;
      return p == null || p.length < 2 ? null : [p[0], p[1], p[2]]; // fewer than 2 numbers: as absent
    };
    const handClosed = new Set<number | null>();
    for (const ev of events)
      if (ev.type === "place" || ev.type === "drop" || ev.type === "gone") handClosed.add(ev.stoneId);
    for (const ev of events) {
      const { type, stoneId: sid, hand: side } = ev;
      // the same frame also has the hand's put-down or carry-away of this stone: that decides
      if (type === "delete" && handClosed.has(sid)) continue;
      if (type === "push") {
        if (side !== null && BURST_SIDES.has(side) && !ev.why) {
          let b = this.bursts.get(side);
          if (b !== undefined && f.t - b.last.t > BURST_GAP) {
            closed.push(this.endBurst(side));
            b = undefined;
          }
          if (b === undefined) {
            b = new PushBurst({ hand: side, start: ref, session: f.session ?? null, video: f.video ?? null });
            this.bursts.set(side, b);
          }
          b.last = ref;
          b.pushes += 1;
          if (sid !== null && !b.stones.includes(sid)) {
            b.stones.push(sid);
            b.stones.sort((x, y) => x - y);
          }
        }
        continue;
      }
      let m = this.moves.get(sid);
      if (type === "lift" || type === "hinge") {
        if (m === undefined) {
          this.moves.set(
            sid,
            new Move({
              stoneId: sid,
              hand: side,
              start: ref,
              from: pos(sid),
              tipped: type === "hinge",
              partial: false,
              session: f.session ?? null,
              video: f.video ?? null,
            }),
          );
        } else {
          if (type === "hinge") m.tipped = true;
          mergeHand(m, side);
        }
        continue;
      }
      if (type === "carry") {
        if (m !== undefined) {
          m.carried = true;
          mergeHand(m, side);
        }
        continue;
      }
      const outcome = Object.prototype.hasOwnProperty.call(CLOSING, type) ? CLOSING[type] : undefined;
      if (outcome === undefined) continue;
      if (m === undefined) {
        if (type === "delete") continue;
        m = new Move({
          stoneId: sid,
          hand: side,
          start: ref,
          from: null,
          tipped: false,
          partial: true,
          session: f.session ?? null,
          video: f.video ?? null,
        });
      } else {
        this.moves.delete(sid);
        mergeHand(m, side);
      }
      m.outcome = outcome;
      m.end = ref;
      m.duration = ref.t - m.start.t;
      m.to = outcome === "placed" || outcome === "dropped" ? pos(sid) : null;
      if (m.from !== null && m.to !== null) {
        const dx = m.to[0] - m.from[0];
        const dy = m.to[1] - m.from[1];
        m.distance = round3(Math.sqrt(dx * dx + dy * dy));
      }
      closed.push(m);
    }
  }

  private takeState(w: WorldLayer): void {
    const stones = new Map<number, StoneView>();
    for (const s of w.stones ?? []) if (typeof s.id === "number") stones.set(s.id, s);
    this.stones = stones;
    this.hands = w.hands ?? {};
    this.board = w.draw?.board ?? null;
    this.stats = w.stats ?? null;
  }
}

const NO_LINKS: ReadonlyMap<number, string> = new Map();
/** The unit's speckle answers that `speckle()` keeps (the newest). */
const SPECKLE_KEPT = 1024;

/** The same links: the same world ids to the same tray stones. */
function sameLinks(a: ReadonlyMap<number, string>, b: ReadonlyMap<number, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [wid, id] of a) if (b.get(wid) !== id) return false;
  return true;
}

function mergeHand(m: Move, side: string | null): void {
  if (side === null) return;
  if (m.hand === null) m.hand = side;
  else if (m.hand !== side) m.hand = "both";
}
