/**
 * The mid level (SDK-DESIGN.md section 2.3): frames as one endless async stream with resume by `Last-Event-ID`,
 * reconnects with backoff, side events (clock, worker, gap, reset), world revisions flagged, duplicates dropped, and
 * late layers backfilled in order. `poll()` is the long-poll equivalent; `rawPackets()` the `raw/stream` one.
 *
 * Each connection ends when the server ends it, when it breaks, when it has delivered `limit` frames or lasted `maxS`
 * seconds (the SDK counts both itself: the 20.20 unit sends nothing more by then, but closes a finished stream only
 * about 10 s later), or when it has been silent for `idleTimeoutMs` after it began sending (a half-open connection).
 *
 * @module
 */
import type { Api, LayersParam } from "./api.js";
import { FactoryError } from "./errors.js";
import { abortReason, linkSignals, throwIfAborted } from "./internal/abort.js";
import { cleanFrame } from "./internal/looks.js";
import type { Clock } from "./internal/clock.js";
import { frameProblem, packetProblem, sideProblem } from "./internal/shape.js";
import type {
  ClockEvent,
  Frame,
  GapEvent,
  Precision,
  ResetEvent,
  Sip1Packet,
  State,
  StreamFormat,
  WorkerStatus,
} from "./models.js";
import { StreamEvent, type EventStream } from "./sse.js";
import type { Transport } from "./transport.js";

/** A frame of the stream. */
export interface FrameItem {
  readonly kind: "frame";
  readonly frame: Frame;
  /** The SSE id `<boot>-<cursor>` (null for long-poll frames). */
  readonly id: string | null;
  /** A higher `world.rev` than a frame already delivered for the same (session, g). */
  readonly isRevision: boolean;
  /** Its late layers were read back with `GET /frames/{g}`. */
  readonly isBackfill: boolean;
}

/** The shared state changed (`clock` event). */
export interface ClockItem {
  readonly kind: "clock";
  readonly state: State;
  /** The server's wall clock when it was sent (epoch seconds). */
  readonly serverNow: number;
}

/** The interpreter worker's status (`worker` event). */
export interface WorkerItem {
  readonly kind: "worker";
  readonly worker: WorkerStatus;
}

/** That many items were skipped for a slow consumer (`gap` event). */
export interface GapItem {
  readonly kind: "gap";
  readonly count: number;
}

/** The server restarted (`reset` event): the stream goes on from the newest. */
export interface ResetItem {
  readonly kind: "reset";
  readonly boot: string;
  readonly cursor: number;
}

/** What `streams.frames()` and `streams.poll()` yield. */
export type StreamItem = FrameItem | ClockItem | WorkerItem | GapItem | ResetItem;

/** A raw packet of `raw/stream`. */
export interface PacketItem {
  readonly kind: "packet";
  readonly packet: Sip1Packet;
  readonly id: string | null;
}

/** What `streams.rawPackets()` yields. */
export type RawItem = PacketItem | ClockItem | WorkerItem | GapItem | ResetItem;

/** Options of `streams.frames()`. */
export interface FramesOptions {
  /** Layers (default the API's: overlay, scene, cards, world). */
  layers?: LayersParam;
  /** Start after this cursor (default: the newest). */
  after?: number;
  /** Resume from this `<boot>-<cursor>` event id. */
  lastEventId?: string | null;
  /** True: not a viewer (`observe=1`). Default: the client's `observe`. */
  observe?: boolean;
  precision?: Precision;
  /** Reconnect when the server ends the stream or the connection fails (default true). */
  resume?: boolean;
  /** Hold frames with late layers and read the layers back (default false here; the Interpreter's default is true). */
  backfill?: boolean;
  /**
   * Frames per connection (1..4096): asked of the server and counted here; after that many `frame` events the SDK
   * closes the connection and, with `resume`, reconnects at once with `Last-Event-ID`.
   */
  limit?: number;
  /** Seconds per connection (1..3600): asked of the server and timed here, on the client's clock. */
  maxS?: number;
  /**
   * After every (re)connect, read the shared state (`GET /session`) and pass it on first as a `clock` item: the unit
   * sends a `clock` event only when the state changes, none on connect (default false; the Interpreter's is true).
   */
  clockOnConnect?: boolean;
  /**
   * Close a connection that has sent something and then nothing for this long, and resume it: a half-open connection
   * (the unit lost power, a NAT dropped the entry) never ends by itself. The unit sends a `worker` event about every
   * 5 s while it runs. Any byte counts, comments too; a connection that has sent nothing yet is left open (a quiet unit
   * is normal). Silence is checked once per period, so a connection closes one to two periods after its last byte. On
   * the client's clock; default: the client's `idleTimeoutMs` (30 s); 0 turns it off.
   */
  idleTimeoutMs?: number;
  /** Consecutive failed reconnects before giving up (default: no limit). The first connect uses the client's retries. */
  maxReconnects?: number;
  /**
   * Called with the `decode` error of an event whose data does not decode (not JSON, or not the shape of its type).
   * Such an event is skipped and the stream goes on (its id still counts for resuming); default: skipped silently.
   */
  onDecodeError?: (error: FactoryError) => void;
  signal?: AbortSignal;
}

/** Options of `streams.poll()`. */
export interface PollOptions {
  layers?: LayersParam;
  /** Start after this cursor (default 0). */
  cursor?: number;
  /** True: not a viewer (no `cid`). Default: the client's `observe`. */
  observe?: boolean;
  /** The viewer id to send (default: a random one, when not observing). */
  cid?: string;
  /** Frames per reply (1..16). */
  limit?: number;
  /** Longest wait per reply in ms (0..1000). */
  wait?: number;
  precision?: Precision;
  backfill?: boolean;
  maxReconnects?: number;
  signal?: AbortSignal;
}

/** Options of `streams.rawPackets()`: as {@link FramesOptions}, for `raw/stream`. */
export interface RawPacketsOptions {
  /** `sse` (default) or `ndjson` (no event ids: a reconnect asks for `after` the last packet's cursor). */
  format?: StreamFormat;
  after?: number;
  lastEventId?: string | null;
  observe?: boolean;
  resume?: boolean;
  /** Packets per connection, asked of the server and counted here. */
  limit?: number;
  /** Seconds per connection, asked of the server and timed here. */
  maxS?: number;
  /** As in {@link FramesOptions.idleTimeoutMs}. NDJSON carries no `worker` events: a paused session is silent. */
  idleTimeoutMs?: number;
  maxReconnects?: number;
  /** As in {@link FramesOptions.onDecodeError}: an event that does not decode is skipped. */
  onDecodeError?: (error: FactoryError) => void;
  signal?: AbortSignal;
}

/** Defaults the client gives its streams. */
export interface StreamDefaults {
  /** `observe` of streams that do not say. */
  observe: boolean;
  /** `idleTimeoutMs` of streams that do not say (default 30 s). */
  idleTimeoutMs?: number;
}

/** The default of `idleTimeoutMs`: six missed `worker` events. */
export const IDLE_TIMEOUT_MS = 30_000;

/**
 * Backfill timing (SDK-DESIGN.md 2.3 rule 6): `tries` reads due `delayMs`, then every `spacingMs`, after the frame
 * arrived, each one request of at most `readTimeoutMs` without retries, so a late layer holds the frames behind it
 * about 4.5 s at the most.
 */
export const BACKFILL = { delayMs: 1500, tries: 3, spacingMs: 1000, readTimeoutMs: 1000 } as const;

const DEDUPE_KEYS = 8192;

/** Rule 9: an event whose data is not the shape of its type does not decode. */
function undecodable(what: string, why: string): FactoryError {
  return new FactoryError({ code: "decode", message: `${what} that does not decode: ${why}` });
}

function frameOf(ev: StreamEvent): Frame {
  const f = ev.json();
  const why = frameProblem(f);
  if (why !== null) throw undecodable("a frame event", why);
  return cleanFrame(f) as Frame; // a look that does not fit is dropped, its stone kept
}

function packetOf(ev: StreamEvent): Sip1Packet {
  const p = ev.json();
  const why = packetProblem(p);
  if (why !== null) throw undecodable("a packet event", why);
  return p as Sip1Packet;
}

/**
 * Rule 9: an event whose data does not decode is skipped (the caller's `onDecodeError` hears of it) and the stream
 * goes on; any other error is thrown on.
 */
function skipUndecodable(err: unknown, onDecodeError: ((error: FactoryError) => void) | undefined): void {
  if (!(err instanceof FactoryError) || err.code !== "decode") throw err;
  onDecodeError?.(err);
}

/** Maps a raw stream event to a side item, or null for `frame` and unknown events. */
function sideItem(ev: StreamEvent): ClockItem | WorkerItem | GapItem | ResetItem | null {
  if (ev.event !== "clock" && ev.event !== "worker" && ev.event !== "gap" && ev.event !== "reset") return null;
  const data = ev.json();
  const why = sideProblem(ev.event, data);
  if (why !== null) throw undecodable(`a ${ev.event} event`, why);
  switch (ev.event) {
    case "clock": {
      const { server_now, ...state } = data as ClockEvent;
      return { kind: "clock", state: state as State, serverNow: server_now };
    }
    case "worker":
      return { kind: "worker", worker: data as WorkerStatus };
    case "gap":
      return { kind: "gap", count: (data as GapEvent).gap };
    default: {
      const { boot, cursor } = data as ResetEvent;
      return { kind: "reset", boot, cursor };
    }
  }
}

/** The world revision of a frame (0 without a world or a `rev`). */
function revOf(frame: Frame): number {
  return frame.world?.rev ?? 0;
}

/** Rule 4 and 7: flags revisions, drops duplicates (same or lower `world.rev` for a delivered (session, g)). */
export class Deduper {
  private readonly seen = new Map<string, number>();

  /** Null for a duplicate, else the item (with `isRevision` set). */
  check(item: FrameItem): FrameItem | null {
    const key = `${item.frame.session}:${item.frame.g}`;
    const rev = revOf(item.frame);
    const before = this.seen.get(key);
    if (before !== undefined && rev <= before) return null;
    this.seen.delete(key);
    this.seen.set(key, rev);
    if (this.seen.size > DEDUPE_KEYS) this.seen.delete(this.seen.keys().next().value as string);
    return before === undefined ? item : { ...item, isRevision: true };
  }
}

/** The boot part of a `<boot>-<cursor>` event id, or null for no id (or one without a dash). */
function bootOfId(id: string | null): string | null {
  const dash = id === null ? -1 : id.lastIndexOf("-");
  return dash > 0 ? (id as string).slice(0, dash) : null;
}

/**
 * Rule 7 for raw packets: a packet is dropped only when it repeats one already passed on in the same boot (the unit's
 * process run), by its cursor. Cursors start again when the unit restarts, so a `reset` item, or a frame id of another
 * boot, starts a new count. NDJSON has neither ids nor resets: there, a new connection whose first packet is not above
 * the newest cursor passed on is a unit that restarted (it honours `after` otherwise), and its packets are passed on.
 */
export class PacketCursors {
  private boot: string | null = null;
  private latest = -1;
  private fresh = true;

  /** The cursor of the newest packet passed on in this boot (-1: none): where an NDJSON reconnect asks to start. */
  get newest(): number {
    return this.latest;
  }

  /** A new connection opened. */
  connected(): void {
    this.fresh = true;
  }

  /** The unit restarted as `boot` (a `reset` item): its cursors count again. */
  reset(boot: string): void {
    this.boot = boot;
    this.latest = -1;
  }

  /** True to pass the packet on, false for a repeat. `id` is its SSE event id (null over NDJSON). */
  pass(id: string | null, cursor: number | null): boolean {
    const boot = bootOfId(id);
    if (boot !== null) {
      if (boot !== this.boot) this.reset(boot);
    } else if (this.fresh && cursor !== null && cursor <= this.latest) {
      this.latest = -1; // NDJSON: a restarted unit answered from its own (lower) newest cursor
    }
    this.fresh = false;
    if (cursor === null) return true;
    if (cursor <= this.latest) return false;
    this.latest = cursor;
    return true;
  }
}

/**
 * Reads a frame's late layers back (rule 6), in the stream's precision: each try asks only for the layers still
 * missing and keeps what the earlier tries read. The whole frame when every layer came; when only some came, the frame
 * with those, its `missing` the rest; null when none came.
 */
export async function completeFrame(
  api: Api,
  clock: Clock,
  frame: Frame,
  signal: AbortSignal,
  timing: { delayMs: number; tries: number; spacingMs: number; readTimeoutMs?: number } = BACKFILL,
  precision?: Precision,
): Promise<Frame | null> {
  let missing = [...(frame.missing ?? [])];
  const merged: Frame = { ...frame };
  let gotAny = false;
  const arrived = clock.now();
  const timeoutMs = timing.readTimeoutMs ?? BACKFILL.readTimeoutMs;
  const partly = (): Frame | null => (gotAny ? { ...merged, missing } : null);
  for (let attempt = 0; attempt < timing.tries; attempt++) {
    const wait = arrived + timing.delayMs + attempt * timing.spacingMs - clock.now();
    if (wait > 0) await clock.sleep(wait, signal);
    let got: Frame;
    try {
      got = await api.getFrame(frame.g, {
        layers: missing,
        session: frame.session,
        signal,
        retries: 0,
        timeoutMs,
        ...(precision === undefined ? {} : { precision }),
      });
    } catch (err) {
      throwIfAborted(signal);
      if (err instanceof FactoryError && (err.code === "not_retained" || err.code === "session_gone")) return partly();
      continue;
    }
    const still: typeof missing = [];
    for (const layer of missing) {
      const value = (got as unknown as Record<string, unknown>)[layer];
      if (value === undefined || (got.missing ?? []).includes(layer)) still.push(layer);
      else {
        (merged as unknown as Record<string, unknown>)[layer] = value;
        gotAny = true;
      }
    }
    missing = still;
    if (still.length === 0) {
      delete merged.missing;
      return merged;
    }
  }
  return partly();
}

/**
 * Rule 6: holds a frame with late layers, and every frame after it, until its layers are read back (or cannot be),
 * then releases them in order. Side items are never held.
 */
export async function* holdForBackfill<T extends { kind: string }>(
  source: AsyncIterable<T | FrameItem>,
  complete: (frame: Frame, signal: AbortSignal) => Promise<Frame | null>,
  signal: AbortSignal,
): AsyncGenerator<T | FrameItem> {
  interface Held {
    item: FrameItem;
    ready: boolean;
  }
  const it = source[Symbol.asyncIterator]();
  const held: Held[] = [];
  let pending: Promise<IteratorResult<T | FrameItem>> | null = null;
  let sourceDone = false;
  let wake!: () => void;
  let woken = new Promise<void>((r) => (wake = r));
  const notify = (): void => {
    const w = wake;
    woken = new Promise<void>((r) => (wake = r));
    w();
  };
  try {
    for (;;) {
      while (held.length > 0 && (held[0] as Held).ready) yield (held.shift() as Held).item;
      if (sourceDone) {
        if (held.length === 0) return;
        await woken;
        continue;
      }
      pending ??= it.next();
      // only a held frame waits for a read back: with none held, wait for the source alone (no reaction left behind)
      const raced =
        held.length === 0
          ? { r: await pending }
          : await Promise.race([pending.then((r) => ({ r })), woken.then(() => null)]);
      if (raced === null) continue;
      pending = null;
      if (raced.r.done) {
        sourceDone = true;
        continue;
      }
      const item = raced.r.value;
      if (item.kind !== "frame") {
        yield item;
        continue;
      }
      const frameItem = item as FrameItem;
      const late = (frameItem.frame.missing ?? []).length > 0;
      if (!late && held.length === 0) {
        yield frameItem;
        continue;
      }
      const h: Held = { item: frameItem, ready: !late };
      held.push(h);
      if (late) {
        complete(frameItem.frame, signal).then(
          (full) => {
            if (full !== null) h.item = { ...frameItem, frame: full, isBackfill: true };
            h.ready = true;
            notify();
          },
          () => {
            h.ready = true;
            notify();
          },
        );
      }
    }
  } finally {
    if (pending !== null) pending.catch(() => undefined);
    void it.return?.(undefined)?.catch?.(() => undefined);
  }
}

/** Reconnection with backoff after the first successful connection, and the per-connection bounds (rule 2). */
interface ResumeOptions {
  resume: boolean;
  maxReconnects: number;
  signal: AbortSignal;
  /** `frame` events per connection (counted here); none when undefined or 0. */
  limit: number | undefined;
  /** Seconds per connection on the client's clock; none when undefined or 0. */
  maxS: number | undefined;
  /** Silence (ms) after the first byte that closes a connection; 0: never. */
  idleMs: number;
  /** After every (re)connect: an event to pass on first, or null. */
  onOpen?: (signal: AbortSignal) => Promise<StreamEvent | null>;
  /** Told of every connection that opened, before its first event. */
  onConnect?: () => void;
}

/** Why a connection gives no further event. */
type Cutoff = "max_s" | "idle";

/**
 * The next event of a connection, or why there is none in time: its `max_s` deadline passed, or a whole `idleMs` passed
 * without a byte (watched only once it has sent a byte; one to two `idleMs` after the last one). Bytes that arrive
 * without completing an event (a comment, part of a large frame) keep the connection alive.
 */
async function nextEvent(
  it: AsyncIterator<StreamEvent>,
  stream: EventStream,
  clock: Clock,
  deadline: number | null,
  idleMs: number,
): Promise<IteratorResult<StreamEvent> | Cutoff> {
  const pending = it.next();
  const cut = (why: Cutoff): Cutoff => {
    pending.catch(() => undefined); // it settles when the connection is closed
    return why;
  };
  for (;;) {
    const now = clock.now();
    if (deadline !== null && now >= deadline) return cut("max_s");
    const watching = idleMs > 0 && stream.received > 0;
    if (deadline === null && !watching) return pending;
    const wait = Math.min(
      deadline === null ? Number.POSITIVE_INFINITY : deadline - now,
      watching ? idleMs : Number.POSITIVE_INFINITY,
    );
    const mark = stream.received;
    const timer = new AbortController();
    const timeout = clock.sleep(wait, timer.signal).then(
      () => null,
      () => null,
    );
    let result: IteratorResult<StreamEvent> | null;
    try {
      result = await Promise.race([pending, timeout]);
    } finally {
      timer.abort();
    }
    if (result !== null) return result;
    if (deadline !== null && clock.now() >= deadline) return cut("max_s");
    if (stream.received === mark) return cut("idle");
    // bytes came meanwhile without completing an event: the connection is alive, wait on
  }
}

/** The `<boot>-<cursor>` a `reset` event names, from where the stream goes on; null when it names none. */
function resetId(ev: StreamEvent): string | null {
  let data: unknown;
  try {
    data = ev.json();
  } catch {
    return null; // the caller's decoding reports it
  }
  if (sideProblem("reset", data) !== null) return null; // a reset that does not decode moves no resume id
  const { boot, cursor } = data as ResetEvent;
  return `${boot}-${cursor}`;
}

/**
 * One endless sequence of raw events over reconnections: `open(lastEventId)` makes one connection. A connection that
 * delivered events and ended (the server's end, `limit`, `max_s`, silence) is reopened at once with the last event id;
 * one that failed, or ended without an event, after the backoff, counting towards `maxReconnects`.
 */
async function* resumable(
  http: Transport,
  open: (lastEventId: string | null, signal: AbortSignal) => Promise<EventStream>,
  firstLastId: string | null,
  options: ResumeOptions,
): AsyncGenerator<StreamEvent> {
  let lastId = firstLastId;
  let connected = false;
  let failures = 0;
  const limit = options.limit !== undefined && options.limit > 0 ? options.limit : null;
  const maxMs = options.maxS !== undefined && options.maxS > 0 ? options.maxS * 1000 : null;
  for (;;) {
    throwIfAborted(options.signal);
    let stream: EventStream | null = null;
    let it: AsyncIterator<StreamEvent> | null = null;
    let delivered = 0;
    let error: unknown = null;
    try {
      stream = await open(lastId, options.signal);
      connected = true;
      options.onConnect?.();
      const deadline = maxMs === null ? null : http.clock.now() + maxMs;
      const first = options.onOpen ? await options.onOpen(options.signal) : null;
      if (first !== null) yield first;
      it = stream[Symbol.asyncIterator]();
      let frames = 0;
      for (;;) {
        const r = await nextEvent(it, stream, http.clock, deadline, options.idleMs);
        if (r === "max_s" || r === "idle" || r.done === true) break;
        const ev = r.value;
        delivered++;
        if (ev.id !== null) lastId = ev.id;
        if (ev.event === "reset") lastId = resetId(ev) ?? lastId; // the stream goes on in the new boot
        yield ev;
        if (ev.event === "frame" && limit !== null && ++frames >= limit) break; // the server would close it 10 s later
      }
    } catch (err) {
      if (options.signal.aborted) throw abortReason(options.signal);
      if (!(err instanceof FactoryError) || !err.isRetryable() || !connected || !options.resume) throw err;
      error = err;
    } finally {
      stream?.close(); // a pending read ends with the connection
      void it?.return?.(undefined)?.catch(() => undefined);
    }
    if (!options.resume) return;
    if (delivered > 0) failures = 0;
    if (error === null && delivered > 0) continue; // reconnect at once
    failures++;
    if (failures > options.maxReconnects) {
      if (error !== null) throw error as Error; // the last retryable error (a FactoryError)
      throw new FactoryError({ code: "stream_closed", message: `the stream ended ${failures} times without an event` });
    }
    const wait =
      error instanceof FactoryError && error.retryMs !== null ? error.retryMs : http.backoffDelay(failures - 1);
    await http.clock.sleep(wait, options.signal);
  }
}

function randomCid(random: () => number): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "sdk-ts-";
  for (let i = 0; i < 16; i++) s += abc[Math.floor(random() * abc.length)] as string;
  return s;
}

/** The mid level. Reach it as `factory.streams`. */
export class Streams {
  /**
   * @param onState Called with the shared state of every `clock` item a stream yields (the client keeps the newest as
   *   `factory.session.lastState`).
   */
  constructor(
    private readonly api: Api,
    private readonly http: Transport,
    private readonly defaults: StreamDefaults = { observe: false },
    private readonly onState?: (state: State) => void,
  ) {}

  /**
   * Frames as one endless stream: SSE with resume by `Last-Event-ID`, side events, revisions flagged, duplicates
   * dropped, and (with `backfill`) late layers read back in order. Cancel with `signal` or by leaving the loop: both
   * close the connection.
   */
  frames(options: FramesOptions = {}): AsyncGenerator<StreamItem> {
    return this.deliver(
      (signal) => this.frameItems(options, signal),
      options.backfill ?? false,
      options.signal,
      options.precision,
    );
  }

  private resumeOptions(
    options: FramesOptions | RawPacketsOptions,
    signal: AbortSignal,
    hooks: Pick<ResumeOptions, "onOpen" | "onConnect"> = {},
  ): ResumeOptions {
    return {
      resume: options.resume ?? true,
      maxReconnects: options.maxReconnects ?? Number.POSITIVE_INFINITY,
      signal,
      limit: options.limit,
      maxS: options.maxS,
      idleMs: options.idleTimeoutMs ?? this.defaults.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
      ...hooks,
    };
  }

  /** The shared state now, as a `clock` event to pass on first after a (re)connect; null when it cannot be read. */
  private async clockNow(signal: AbortSignal): Promise<StreamEvent | null> {
    try {
      const reply = await this.api.getSession({ signal });
      const data = { ...reply.state, server_now: reply.server_now };
      return new StreamEvent("clock", JSON.stringify(data), null, null, { value: data });
    } catch {
      throwIfAborted(signal);
      return null; // wall times wait for the stream's next clock event
    }
  }

  private async *frameItems(options: FramesOptions, signal: AbortSignal): AsyncGenerator<StreamItem> {
    const observe = options.observe ?? this.defaults.observe;
    let after = options.after;
    const events = resumable(
      this.http,
      (lastEventId, s) => {
        const p = this.api.streamFrames({
          layers: options.layers,
          after: lastEventId === null ? after : undefined,
          lastEventId,
          observe,
          precision: options.precision,
          limit: options.limit,
          maxS: options.maxS,
          signal: s,
        });
        after = undefined;
        return p;
      },
      options.lastEventId ?? null,
      this.resumeOptions(options, signal, options.clockOnConnect ? { onOpen: (s) => this.clockNow(s) } : {}),
    );
    for await (const ev of events) {
      let item: StreamItem | null;
      try {
        item =
          ev.event === "frame"
            ? { kind: "frame", frame: frameOf(ev), id: ev.id, isRevision: false, isBackfill: false }
            : sideItem(ev);
      } catch (err) {
        skipUndecodable(err, options.onDecodeError);
        continue;
      }
      if (item !== null) yield item;
    }
  }

  /** Long-poll frames (`pollFrames` in a loop, continuing from each reply's cursor and state revision). */
  poll(options: PollOptions = {}): AsyncGenerator<StreamItem> {
    return this.deliver(
      (signal) => this.pollItems(options, signal),
      options.backfill ?? false,
      options.signal,
      options.precision,
    );
  }

  private pollItems(options: PollOptions, signal: AbortSignal): AsyncGenerator<StreamItem> {
    const observe = options.observe ?? this.defaults.observe;
    const cid = observe ? undefined : (options.cid ?? randomCid(this.http.random));
    const api = this.api;
    const http = this.http;
    const maxReconnects = options.maxReconnects ?? Number.POSITIVE_INFINITY;
    async function* items(): AsyncGenerator<StreamItem> {
      let cursor = options.cursor ?? 0;
      let rev = 0;
      let first = true;
      let worker = "";
      let failures = 0;
      for (;;) {
        let reply;
        try {
          reply = await api.pollFrames({
            cursor,
            rev,
            cid,
            layers: options.layers,
            limit: options.limit,
            wait: options.wait,
            precision: options.precision,
            signal,
          });
        } catch (err) {
          if (signal.aborted) throw abortReason(signal);
          if (first || !(err instanceof FactoryError) || !err.isRetryable() || ++failures > maxReconnects) throw err;
          await http.clock.sleep(err.retryMs ?? http.backoffDelay(failures - 1), signal);
          continue;
        }
        failures = 0;
        if (first || reply.state.revision !== rev) {
          yield { kind: "clock", state: reply.state, serverNow: reply.server_now };
        }
        const w = JSON.stringify(reply.worker);
        if (w !== worker) {
          worker = w;
          yield { kind: "worker", worker: reply.worker };
        }
        first = false;
        for (const frame of reply.frames)
          yield { kind: "frame", frame, id: null, isRevision: false, isBackfill: false };
        cursor = reply.cursor;
        rev = reply.state.revision;
      }
    }
    return items();
  }

  /**
   * Rules 4, 6 and 7 over the items `make` produces; the caller's signal is linked when the iteration starts. Late
   * layers are read back in the stream's `precision`.
   */
  private async *deliver(
    make: (signal: AbortSignal) => AsyncGenerator<StreamItem>,
    backfill: boolean,
    callerSignal: AbortSignal | undefined,
    precision: Precision | undefined,
  ): AsyncGenerator<StreamItem> {
    const link = linkSignals(callerSignal);
    const signal = link.signal;
    const items = make(signal);
    const dedupe = new Deduper();
    const source = backfill
      ? holdForBackfill<StreamItem>(
          items,
          (f, s) => completeFrame(this.api, this.http.clock, f, s, BACKFILL, precision),
          signal,
        )
      : items;
    try {
      for await (const item of source) {
        if (item.kind !== "frame") {
          if (item.kind === "clock") this.onState?.(item.state);
          yield item;
          continue;
        }
        const checked = dedupe.check(item);
        if (checked !== null) yield checked;
      }
    } finally {
      link.abort(new DOMException("stream closed", "AbortError"));
      link.dispose();
    }
  }

  /**
   * Raw `sip1` packets of `raw/stream` (SSE by default; NDJSON resumes with `after`), with the same resume rules. A
   * packet that repeats one of the same boot is dropped; after a `reset` (the unit restarted, its cursors start again)
   * the new boot's packets follow. NDJSON carries no `reset`: use SSE to be told of a restart.
   */
  rawPackets(options: RawPacketsOptions = {}): AsyncGenerator<RawItem> {
    return this.rawGen(options);
  }

  private async *rawGen(options: RawPacketsOptions): AsyncGenerator<RawItem> {
    const link = linkSignals(options.signal);
    const signal = link.signal;
    const observe = options.observe ?? this.defaults.observe;
    const format = options.format ?? "sse";
    const after = options.after;
    const cursors = new PacketCursors();
    const events = resumable(
      this.http,
      (lastEventId, s) =>
        this.api.rawStream({
          format,
          // SSE resumes by its event id; NDJSON (and SSE before an id) after the newest packet's cursor
          after: format === "sse" && lastEventId !== null ? undefined : cursors.newest >= 0 ? cursors.newest : after,
          lastEventId: format === "sse" ? lastEventId : null,
          observe,
          limit: options.limit,
          maxS: options.maxS,
          signal: s,
        }),
      options.lastEventId ?? null,
      this.resumeOptions(options, signal, { onConnect: () => cursors.connected() }),
    );
    try {
      for await (const ev of events) {
        let packet: Sip1Packet | null = null;
        let side: ReturnType<typeof sideItem> = null;
        try {
          if (ev.event === "frame") packet = packetOf(ev);
          else side = sideItem(ev);
        } catch (err) {
          skipUndecodable(err, options.onDecodeError);
          continue;
        }
        if (packet !== null) {
          if (!cursors.pass(ev.id, typeof packet.cursor === "number" ? packet.cursor : null)) continue;
          yield { kind: "packet", packet, id: ev.id };
          continue;
        }
        if (side === null) continue;
        if (side.kind === "clock") this.onState?.(side.state);
        if (side.kind === "reset") cursors.reset(side.boot);
        yield side;
      }
    } finally {
      link.abort(new DOMException("stream closed", "AbortError"));
      link.dispose();
    }
  }
}
