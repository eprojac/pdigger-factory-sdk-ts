/**
 * The high level (SDK-DESIGN.md section 2.4): an {@link Interpreter} follows the shared session and turns its frames
 * into typed events, activities, state and text. Every iterator of one interpreter shares one stream and one core: the
 * stream opens with the first consumer and closes when the last one leaves.
 *
 * @module
 */
import type { Api } from "../api.js";
import { FactoryError } from "../errors.js";
import { abortReason, linkSignals, throwIfAborted } from "../internal/abort.js";
import type { Clock } from "../internal/clock.js";
import { AsyncQueue } from "../internal/queue.js";
import type { Layer, Precision, State, StoneTrack, WorkerStatus } from "../models.js";
import type { RequestOptions } from "../transport.js";
import type { StreamItem, Streams } from "../streams.js";
import { InterpreterCore, type InterpreterCoreOptions, type TrackPoint } from "./core.js";
import type { Summary } from "./summary.js";
import type { Tray, TrayFact, TrayReport, TraySpeckle } from "./trays.js";
import type { Activity, FactoryEvent, InterpreterState, Update } from "./types.js";

declare global {
  /**
   * `Symbol.dispose` and `Symbol.asyncDispose` (explicit resource management) for this package's declarations: the
   * Interpreter and the client have `[Symbol.dispose]()` and `[Symbol.asyncDispose]()`, and a program whose `lib` has
   * neither `esnext.disposable` nor Node's types (a browser or Deno project on `["ES2022", "DOM"]` with `skipLibCheck`
   * off) compiles against them too. This merges with TypeScript's own declaration and `@types/node`'s.
   */
  interface SymbolConstructor {
    /** The method a `using` declaration calls at the end of its block. */
    readonly dispose: unique symbol;
    /** The method an `await using` declaration calls at the end of its block. */
    readonly asyncDispose: unique symbol;
  }
}

/** Options of `factory.interpreter()`. */
export interface InterpreterOptions {
  /** Layers to stream (default `["world", "cards"]`). */
  layers?: readonly Layer[];
  /**
   * True: do not count as a viewer (`observe=1`). Default: the client's `observe`, which is false unless the client was
   * made with `observe: true`: an integration that wants events must keep the interpreter running, and an idle worker
   * interprets nothing.
   */
  observe?: boolean;
  /** Hold frames whose world is late and read it back, so the core sees every frame in order (default true). */
  backfill?: boolean;
  precision?: Precision;
  /** `sse` (default) or `poll` (long-poll, for environments without streaming). */
  transport?: "sse" | "poll";
  /** Start after this cursor (default: the newest frame). */
  after?: number;
  /** Resume from this `<boot>-<cursor>` event id. */
  lastEventId?: string | null;
  /** Updates buffered per consumer before the stream waits for it (default 256). */
  highWaterMark?: number;
  /** Consecutive failed reconnects before the iterations fail (default: no limit, the stream keeps trying). */
  maxReconnects?: number;
  /**
   * Reconnect when the server ends the stream (default true). False: the iterations end when the server ends it (e.g.
   * a deployment that limits stream length). SSE only; the long-poll always goes on.
   */
  resume?: boolean;
  /** Close and resume a connection that went silent (default: the client's, 30 s; 0: never). SSE only. */
  idleTimeoutMs?: number;
  /**
   * Called with the `decode` error of a stream event that does not decode; the event is skipped and the interpreter
   * goes on (default: skipped silently). SSE only.
   */
  onDecodeError?: (error: FactoryError) => void;
  core?: InterpreterCoreOptions;
}

/** Where an Interpreter reports that its stream opened (`true`) or stopped (`false`): the client's set of them. */
export type InterpreterRegistry = (interpreter: Interpreter, active: boolean) => void;

/** Options of an iteration. */
export interface IterateOptions {
  /** Ends this iteration with the signal's reason (an `AbortError`), as `fetch` does. */
  signal?: AbortSignal;
}

/** What `waitFor` matches: an event type, several, or a predicate. */
export type EventMatch = string | readonly string[] | ((event: FactoryEvent) => boolean);

interface Subscriber {
  queue: AsyncQueue<Update>;
  /** Detaches the consumer's abort listener. */
  cleanup: () => void;
}

/**
 * Follows the shared session (a recording, or one of the plant cameras live) and interprets it. Get one with
 * `factory.interpreter()`. Its stream opens with the first consumer and closes when the last one leaves; `close()` (or
 * `using`) ends it for good. The client keeps an Interpreter only while its stream is open, so one that is done is
 * garbage like any object.
 */
export class Interpreter {
  /** The synchronous state machine every update goes through. */
  readonly core: InterpreterCore;
  private readonly subs = new Set<Subscriber>();
  private generation = 0;
  private controller: AbortController | null = null;
  private lastId: string | null;
  /** The rest of the frame where the last loop stopped (what it did not yield), for the next loop. */
  private pending: Update | null = null;
  private latestWorker: WorkerStatus | null = null;
  private latestClock: State | null = null;
  private readonly hwm: number;
  private closed = false;

  constructor(
    private readonly streams: Streams,
    private readonly api: Api,
    private readonly clock: Clock,
    private readonly options: InterpreterOptions = {},
    private readonly registry?: InterpreterRegistry,
  ) {
    this.core = new InterpreterCore(options.core);
    this.lastId = options.lastEventId ?? null;
    this.hwm = options.highWaterMark ?? 256;
  }

  /** The state after the newest frame. */
  get state(): InterpreterState {
    return this.core.state;
  }

  /** The newest worker status seen on the stream. */
  get worker(): WorkerStatus | null {
    return this.latestWorker;
  }

  /** The newest shared state seen on the stream (`clock` events). */
  get sessionState(): State | null {
    return this.latestClock;
  }

  /** The id of the newest frame event, to resume from. */
  get lastEventId(): string | null {
    return this.lastId;
  }

  /** Consumers iterating now. */
  get consumers(): number {
    return this.subs.size;
  }

  /** The counters so far. */
  summary(): Summary {
    return this.core.summary();
  }

  /**
   * Closes what is still open, e.g. before you stop following the session: open moves (as `interrupted`) and bursts,
   * which it returns; the open tray leaves (its facts are in `trays()`; `end()` returns them too).
   */
  finish(): Activity[] {
    return this.core.finish();
  }

  /** {@link Interpreter.finish} as the final update: the activities still open, the facts of the open tray leaving. */
  end(): Update {
    return this.core.end();
  }

  /**
   * The trays so far, oldest first (see {@link InterpreterCore.trays}): each with its tray stones, whose ids hold over
   * time, its facts, and its `arrived` and `leaving` points to jump between.
   */
  trays(): Tray[] {
    return this.core.trays();
  }

  /** The unit's speckle answers read so far, oldest first (see {@link InterpreterCore.speckle}). */
  speckle(): TraySpeckle[] {
    return this.core.speckle();
  }

  /**
   * A stone's path in this session from the frames this interpreter was fed (oldest first, at most the core's
   * `trackPoints`); the same as `interpreter.core.track(stoneId)`. The server's own track since the session began is
   * {@link Interpreter.serverTrack}.
   */
  track(stoneId: number): readonly TrackPoint[] {
    return this.core.track(stoneId);
  }

  /** A stone's path since the session began, from the server (`getStone`): the newest 512 points, 2-D and 3-D. */
  serverTrack(stoneId: number, options?: RequestOptions): Promise<StoneTrack> {
    return this.api.getStone(stoneId, options);
  }

  /** Stops the stream and ends every iteration. The interpreter cannot be used afterwards. Idempotent. */
  close(): void {
    this.closed = true;
    this.stop();
    for (const s of [...this.subs]) {
      s.cleanup();
      s.queue.end();
    }
    this.subs.clear();
  }

  /** `using interpreter = factory.interpreter()`: closes it at the end of the block. */
  [Symbol.dispose](): void {
    this.close();
  }

  /** `await using interpreter = factory.interpreter()`: closes it at the end of the block. */
  [Symbol.asyncDispose](): Promise<void> {
    this.close();
    return Promise.resolve();
  }

  /**
   * Every update: the frame, its events, the activities it completed, the tray facts it made, the state after it. When
   * the stream ends (the server ended it and `resume` is false), a last update has `isFinal` set, `frame` null, the
   * activities that `end()` closed (open moves as `interrupted`, open push bursts) and the facts of the open tray
   * leaving. A stream that does not end leaves the open tray open: call `end()` when you stop following.
   *
   * The iteration joins the interpreter's stream at its first `next()` (a `for await` does that at once), not when
   * `updates()` is called. All consumers of one interpreter share its stream, which waits for the slowest: each may
   * have `highWaterMark` updates (default 256) waiting before the stream stops reading for it, and so for all. Leave a
   * loop you no longer read (`break`, `return()`, the signal), and give consumers that go at their own pace an
   * interpreter each.
   *
   * Loops can follow one another: a later loop goes on where the last one stopped. Its first update may be the rest of
   * the frame that loop stopped in (only the events, activities and tray facts it did not yield), then come the frames
   * after it (the stream resumes after the last frame fed, while the unit still holds it).
   */
  updates(options: IterateOptions = {}): AsyncIterableIterator<Update> {
    if (this.closed) throw new FactoryError({ code: "stream_closed", message: "the interpreter is closed" });
    let queue: AsyncQueue<Update> | null = null;
    let left = false;
    const joined = (): AsyncQueue<Update> => {
      queue ??= this.subscribe(options);
      return queue;
    };
    const iterator: AsyncIterableIterator<Update> = {
      next: () => {
        if (left) return Promise.resolve({ value: undefined, done: true });
        const rest = queue === null ? this.takePending() : null;
        return rest !== null ? Promise.resolve({ value: rest, done: false }) : joined().next();
      },
      return: () => {
        left = true;
        return queue === null ? Promise.resolve({ value: undefined, done: true }) : queue.return();
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  /** Joins the stream: the consumer's queue (ended at once when the interpreter was closed meanwhile). */
  private subscribe(options: IterateOptions): AsyncQueue<Update> {
    const cleanup = (): void => options.signal?.removeEventListener("abort", onAbort);
    const sub: Subscriber = {
      queue: new AsyncQueue<Update>(() => {
        cleanup();
        this.unsubscribe(sub);
      }),
      cleanup,
    };
    const onAbort = (): void => {
      sub.queue.fail(abortReason(options.signal as AbortSignal));
      this.unsubscribe(sub);
    };
    if (this.closed) {
      sub.queue.end();
      return sub.queue;
    }
    if (options.signal?.aborted) {
      sub.queue.fail(abortReason(options.signal));
      return sub.queue;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.subs.add(sub);
    if (this.subs.size === 1) this.start();
    return sub.queue;
  }

  /**
   * Just the events, typed, in world order (optionally only some types). The final update has none. A loop that stops
   * inside a frame leaves the rest of it (its later events, its activities and tray facts) to the next loop.
   */
  async *events(options: IterateOptions & { types?: readonly string[] } = {}): AsyncGenerator<FactoryEvent> {
    const types = options.types === undefined ? null : new Set(options.types);
    for await (const u of this.updates(options)) {
      let passed = 0; // events of u yielded or passed over
      let done = false;
      try {
        for (const e of u.events) {
          throwIfAborted(options.signal); // an abort ends the iteration at once, also inside an update
          passed++;
          if (types === null || types.has(e.type)) yield e;
        }
        done = true;
      } finally {
        if (!done) this.keep(u, passed, 0, 0);
      }
    }
  }

  /**
   * Just the activities (moves and push bursts), as they complete; at the end of the stream, those it closed. A loop
   * that stops inside a frame leaves the rest of it (its later activities, its events and tray facts) to the next loop.
   */
  async *activities(options: IterateOptions = {}): AsyncGenerator<Activity> {
    for await (const u of this.updates(options)) {
      let passed = 0;
      let done = false;
      try {
        for (const a of u.activities) {
          throwIfAborted(options.signal);
          passed++;
          yield a;
        }
        done = true;
      } finally {
        if (!done) this.keep(u, 0, passed, 0);
      }
    }
  }

  /**
   * Just the tray facts (section 4.6): trays arriving and leaving, tray stones removed, set down or no longer sure, as
   * frames make them; at the end of the stream, those of the open tray leaving. Every fact names its tray stone by the
   * SDK's own id, which no other stone ever gets. A loop that stops inside a frame leaves the rest of it (its later
   * facts, its events and activities) to the next loop.
   */
  async *trayFacts(options: IterateOptions = {}): AsyncGenerator<TrayFact> {
    for await (const u of this.updates(options)) {
      let passed = 0;
      let done = false;
      try {
        for (const f of u.trayFacts) {
          throwIfAborted(options.signal);
          passed++;
          yield f;
        }
        done = true;
      } finally {
        if (!done) this.keep(u, 0, 0, passed);
      }
    }
  }

  /**
   * A report as each tray leaves (section 4.7): which stones were removed, added and moved, and whether that is the
   * tray's whole account. A tray leaves when the next one arrives, the session changes or the frames end.
   */
  async *trayReports(options: IterateOptions = {}): AsyncGenerator<TrayReport> {
    for await (const f of this.trayFacts(options)) {
      if (f.kind !== "leaving") continue;
      const left = this.core.trays().filter((t) => t.session === f.session && t.n === f.tray);
      yield* left.map((t) => t.report()).filter((r): r is TrayReport => r !== null);
    }
  }

  /**
   * Keeps the rest of `u`, after its first `events` events, first `activities` activities and first `facts` tray facts,
   * for the next loop.
   */
  private keep(u: Update, events: number, activities: number, facts: number): void {
    const rest: Update = {
      ...u,
      events: u.events.slice(events),
      activities: u.activities.slice(activities),
      trayFacts: u.trayFacts.slice(facts),
    };
    if (rest.events.length > 0 || rest.activities.length > 0 || rest.trayFacts.length > 0) this.pending = rest;
  }

  /** The rest of the frame the last loop stopped in, once. */
  private takePending(): Update | null {
    const rest = this.pending;
    this.pending = null;
    return rest;
  }

  /**
   * The first event that matches (a type, several types, or a predicate). With `timeout` (ms, on the client's clock)
   * it rejects with a `TimeoutError`; if the stream ends first, with a `stream_closed` error. The rest of the matching
   * event's frame (its later events and its activities) is left to the next loop.
   */
  async waitFor(match: EventMatch, options: IterateOptions & { timeout?: number } = {}): Promise<FactoryEvent> {
    const pred =
      typeof match === "function"
        ? match
        : (e: FactoryEvent): boolean => (typeof match === "string" ? e.type === match : match.includes(e.type));
    const link = linkSignals(options.signal);
    const timer = new AbortController();
    if (options.timeout !== undefined) {
      const ms = options.timeout;
      this.clock.sleep(ms, timer.signal).then(
        () => link.abort(new DOMException(`no matching event within ${ms} ms`, "TimeoutError")),
        () => undefined,
      );
    }
    try {
      for await (const e of this.events({ signal: link.signal })) if (pred(e)) return e;
      throw new FactoryError({ code: "stream_closed", message: "the stream ended before a matching event" });
    } finally {
      timer.abort();
      link.dispose();
    }
  }

  private unsubscribe(sub: Subscriber): void {
    this.subs.delete(sub);
    if (this.subs.size === 0) this.stop();
  }

  private stop(): void {
    this.generation++;
    this.controller?.abort(new DOMException("no consumers", "AbortError"));
    this.controller = null;
    this.registry?.(this, false);
  }

  private start(): void {
    const gen = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.registry?.(this, true);
    void this.pump(gen, controller.signal);
  }

  private items(signal: AbortSignal): AsyncGenerator<StreamItem> {
    const o = this.options;
    const common = {
      layers: o.layers ?? (["world", "cards"] as const),
      observe: o.observe, // undefined: the client's default
      maxReconnects: o.maxReconnects,
    };
    if (o.transport === "poll") {
      return this.streams.poll({ ...common, backfill: o.backfill ?? true, precision: o.precision, signal });
    }
    return this.streams.frames({
      ...common,
      resume: o.resume,
      backfill: o.backfill ?? true,
      precision: o.precision,
      after: this.lastId === null ? o.after : undefined,
      lastEventId: this.lastId,
      clockOnConnect: true, // the unit sends no clock on connect: wall times need the state now
      idleTimeoutMs: o.idleTimeoutMs,
      onDecodeError: o.onDecodeError,
      signal,
    });
  }

  private async pump(gen: number, signal: AbortSignal): Promise<void> {
    try {
      for await (const item of this.items(signal)) {
        if (gen !== this.generation) return;
        if (item.kind === "clock") {
          this.latestClock = item.state;
          this.core.setClock(item.state);
          continue;
        }
        if (item.kind === "worker") {
          this.latestWorker = item.worker;
          continue;
        }
        if (item.kind === "gap" || item.kind === "reset") {
          this.core.gap(); // the stream dropped frames here (4.6.1)
          continue;
        }
        if (item.kind !== "frame") continue; // a kind this version does not know: ignored
        if (item.id !== null) this.lastId = item.id;
        const u = this.core.feed(item.frame);
        if (u.isDuplicate) continue;
        const update: Update = item.isBackfill ? { ...u, isBackfill: true } : u;
        for (const s of this.subs) s.queue.push(update);
        for (const s of [...this.subs]) await s.queue.drained(this.hwm);
      }
      if (gen !== this.generation) return;
      // the stream ended (the server ended it, `resume` off): close what is open, as a replay's last update does
      const final = this.core.end();
      for (const s of this.detachAll()) {
        s.queue.push(final);
        s.queue.end();
      }
    } catch (err) {
      if (gen === this.generation && !signal.aborted) for (const s of this.detachAll()) s.queue.fail(err);
    }
  }

  /** Forgets every consumer (the stream ended): the next iteration opens a new stream. */
  private detachAll(): Subscriber[] {
    const subs = [...this.subs];
    for (const s of subs) s.cleanup();
    this.subs.clear();
    this.generation++;
    this.controller = null;
    this.registry?.(this, false);
    return subs;
  }
}
