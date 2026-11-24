/**
 * `FakeFactory`: an in-process pDigger Factory server, as a `fetch` implementation (SDK-DESIGN.md section 12). It
 * answers the v2 API from recorded replies (`fixtures/api` layout) where given, else from a recording: catalog, session
 * state, frames, world, events, stone tracks, streams (SSE and NDJSON) with resume, the long-poll, controls validated
 * like the server, and fault injection. Deterministic: no network, no real clock unless asked for. With `live: true` it
 * also offers a live camera ({@link LIVE_CAMERA}) that connects, warms up and goes live on the fake's clock, as the
 * 20.20 unit's build live3 does (a play connects again and warms up on the camera's next frames).
 *
 * @module
 */
import { abortReason } from "../internal/abort.js";
import { base64ToBytes, bytesToText } from "../internal/bytes.js";
import type { Clock } from "../internal/clock.js";
import { platform } from "../internal/platform.js";
import { FactoryClient, type ClientOptions } from "../client.js";
import type { FetchLike } from "../transport.js";
import { classifyKeys, parseLine, readLines, type RecordingHeader, type RecordingSource } from "../recording.js";
import type {
  ApiErrorCode,
  DrawStone2D,
  DrawStone3D,
  Focus,
  Frame,
  Layer,
  Live,
  Overlay2D,
  Retained,
  Scene3D,
  SessionReply,
  Sip1Packet,
  State,
  StoneTrack,
  StoneView,
  VideoEntry,
  VideoList,
  WorkerStatus,
  WorldLayer,
} from "../models.js";
import { LAYERS, WORLD_EVENT_TYPES } from "../models.js";
import { ManualClock, settle } from "./clock.js";
import { TINY_PNG, TOPOLOGY } from "./data.js";

/** A canned reply. */
export interface FakeReply {
  status?: number;
  /** Text, bytes, or a value sent as JSON. */
  body?: string | Uint8Array | object | null;
  headers?: Record<string, string>;
  contentType?: string;
}

/** A request the fake received. */
export interface FakeRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string | null;
  /** The operation it matched, `unknown` when none. */
  operationId: string;
}

/** Layers the fake withholds from streams (listed in `missing`) but serves on `GET /frames/{g}`: late layers. */
export interface LateLayers {
  g: readonly number[] | ((frame: Frame) => boolean);
  layers: readonly Exclude<Layer, "raw">[];
}

/** Options of a {@link FakeFactory}. */
export interface FakeFactoryOptions {
  /**
   * A recording: a path (Node), an URL, bytes, or its lines (NDJSON strings or parsed objects). Played from its start
   * (`connect: "replay"`), its first clock line is the shared state at the start and each later one becomes it as
   * playback passes it, as the unit's state changed while it was recorded: when a stream (frames or raw, SSE or
   * NDJSON) or a long-poll serves what comes after the line. `GET /session` and a long-poll reply answer the state in
   * force; a long-poll reply ends before a clock line not yet taken, so that its state is that of all its frames. A
   * stream that plays the recording from its start again sends its clock lines again, but the state stays the newest
   * one passed. A control that changes the state, or an appended clock event, ends this: the session goes its own way
   * (a control at a revision above the recording's clock lines), and those lines are only sent. With
   * `connect: "newest"` or `live`, the state is the last clock line's.
   */
  recording?: RecordingSource | readonly (string | object)[];
  /** Frames to serve, instead of (or after) a recording's. */
  frames?: readonly Frame[];
  /** Recorded replies: a `fixtures/api` directory (`INDEX.json` + files) or a map of name to reply. */
  replies?: string | URL | Record<string, FakeReply>;
  /**
   * Offer a live camera, `cam-live` ({@link LIVE_CAMERA}), as the 20.20 unit offers its plant cameras: listed after the
   * recording, and shown by the session at the start, already live. The camera sends the recording's frames as one
   * session (`g` from 0, `i` the same, `t` the arrival in seconds since the session started; the raw packet's `g`, `i`,
   * `t` and `cursor` are the frame's). A select of it starts a session as the unit does: `connecting` for
   * {@link CONNECT_S}, then `warming` while the interpreter runs on the first `hold` (3) seconds of frames, which are
   * never released, then `live` ({@link LIVE_LAG_S} behind the camera), each phase a new `revision` and a `clock`
   * event. The phases fall due on the fake's `clock` while the session plays: every request (and `fake.state`) takes
   * those that are due, and nothing runs while it is paused (a pause keeps the phase). A play goes back to `connecting`
   * in its own reply and plans the phases again from then (warming changes only the phase, as on the unit: its `lag`
   * stays the one before); on a camera that was live, the next frames come after a break (`g` jumps by 5) and after the
   * frames already sent (the fake's camera sends its whole run when it goes live), and their warm-up is never released.
   * On the fake's own clock (no `clock` option), a stream or a long-poll that waits for the camera's next phase moves
   * that clock on to it (a long-poll: the phases within its `wait`, then it answers); on a clock you give it, a stream
   * or a long-poll sleeps on that clock until the next one: give the client the same clock
   * (`fake.client({ clock: fake.clock })`) so that `session.untilLive()` moves it. The newest {@link KEEP_PICTURES}
   * (64) released frames have a picture (`frames/{g}/image.jpg`, a small JPEG; an older frame's is
   * `404 not_retained`); the camera has no media (404), a seek whose video is the camera is refused (409
   * `not_seekable`, field `video`: a seek naming a recording is applied and leaves the camera), and so is a select of
   * it with any `time`, `null` too (400, field `time`).
   */
  live?: boolean;
  /** The boot id in stream event ids (default `fakeboot01`). */
  boot?: string;
  /** At the end of the data a stream stays open until closed (`hold`, default) or ends (`close`). */
  endOfData?: "hold" | "close";
  /**
   * Where a stream (or a long-poll with `cursor` 0) without `after` or `Last-Event-ID` starts. `replay` (default): at
   * the start of the current session's data, with its clock line first, so a recording plays through from its start.
   * `newest`: as the 20.20 unit does, at the newest frame (a long-poll: the newest `limit` frames) and with no `clock`
   * event (the unit sends one only when the state changes: read `GET /session`); frames appended later follow.
   */
  connect?: "replay" | "newest";
  /**
   * What a stream does when it has sent `limit` frames or reached `max_s`: `close` (default) ends it at once; `hold`
   * sends nothing more and keeps it open until the client closes it, as the 20.20 unit does for about 10 s.
   */
  atLimit?: "close" | "hold";
  /** Layers withheld from streams and served late by `GET /frames/{g}` (to exercise backfill). */
  late?: LateLayers;
  /** Pace streams at media time (rate 1.0) on `clock`. Default false: as fast as read. */
  realtime?: boolean;
  /**
   * The fake's clock: server times, long-poll waits, pacing, a camera's phases. Default: a `ManualClock` of its own,
   * standing still at the time of the clock line its state starts in (`server_now`: the recording's first clock
   * line's, its last's with `connect: "newest"` or `live`; else the recorded `getSession` reply's, else 1794950000),
   * moved only by `fake.advance(seconds)` and by a stream or a long-poll that waits for a camera's next phase
   * (playback passing a later clock line does not move it).
   */
  clock?: Clock;
  /** Called before every reply (a delay hook: return a promise to hold the reply). */
  delay?: (request: FakeRequest) => Promise<void> | void;
}

/** A timeline entry. A side entry with `pending` is a later clock line of the recording, not yet the shared state. */
type Entry =
  | { kind: "frame"; cursor: number; frame: Frame; segment: number }
  | { kind: "side"; sse: string; data: unknown; segment: number; pending?: boolean };

interface Fault {
  remaining: number;
  reply: FakeReply | "network";
}

const JSON_TYPE = "application/json; charset=utf-8";
const BUILD = "fake-sdk-ts";
/** The id of the fake's live camera (`live: true`). */
export const LIVE_CAMERA = "cam-live";
/** Seconds the fake's camera takes, after a select, to send its first frame (the session is `connecting` meanwhile). */
export const CONNECT_S = 0.5;
/** Seconds the fake's live picture is behind its camera (the interpreter's time): `state.live.lag`. */
export const LIVE_LAG_S = 0.25;
/**
 * How many camera pictures the fake keeps, as the unit's worker does: those of the newest released frames of the
 * camera session; an older frame that is still retained has none (`404 not_retained`).
 */
export const KEEP_PICTURES = 64;
/** On a camera, `hold_until` stays this far ahead of the select until the session goes live (as on the unit). */
const LIVE_HOLD_S = 3600;
/** Grid frame numbers a camera session skips at a break, as the unit's worker does: after a pause, `g` jumps by 5. */
const LIVE_GAP = 4;
/** Where the fake's own clock starts when nothing recorded gives a time (epoch seconds). */
const FAKE_EPOCH = 1794950000;
/** A 16 x 9 grey JPEG: the picture of every frame of the fake's camera (with the frame in a comment segment). */
const JPEG = base64ToBytes(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9" +
    "lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAJABAD" +
    "ASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEA" +
    "AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCYCD//2Q==",
);

/**
 * The catalog entry of the fake's live camera, sized like `like` (the recording's source, else the first catalog
 * entry) and shaped as a plant camera's: its grid's fps is `like`'s over its grid step (5.0 without an fps).
 */
function cameraEntry(like: VideoEntry | undefined): VideoEntry {
  const gridFps = like !== undefined && like.fps > 0 ? like.fps / Math.max(like.grid_step || 0, 1) : 5;
  return {
    id: LIVE_CAMERA,
    title: "Live camera",
    subtitle: "The recording, replayed as a live camera",
    kind: "camera",
    live: true,
    seekable: false,
    duration: null,
    frames: null,
    default_start: null,
    fps: Math.round(gridFps * 10) / 10,
    grid_step: 1,
    hold: 3,
    proxy: "",
    proxy_wh: like?.proxy_wh ?? [960, 540],
    native_wh: like?.native_wh ?? [1920, 1080],
    held_out: [],
    station: "FakeFactory",
  };
}

/** The fake camera's JPEG of frame `g`: {@link JPEG} with `FakeFactory <video> g <g>` in a comment segment. */
function fakePicture(video: string, g: number): Uint8Array {
  const note = new TextEncoder().encode(`FakeFactory ${video} g ${g}`);
  const out = new Uint8Array(JPEG.length + 4 + note.length);
  out.set(JPEG.subarray(0, 2), 0);
  out.set([0xff, 0xfe, (note.length + 2) >> 8, (note.length + 2) & 0xff], 2);
  out.set(note, 6);
  out.set(JPEG.subarray(2), 6 + note.length);
  return out;
}

/**
 * Recorded frame `f` as camera `video`'s frame `g` at session time `t` of session `session`, numbered as a camera's
 * frames are: `i` = `g`, the world's and the raw packet's session, video, `g` (`i`) and `t` the frame's, the
 * overlay's `prev_g` moved with `g`. It gets its cursor when it is released.
 */
function cameraFrame(f: Frame, session: number, video: string, g: number, t: number): Frame {
  const c = clone(f);
  Object.assign(c, { session, video, g, i: g, t, cursor: 0 });
  if (c.world) Object.assign(c.world, { session, video, g, t });
  if (c.raw) Object.assign(c.raw, { session, video, g, i: g, t });
  if (typeof c.overlay?.prev_g === "number") c.overlay.prev_g += g - f.g;
  return c;
}

/** The raw packet of a frame as the unit serves it: its cursor, session, video, `g`, `i` and `t` the frame's. */
function packetOf(raw: Sip1Packet, f: Frame, cursor: number): Sip1Packet {
  return { ...raw, cursor, session: f.session, video: f.video, g: f.g, i: f.i, t: f.t };
}

/** A camera session's next state, due at a wall time (epoch seconds) of the fake's clock. */
interface Phase {
  at: number;
  state: State;
}

/** True when `s` shows a live camera (it has `live`). */
function isCameraState(s: State): s is State & { live: Live } {
  return s.live !== undefined && s.live !== null;
}

/** The unit's message for a time outside a source (a range, or no end without a duration). */
function timeRange(e: VideoEntry): string {
  return typeof e.duration === "number"
    ? `time must be within 0..${e.duration.toFixed(3)} s`
    : "time must be at least 0 s";
}

/** A JSON value other than a string as the unit's messages show it (Python's repr): `None`, `True`, `False`, JSON. */
function pyRepr(v: unknown): string {
  return v === null ? "None" : v === true ? "True" : v === false ? "False" : JSON.stringify(v);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly field?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function etagOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `"${h.toString(16)}"`;
}

/** An in-process fake of the pDigger Factory API. Use `fake.fetch` as a client's fetch, or `fake.client()`. */
export class FakeFactory {
  /** Every request received, in order. */
  readonly requests: FakeRequest[] = [];
  /** The fetch implementation answering the API. */
  readonly fetch: FetchLike;
  /** The recording's header, when it had one. */
  readonly header: RecordingHeader | null;
  private bootId: string;
  private readonly timeline: Entry[] = [];
  private segmentStart = 0;
  private segment = 0;
  private nextCursor = 1;
  private st: State;
  private readonly catalog: VideoList;
  private readonly recordedFrames: Frame[];
  private readonly replies: Record<string, FakeReply>;
  private readonly faults = new Map<string, Fault[]>();
  private readonly preludes: { sse: string; data: unknown }[][] = [];
  private dropAfterEvents: number | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly options: FakeFactoryOptions;
  /**
   * The clock of the fake (server time, long-poll waits, pacing, a camera's phases): the one you passed, else a
   * `ManualClock` of its own that stands still unless {@link FakeFactory.advance}, or a stream or a long-poll that
   * waits for a camera's next phase, moves it.
   */
  readonly clock: Clock;
  /** The fake's own clock, when it was given none: the one a stream or long-poll may move on to a camera's phase. */
  private readonly ownClock: ManualClock | null;
  /** The worker's status as recorded or appended; without one, the fake's own (running, on the current session). */
  private worker: WorkerStatus | null;
  /** Stream connections open now that count as viewers (not `observe=1`), and all of them. */
  private openStreams = 0;
  private allStreams = 0;
  private closed = false;
  /** Restarts so far ({@link FakeFactory.injectReset}): a stream of an earlier one breaks. */
  private restarts = 0;
  private pendingReset = false;
  /**
   * The playback rate of a recording selected or sought: the recording's last clock line's (the unit's newest; else
   * the start state's), 0.8 when the fake starts on a camera.
   */
  private readonly recRate: number;
  /** The phases still to come of the camera session the state shows, in order. */
  private phases: Phase[] = [];
  /** The frames of that camera session's run, released when it goes live. */
  private heldFrames: Frame[] = [];
  /** The `g` and the session time after the camera's newest frame: the next run comes after them. */
  private camG = 0;
  private camT = 0;

  /** A fake from loaded data; see {@link FakeFactory.create} to load files. */
  constructor(lines: readonly unknown[] = [], options: Omit<FakeFactoryOptions, "recording"> = {}) {
    this.options = options;
    this.bootId = options.boot ?? "fakeboot01";
    this.replies = isObject(options.replies) && !(options.replies instanceof URL) ? options.replies : {};
    let header: RecordingHeader | null = null;
    const frames: Frame[] = [];
    const order: ({ frame: Frame } | { sse: string; data: unknown })[] = [];
    let firstClock: unknown = undefined;
    let lastClock: unknown = undefined;
    let lastWorker: unknown = undefined;
    for (const raw of lines) {
      const v = typeof raw === "string" ? parseLine(raw) : raw;
      const c = classifyKeys(v, header !== null); // as recorded: the clients check what decodes
      if (c.kind === "header") header = c.header;
      else if (c.kind === "frame") {
        frames.push(c.frame);
        order.push({ frame: c.frame });
      } else if (c.kind === "side") {
        order.push({ sse: c.side.sse, data: c.side.data });
        if (c.side.sse === "clock" && isObject(c.side.data)) {
          firstClock ??= c.side.data;
          lastClock = c.side.data;
        }
        if (c.side.sse === "worker" && isObject(c.side.data)) lastWorker = c.side.data;
      }
    }
    for (const f of options.frames ?? []) {
      frames.push(f);
      order.push({ frame: f });
    }
    this.header = header;
    this.recordedFrames = frames;
    // played from its start, the recording is in its first clock line's state and takes each later one as playback
    // passes it; at its newest frame (`connect: "newest"`) or before a camera, in its last one's, as before
    const fromStart = !options.live && options.connect !== "newest" && isObject(firstClock);
    const startClock = fromStart ? firstClock : lastClock;
    const own = options.clock === undefined ? new ManualClock(this.startTime(startClock) * 1000) : null;
    this.ownClock = own;
    this.clock = own ?? (options.clock as Clock);
    this.catalog = this.makeCatalog();
    this.worker = lastWorker ? (clone(lastWorker) as WorkerStatus) : null;
    this.st = this.initialState(startClock, fromStart ? frames[0] : frames[frames.length - 1]);
    if (options.live) {
      for (const f of frames) this.takeCursor(f); // numbered as if sent before the camera's, which follow them
      this.offerCamera(frames[0]?.session ?? 1);
    } else {
      for (const e of order) {
        if ("frame" in e) this.pushFrame(e.frame);
        else {
          const pending = fromStart && e.sse === "clock" && isObject(e.data) && e.data !== firstClock;
          this.timeline.push({ kind: "side", sse: e.sse, data: e.data, segment: 0, pending });
        }
      }
    }
    // a recording selected or sought plays at its last clock line's rate (the unit's newest), after a camera at 0.8
    const last = isObject(lastClock) ? (lastClock as unknown as State) : this.st;
    this.recRate = options.live || isCameraState(last) ? 0.8 : last.rate;
    this.fetch = (input, init) => this.handle(input, init);
  }

  /** A fake from files: a recording path or URL and a replies directory are read now. */
  static async create(options: FakeFactoryOptions = {}): Promise<FakeFactory> {
    let lines: unknown[] = [];
    const rec = options.recording;
    if (Array.isArray(rec)) lines = [...(rec as readonly unknown[])];
    else if (rec !== undefined) {
      for await (const l of readLines(rec as RecordingSource)) lines.push(l);
    }
    let replies = options.replies;
    if (typeof replies === "string" || replies instanceof URL) replies = await FakeFactory.loadReplies(replies);
    return new FakeFactory(lines, { ...options, replies });
  }

  /** A fake of a fixtures directory: `<dir>/recordings/<name>.ndjson.gz` and the replies of `<dir>/api`. */
  static fromFixtures(dir: string, recording: string, options: FakeFactoryOptions = {}): Promise<FakeFactory> {
    const base = dir.endsWith("/") ? dir : `${dir}/`;
    return FakeFactory.create({
      ...options,
      recording: `${base}recordings/${recording}.ndjson.gz`,
      replies: options.replies ?? `${base}api`,
    });
  }

  /** Reads a `fixtures/api` directory: `INDEX.json` names each reply's file, status and headers. */
  static async loadReplies(dir: string | URL): Promise<Record<string, FakeReply>> {
    const fs = await platform.importFs();
    const base = String(dir).endsWith("/") ? String(dir) : `${String(dir)}/`;
    const read = (name: string): Promise<Uint8Array> =>
      fs.promises.readFile(base.startsWith("file:") ? new URL(name, base) : `${base}${name}`);
    const index = JSON.parse(bytesToText(await read("INDEX.json"))) as Record<
      string,
      { file: string; status: number; content_type: string | null; headers?: Record<string, string> }
    >;
    const out: Record<string, FakeReply> = {};
    for (const [name, e] of Object.entries(index)) {
      const headers = { ...(e.headers ?? {}) };
      delete headers["Content-Length"];
      out[name] = { status: e.status, body: await read(e.file), headers, contentType: e.content_type ?? undefined };
    }
    return out;
  }

  /** A client of this fake (base URL `http://fake.factory`). */
  client(options: ClientOptions = {}): FactoryClient {
    return new FactoryClient("http://fake.factory", { ...options, fetch: this.fetch });
  }

  /** The fake's shared state now (a camera session first takes the phases whose time has come). */
  get state(): State {
    this.takeDuePhases();
    return { ...this.st, media_time: this.mediaTimeOf(this.st) };
  }

  /** The fake's wall clock now, epoch seconds: its clock's time. */
  get now(): number {
    return this.wall();
  }

  /**
   * The phase of the fake's camera session (`connecting`, `warming` or `live`; `""` on a recording), after the phases
   * whose time has come.
   */
  get livePhase(): Live["phase"] | "" {
    this.takeDuePhases();
    return this.st.live?.phase ?? "";
  }

  /**
   * Moves the fake's clock on by `seconds` (its own, or a `ManualClock` you gave it), waking what sleeps on it: the
   * session's playhead moves while it plays, and a camera session takes the phases whose time has come. A fake on
   * another clock follows that clock: move it instead.
   */
  async advance(seconds: number): Promise<void> {
    if (!(this.clock instanceof ManualClock)) {
      throw new TypeError("advance() moves a ManualClock: this fake follows the clock it was given");
    }
    await this.clock.advance(seconds * 1000);
    this.takeDuePhases();
  }

  /** Stream connections open now. */
  get streams(): number {
    return this.openStreams;
  }

  /** The boot id in stream event ids (`<boot>-<cursor>`), `getApiRoot` and `getStatus`; a restart changes it. */
  get boot(): string {
    return this.bootId;
  }

  // ---- fault injection -----------------------------------------------------------------------------------------------

  /**
   * The next `count` requests of an operation (`"*"` for any) get `reply`: a canned reply, the name of a recorded reply
   * (e.g. `getFrame-404`), or `"network"` (fetch rejects, as for a dropped connection).
   */
  failNext(operationId: string, count: number, reply: FakeReply | string): void {
    const r: FakeReply | "network" =
      reply === "network" ? "network" : typeof reply === "string" ? this.recorded(reply) : reply;
    const list = this.faults.get(operationId) ?? [];
    list.push({ remaining: count, reply: r });
    this.faults.set(operationId, list);
  }

  /** The next stream connection is dropped (a network error) after `events` events. */
  dropAfter(events: number): void {
    this.dropAfterEvents = events;
  }

  /** The next stream connection starts with a `gap` event of `count` items. */
  injectGap(count: number): void {
    this.preludes.push([{ sse: "gap", data: { gap: count } }]);
  }

  /**
   * The unit restarts as `boot`: its cursors start again from 1 (every frame is numbered anew, so the new boot's
   * cursors are below the old ones), the stream connections open now break (as a dropped connection), and the next
   * stream connection starts with a `reset` event naming the new boot and its newest cursor (a resume with an id of the
   * old boot gets that one reset, not two). NDJSON carries no reset: an NDJSON connection skips it, and one that asks
   * for `after` a cursor of the old boot waits until the new cursors pass it.
   */
  injectReset(boot = "otherboot1"): void {
    this.bootId = boot;
    let cursor = 0;
    for (let i = 0; i < this.timeline.length; i++) {
      const e = this.timeline[i] as Entry;
      if (e.kind !== "frame") continue;
      cursor++;
      this.timeline[i] = { ...e, cursor, frame: { ...e.frame, cursor } };
    }
    this.nextCursor = cursor + 1;
    this.restarts++;
    this.pendingReset = true;
    this.wake();
  }

  /** Appends frames to the current session (as a live server releases them): waiting streams wake up. */
  appendFrames(frames: readonly Frame[]): void {
    for (const f of frames) this.pushFrame(f);
    this.wake();
  }

  /**
   * Appends a side event (`clock`, `worker`, `gap`, `reset`) to the timeline, as if another viewer or the worker changed
   * something: a `clock` also becomes the shared state (one that leaves the camera session drops its phases still to
   * come; the recording's later clock lines are then only sent), a `worker` the worker status.
   */
  appendSide(sse: string, data: unknown): void {
    if (sse === "clock" && isObject(data)) {
      this.ownWay();
      this.takeState(data);
    }
    if (sse === "worker" && isObject(data)) this.worker = clone(data) as unknown as WorkerStatus;
    this.timeline.push({ kind: "side", sse, data, segment: this.segment });
    this.wake();
  }

  /** Ends every held stream. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  // ---- internals: data -----------------------------------------------------------------------------------------------

  private recorded(name: string): FakeReply {
    const r = this.replies[name];
    if (r === undefined) throw new Error(`no recorded reply ${name}`);
    return r;
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }

  private waitForMore(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener("abort", done);
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** The cursor a frame gets next: its own when it is above those given so far, else the next one. */
  private takeCursor(frame: Frame): number {
    const cursor = Math.max(typeof frame.cursor === "number" ? frame.cursor : 0, this.nextCursor);
    this.nextCursor = cursor + 1;
    return cursor;
  }

  private pushFrame(frame: Frame): void {
    const cursor = this.takeCursor(frame);
    const f = frame.cursor === cursor ? frame : { ...frame, cursor };
    this.timeline.push({ kind: "frame", cursor, frame: f, segment: this.segment });
  }

  /** A clock event's state becomes the shared state (one that leaves the camera session drops its phases to come). */
  private takeState(data: Record<string, unknown>): void {
    const { server_now: _now, ...state } = data;
    const previous = this.st;
    this.st = clone(state) as unknown as State;
    if (!isCameraState(this.st) || this.st.session !== previous.session) {
      this.phases = [];
      this.heldFrames = [];
    }
  }

  /** Playback passes entry `e`: a recording's clock line not yet taken becomes the shared state, as on the unit. */
  private pass(e: Entry): void {
    if (e.kind !== "side" || e.pending !== true) return;
    e.pending = false;
    this.takeState(e.data as Record<string, unknown>);
  }

  /** Playback has come to timeline index `end`: the current program's entries before it have been passed. */
  private passTo(end: number): void {
    for (let i = this.segmentStart; i < end; i++) this.pass(this.timeline[i] as Entry);
  }

  /** The session goes its own way (a control, an appended clock event): the recording's clock lines are only sent. */
  private ownWay(): void {
    for (const e of this.timeline) if (e.kind === "side") e.pending = false;
  }

  /**
   * The newest revision the session has had, counting the recording's clock lines not yet taken: a control takes the
   * next one, so that those lines, which streams still send, stay older than its state.
   */
  private newestRevision(): number {
    let r = this.st.revision;
    for (const e of this.timeline) {
      if (e.kind === "side" && e.pending === true) r = Math.max(r, (e.data as State).revision);
    }
    return r;
  }

  /**
   * The catalog: a recorded `listVideos` (its entries, in its order) with the recording's source added when it does not
   * list it (the header's, else one made from the first frame's video), then the camera with `live`. The default is
   * the recording (without one, the recorded default, else the first entry, else the camera).
   */
  private makeCatalog(): VideoList {
    const recorded = this.replies.listVideos;
    const base: VideoList = recorded
      ? this.jsonOf<VideoList>(recorded)
      : { schema: "stone-interpreter-catalog-v1", title: "Stone-work interpreter", videos: [] };
    const src = this.header?.source ?? this.sourceOfFrames();
    if (src && !base.videos.some((v) => v.id === src.id)) base.videos.push(clone(src));
    base.default_video = src?.id ?? base.default_video ?? base.videos[0]?.id;
    if (this.options.live && !base.videos.some((v) => v.id === LIVE_CAMERA)) {
      // after the recordings, as the unit lists its cameras; the catalog's default stays the recording
      base.videos.push(cameraEntry((src && base.videos.find((v) => v.id === src.id)) ?? base.videos[0]));
      base.default_video ??= LIVE_CAMERA;
    }
    return base;
  }

  /** A recording without a header source: an entry for its first frame's video, as the unit's recordings are shaped. */
  private sourceOfFrames(): VideoEntry | undefined {
    const v = this.recordedFrames[0]?.video;
    if (!v) return undefined;
    return {
      id: v,
      title: v,
      duration: null,
      fps: 10,
      frames: null,
      grid_step: 2,
      default_start: 0,
      hold: 2.2,
      proxy: `/api/v2/videos/${v}/media`,
      proxy_wh: [960, 540],
      native_wh: [1920, 1080],
    };
  }

  /** Where the fake's own clock starts (epoch seconds): the start clock line's time, else the recorded session's. */
  private startTime(startClock: unknown): number {
    const recorded = this.replies.getSession ? this.jsonOf<SessionReply>(this.replies.getSession) : null;
    const at = isObject(startClock) ? startClock.server_now : recorded?.server_now;
    return typeof at === "number" ? at : FAKE_EPOCH;
  }

  private initialState(clockData: unknown, frame: Frame | undefined): State {
    const recorded = this.replies.getSession ? this.jsonOf<SessionReply>(this.replies.getSession) : null;
    const now = this.wall();
    const base: State = isObject(clockData)
      ? (clone(clockData) as unknown as State)
      : recorded
        ? clone(recorded.state)
        : {
            session: 1,
            revision: 1,
            video: this.header?.video ?? "fake",
            playing: true,
            rate: 0.8,
            anchor_media: 0,
            anchor_wall: now,
            hold_until: now,
            duration: this.header?.source?.duration ?? null,
            changed_by: "start",
            focus: null,
            media_time: 0,
          };
    delete (base as unknown as Record<string, unknown>).server_now;
    // on the session and video of the frame given: the first played from the start, else the last, as before
    if (frame) {
      base.session = frame.session;
      base.video = frame.video;
    }
    base.focus = base.focus ?? null;
    return base;
  }

  /** The fake's wall clock now, epoch seconds. */
  private wall(): number {
    return this.clock.now() / 1000;
  }

  /**
   * The media time of state `s` at wall time `now`, as the unit's clock gives it: the playhead holds at its anchor
   * until `hold_until` (after a select or seek; on a camera an hour ahead until it is live), then runs at the rate
   * while the session plays, up to the duration (a camera has none).
   */
  private mediaTimeOf(s: State, now = this.wall()): number {
    const t = s.playing
      ? s.anchor_media + Math.max(0, now - Math.max(s.anchor_wall, s.hold_until)) * s.rate
      : s.anchor_media;
    return s.duration === null ? t : Math.min(t, s.duration);
  }

  // ---- internals: the live camera ------------------------------------------------------------------------------------

  /** True when `id` is a live camera: one the catalog lists as live, or the design's old id `live`. */
  private isLiveVideo(id: string): boolean {
    return id === "live" || this.catalog.videos.find((v) => v.id === id)?.live === true;
  }

  /** Seconds of camera frames the interpreter warms up on: the camera's `hold` (3 when it has none). */
  private warmup(id: string): number {
    return this.catalog.videos.find((v) => v.id === id)?.hold || 3;
  }

  /**
   * A run of camera `id`'s frames in session `session`: the recording's frames, its sessions end to end, as the camera
   * sends them once connected at session time `t0` (seconds since the session started), numbered from `g0` (`i` the
   * same) and arriving from {@link CONNECT_S} after `t0` at the recording's pace. Returns the frames released after the
   * run's warm-up (those of its first `hold` seconds are numbered but never released), the `t` the run goes live at
   * (its first released frame's; the warm-up's end when there is none), and the `g` and `t` after its last frame.
   */
  private cameraRun(
    id: string,
    session: number,
    g0 = 0,
    t0 = 0,
  ): { frames: Frame[]; liveT: number; nextG: number; nextT: number } {
    const warmEnd = t0 + CONNECT_S + this.warmup(id);
    const out: Frame[] = [];
    let segment: number | null = null;
    let baseG = 0;
    let baseT = 0;
    let recG0 = 0;
    let recT0 = 0;
    let nextG = g0;
    let nextT = t0 + CONNECT_S;
    for (const f of this.recordedFrames) {
      if (f.session !== segment) {
        segment = f.session;
        baseG = nextG;
        baseT = nextT;
        recG0 = f.g;
        recT0 = f.t;
      }
      const g = baseG + f.g - recG0;
      const t = Math.round((baseT + f.t - recT0) * 1e6) / 1e6;
      nextG = Math.max(nextG, g + 1);
      nextT = Math.max(nextT, t + 0.2);
      if (t >= warmEnd - 1e-9) out.push(cameraFrame(f, session, id, g, t));
    }
    return { frames: out, liveT: out[0]?.t ?? warmEnd, nextG, nextT };
  }

  /**
   * The state of a new session of camera `id` that starts at wall time `since`: `connecting`, from media time 0 at
   * rate 1.0, held an hour ahead until it goes live.
   */
  private connecting(
    id: string,
    session: number,
    revision: number,
    playing: boolean,
    changedBy: State["changed_by"],
    since: number,
  ): State & { live: Live } {
    return {
      session,
      revision,
      video: id,
      playing,
      rate: 1,
      anchor_media: 0,
      anchor_wall: since,
      hold_until: since + LIVE_HOLD_S,
      duration: null,
      changed_by: changedBy,
      focus: null,
      media_time: 0,
      live: { phase: "connecting", warmup: this.warmup(id), since, lag: 0 },
    };
  }

  /**
   * The phases a camera session takes once it connects at wall time `at`, from `base` (its `connecting` state):
   * `warming` {@link CONNECT_S} later, while the interpreter runs on the run's first `hold` seconds, then `live` when
   * the frame of time `liveT` is released, {@link LIVE_LAG_S} behind it (the playhead starts there). Each bumps the
   * revision, as the unit's clock does. Warming changes only the phase, as the unit's: its `lag` is `base`'s (0 after a
   * select, the live lag after a play of a camera that was live).
   */
  private cameraPhases(base: State & { live: Live }, at: number, liveT: number): Phase[] {
    const warming: State = { ...base, revision: base.revision + 1, live: { ...base.live, phase: "warming" } };
    const wentLive = base.live.since + liveT + LIVE_LAG_S;
    const onAir: State = {
      ...base,
      revision: base.revision + 2,
      anchor_media: liveT,
      anchor_wall: wentLive,
      hold_until: wentLive,
      live: { ...base.live, phase: "live", lag: LIVE_LAG_S },
    };
    return [
      { at: at + CONNECT_S, state: warming },
      { at: wentLive, state: onAir },
    ];
  }

  /**
   * Shows the camera from the start, as if it had been selected just long enough ago to be live now: the current
   * program is its session (revision 3, `changed_by` `start`), with its run's frames after the warm-up released.
   */
  private offerCamera(session: number): void {
    const run = this.cameraRun(LIVE_CAMERA, session);
    const since = this.wall() - run.liveT - LIVE_LAG_S;
    const start = this.connecting(LIVE_CAMERA, session, 1, true, "start", since);
    this.st = (this.cameraPhases(start, since, run.liveT)[1] as Phase).state;
    this.camG = run.nextG;
    this.camT = run.nextT;
    this.startSegment([], true);
    this.release(run.frames);
  }

  /** Plans the phases of the camera session the state has just started (`connecting`), and holds its first run. */
  private startCamera(): void {
    const st = this.st as State & { live: Live };
    this.planRun(st, st.anchor_wall, 0, 0);
  }

  /**
   * Plans the camera session's next run after a play (the state is `connecting` again): the camera connects now and
   * warms up again on its next frames. Once frames were released, the run is numbered after a break of
   * {@link LIVE_GAP} frames (`g` jumps, as on the unit) and arrives after the frames already sent: the fake's camera
   * has sent its whole run by the time it goes live.
   */
  private restartCamera(now: number): void {
    const st = this.st as State & { live: Live };
    const sent = this.segmentFrames().length > 0;
    const t0 = now - st.live.since;
    this.planRun(st, now, sent ? this.camG + LIVE_GAP : 0, sent ? Math.max(t0, this.camT) : t0);
  }

  /** Plans the phases of a run of the camera session `st` that connects at wall time `at`, and holds its frames. */
  private planRun(st: State & { live: Live }, at: number, g0: number, t0: number): void {
    const run = this.cameraRun(st.video, st.session, g0, t0);
    this.phases = this.cameraPhases(st, at, run.liveT);
    this.heldFrames = run.frames;
    this.camG = run.nextG;
    this.camT = run.nextT;
  }

  /** A playing camera session takes the phases whose wall time has come by `now` (nothing runs while it is paused). */
  private takeDuePhases(now = this.wall()): void {
    while (this.st.playing && this.phases[0] !== undefined && this.phases[0].at <= now) this.takePhase();
  }

  /**
   * Whether a stream or a long-poll moves the fake's own clock on to the camera's next phase: the session plays and the
   * phase comes by wall time `until`. Never on a clock you gave the fake: a stream or long-poll sleeps on that one.
   */
  private canSkip(until: number): boolean {
    const p = this.phases[0];
    return this.ownClock !== null && this.st.playing && p !== undefined && p.at <= until;
  }

  /** Moves the fake's own clock on to the camera's next phase and takes it (called only when {@link canSkip}). */
  private async skipToPhase(): Promise<void> {
    const own = this.ownClock as ManualClock;
    const at = (this.phases[0] as Phase).at;
    const ms = at * 1000 - own.now();
    if (ms > 0) await own.advance(ms);
    this.takeDuePhases(Math.max(this.wall(), at));
  }

  /**
   * Takes the camera's next phase, after any control made since it was planned (a higher revision; the playing state,
   * the focus and who changed it kept), as a `clock` event at the phase's own time; going live releases the run.
   */
  private takePhase(): void {
    const p = this.phases.shift() as Phase; // called only with a phase to come
    const cur = this.st;
    const state: State = {
      ...p.state,
      revision: Math.max(p.state.revision, cur.revision + 1),
      playing: cur.playing,
      focus: cur.focus,
      changed_by: cur.changed_by,
    };
    state.media_time = this.mediaTimeOf(state, p.at);
    this.st = state;
    this.timeline.push({ kind: "side", sse: "clock", data: { ...state, server_now: p.at }, segment: this.segment });
    if (state.live?.phase === "live") {
      const frames = this.heldFrames;
      this.heldFrames = [];
      this.release(frames);
    }
    this.wake();
  }

  /** Releases camera frames with the next cursors (their raw packets' too), in order. */
  private release(frames: readonly Frame[]): void {
    for (const f of frames) {
      const cursor = this.nextCursor++;
      const c: Frame = { ...f, cursor };
      if (c.raw) c.raw = { ...c.raw, cursor };
      this.timeline.push({ kind: "frame", cursor, frame: c, segment: this.segment });
    }
  }

  /**
   * Waits, on the clock the fake was given, until the camera's next phase is due and takes it; returns early when
   * something else happens first (a control, appended data, a close) or the signal aborts. A paused session waits for
   * the play.
   */
  private async untilPhase(signal: AbortSignal): Promise<void> {
    const next = this.phases[0] as Phase; // called only with a phase to come
    const ctl = new AbortController();
    const stop = (): void => ctl.abort();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const wait = next.at * 1000 - this.clock.now();
      if (!this.st.playing) await this.waitForMore(ctl.signal);
      else if (wait > 0) {
        await Promise.race([this.waitForMore(ctl.signal), this.clock.sleep(wait, ctl.signal).catch(() => undefined)]);
      }
    } finally {
      ctl.abort();
      signal.removeEventListener("abort", stop);
    }
    if (!signal.aborted) this.takeDuePhases();
  }

  /** Starts a new segment (a new session, the current program) with these frames and a clock event. */
  private startSegment(frames: readonly Frame[], initial = false): void {
    if (!initial) this.segment++;
    this.segmentStart = this.timeline.length;
    const now = this.wall();
    this.timeline.push({
      kind: "side",
      sse: "clock",
      data: { ...this.st, media_time: this.mediaTimeOf(this.st, now), server_now: now },
      segment: this.segment,
    });
    for (const f of frames) this.pushFrame(f);
    this.wake();
  }

  private segmentFrames(): Extract<Entry, { kind: "frame" }>[] {
    const out: Extract<Entry, { kind: "frame" }>[] = [];
    for (let i = this.segmentStart; i < this.timeline.length; i++) {
      const e = this.timeline[i] as Entry;
      if (e.kind === "frame" && e.frame.session === this.st.session) out.push(e);
    }
    return out;
  }

  /** The newest entry per g of the current session (revisions replace earlier ones). */
  private newestByG(): Map<number, Frame> {
    const m = new Map<number, Frame>();
    for (const e of this.segmentFrames()) {
      const prev = m.get(e.frame.g);
      if (!prev || (e.frame.world?.rev ?? 0) >= (prev.world?.rev ?? 0)) m.set(e.frame.g, e.frame);
    }
    return m;
  }

  private retained(): Retained {
    const fs = [...this.newestByG().values()].sort((a, b) => a.g - b.g);
    const a = fs[0];
    const b = fs[fs.length - 1];
    return {
      session: this.st.session,
      g0: a?.g ?? null,
      g1: b?.g ?? null,
      t0: a?.t ?? null,
      t1: b?.t ?? null,
      n: fs.length,
    };
  }

  private isLate(frame: Frame): boolean {
    const late = this.options.late;
    if (!late) return false;
    return typeof late.g === "function" ? late.g(frame) : late.g.includes(frame.g);
  }

  /** A frame with only the requested layers; streams also withhold late layers. */
  private view(frame: Frame, layers: readonly Layer[], stream: boolean): Frame {
    const out: Record<string, unknown> = {};
    const f = frame as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(f))
      if (!(LAYERS as readonly string[]).includes(k) && k !== "missing") out[k] = v;
    const missing = new Set((frame.missing ?? []).filter((l) => layers.includes(l)));
    for (const l of layers) {
      if (f[l] === undefined) continue;
      if (stream && l !== "raw" && this.isLate(frame) && this.options.late?.layers.includes(l)) {
        missing.add(l);
        continue;
      }
      out[l] = f[l];
    }
    if (missing.size > 0) out.missing = [...missing];
    return out as unknown as Frame;
  }

  // ---- internals: HTTP -----------------------------------------------------------------------------------------------

  /** The JSON value of a recorded reply (bytes, text or a value). */
  private jsonOf<T>(r: FakeReply): T {
    const b = r.body;
    if (b instanceof Uint8Array) return JSON.parse(bytesToText(b)) as T;
    if (typeof b === "string") return JSON.parse(b) as T;
    return clone(b) as T;
  }

  private reply(r: FakeReply, method = "GET"): Response {
    const headers = new Headers({ "X-Interp-Build": BUILD, ...(r.headers ?? {}) });
    let body: BodyInit | null = null;
    const status = r.status ?? 200;
    if (r.body instanceof Uint8Array) {
      body = r.body as Uint8Array<ArrayBuffer>;
      headers.set("Content-Type", r.contentType ?? "application/octet-stream");
    } else if (typeof r.body === "string") {
      body = r.body;
      headers.set("Content-Type", r.contentType ?? "text/plain; charset=utf-8");
    } else if (r.body !== undefined && r.body !== null) {
      body = JSON.stringify(r.body);
      headers.set("Content-Type", r.contentType ?? JSON_TYPE);
    }
    if (method === "HEAD" || status === 304 || status === 204) body = null;
    return new Response(body, { status, headers });
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return this.reply({ status, body: body as object, headers });
  }

  private error(e: HttpError): Response {
    const body: Record<string, unknown> = { error: e.message, code: e.code, ...e.extra };
    if (e.field !== undefined) body.field = e.field;
    return this.json(body, e.status);
  }

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let body: string | null = null;
    if (init?.body !== undefined && init.body !== null) {
      body = typeof init.body === "string" ? init.body : await new Response(init.body).text();
    } else if (input instanceof Request && input.body !== null) body = await input.text();
    const route = this.route(url.pathname, method);
    const req: FakeRequest = {
      method,
      url: url.href,
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
      operationId: route.op,
    };
    this.requests.push(req);
    if (signal?.aborted) throw abortReason(signal);
    await this.options.delay?.(req);
    if (signal?.aborted) throw abortReason(signal);
    this.takeDuePhases(); // a camera's phases that are due on the fake's clock, refused requests included
    const fault = this.takeFault(route.op);
    if (fault === "network") throw new TypeError("fetch failed (fake network error)");
    if (fault !== null) return this.reply(fault, method);
    try {
      return await route.run(req, signal);
    } catch (err) {
      if (err instanceof HttpError) return this.error(err);
      throw err;
    }
  }

  private takeFault(op: string): FakeReply | "network" | null {
    for (const key of [op, "*"]) {
      const list = this.faults.get(key);
      const f = list?.[0];
      if (!f) continue;
      f.remaining--;
      if (f.remaining <= 0) list?.shift();
      return f.reply;
    }
    return null;
  }

  private route(
    path: string,
    method: string,
  ): { op: string; run: (r: FakeRequest, s: AbortSignal | undefined) => Response | Promise<Response> } {
    const table: [
      RegExp,
      Record<
        string,
        [string, (m: RegExpExecArray, r: FakeRequest, s: AbortSignal | undefined) => Response | Promise<Response>]
      >,
    ][] = [
      [/^\/api\/v2\/?$/, { GET: ["getApiRoot", () => this.apiRoot()] }],
      [/^\/api\/v2\/openapi\.yaml$/, { GET: ["getOpenApi", () => this.recordedOr("getOpenApi", "openapi: 3.1.0\n")] }],
      [
        /^\/api\/v2\/model$/,
        {
          GET: [
            "getModel",
            () => this.recordedOr("getModel", { schema: "mdl1", checkpoint: "fake", backend: "replay", engines: [] }),
          ],
        },
      ],
      [/^\/api\/v2\/topology$/, { GET: ["getTopology", () => this.recordedOr("getTopology", TOPOLOGY)] }],
      [
        /^\/api\/v2\/health$/,
        {
          GET: [
            "getHealth",
            () => this.recordedOr("getHealth", { ok: true, worker: "running", viewers: this.openStreams }),
          ],
        },
      ],
      [/^\/api\/v2\/ready$/, { GET: ["getReady", () => this.recordedOr("getReady", { ready: true, waiting: [] })] }],
      [/^\/api\/v2\/status$/, { GET: ["getStatus", () => this.status()] }],
      [
        /^\/metrics$/,
        { GET: ["getMetrics", () => this.recordedOr("getMetrics", `interp_viewers ${this.openStreams}\n`)] },
      ],
      [/^\/api\/v2\/videos$/, { GET: ["listVideos", (_m, r) => this.listVideos(r)] }],
      [
        /^\/api\/v2\/videos\/([^/]+)\/media$/,
        { GET: ["getVideoMedia", (m, r) => this.media(m, r)], HEAD: ["getVideoMedia", (m, r) => this.media(m, r)] },
      ],
      [/^\/api\/v2\/videos\/([^/]+)$/, { GET: ["getVideo", (m) => this.getVideo(decodeURIComponent(m[1] as string))] }],
      [/^\/api\/v2\/session$/, { GET: ["getSession", () => this.json(this.sessionReply())] }],
      [/^\/api\/v2\/session\/select$/, { POST: ["sessionSelect", (_m, r) => this.control(r, "select")] }],
      [/^\/api\/v2\/session\/seek$/, { POST: ["sessionSeek", (_m, r) => this.control(r, "seek")] }],
      [/^\/api\/v2\/session\/play$/, { POST: ["sessionPlay", (_m, r) => this.control(r, "play")] }],
      [/^\/api\/v2\/session\/pause$/, { POST: ["sessionPause", (_m, r) => this.control(r, "pause")] }],
      [
        /^\/api\/v2\/session\/focus$/,
        {
          GET: ["getFocus", () => this.getFocus()],
          PUT: ["putFocus", (_m, r) => this.control(r, "focus")],
          DELETE: ["deleteFocus", (_m, r) => this.control(r, "unfocus")],
        },
      ],
      [/^\/api\/v2\/session\/frames\/stream$/, { GET: ["streamFrames", (_m, r, s) => this.stream(r, s, "frames")] }],
      [/^\/api\/v2\/session\/frames$/, { GET: ["pollFrames", (_m, r, s) => this.poll(r, s)] }],
      [
        /^\/api\/v2\/session\/frames\/([^/]+)\/image\.jpg$/,
        { GET: ["getFramePicture", (m, r) => this.picture(m[1] as string, r)] },
      ],
      [/^\/api\/v2\/session\/frames\/([^/]+)\/([^/]+)\.png$/, { GET: ["getFrameRaster", (m, r) => this.raster(m, r)] }],
      [/^\/api\/v2\/session\/frames\/([^/]+)$/, { GET: ["getFrame", (m, r) => this.getFrame(m[1] as string, r)] }],
      [/^\/api\/v2\/session\/world$/, { GET: ["getWorld", () => this.getWorld()] }],
      [/^\/api\/v2\/session\/world\/events$/, { GET: ["getWorldEvents", (_m, r) => this.worldEvents(r)] }],
      [/^\/api\/v2\/session\/world\/stones\/([^/]+)$/, { GET: ["getStone", (m) => this.getStone(m[1] as string)] }],
      [/^\/api\/v2\/session\/render\/overlay2d$/, { GET: ["renderOverlay2d", (_m, r) => this.render(r, "2d")] }],
      [/^\/api\/v2\/session\/render\/scene3d$/, { GET: ["renderScene3d", (_m, r) => this.render(r, "3d")] }],
      [/^\/api\/v2\/raw\/stream$/, { GET: ["rawStream", (_m, r, s) => this.stream(r, s, "raw")] }],
      [/^\/api\/v2\/raw\/packets\/([^/]+)$/, { GET: ["rawPacket", (m, r) => this.rawPacket(m[1] as string, r)] }],
      [
        /^\/api\/v2\/raw\/tensors\/([^/]+)$/,
        {
          GET: [
            "rawTensors",
            () =>
              this.recordedOr(
                "rawTensors-404",
                { error: "tensor capture is not enabled", code: "debug_disabled" },
                404,
              ),
          ],
        },
      ],
    ];
    for (const [re, methods] of table) {
      const m = re.exec(path);
      if (!m) continue;
      const h = methods[method];
      if (!h) {
        const op = Object.values(methods)[0]?.[0] as string;
        return {
          op,
          run: () => {
            throw new HttpError(405, "method_not_allowed", `${method} is not allowed on ${path}`);
          },
        };
      }
      const [op, fn] = h;
      return { op, run: (r, s) => fn(m, r, s) };
    }
    return {
      op: "unknown",
      run: () => {
        throw new HttpError(404, "not_found", `no route ${path}`);
      },
    };
  }

  private recordedOr(name: string, fallback: string | object, status = 200): Response {
    const r = this.replies[name];
    if (r) return this.reply(r);
    return this.reply({
      status,
      body: fallback,
      contentType: typeof fallback === "string" ? "text/plain; charset=utf-8" : undefined,
    });
  }

  private apiRoot(): Response {
    return this.recordedOr("getApiRoot", {
      api: "2.2.0",
      build: BUILD,
      boot: this.bootId,
      backend: "replay",
      spec: "/api/v2/openapi.yaml",
      docs: "/api/docs/",
      layers: { raw: "sip1", overlay: "ovl1", scene: "scn1", cards: "crd1", world: "stw1" },
      render: { overlay2d: "r2d1", scene3d: "r3d1" },
      limits: { retained_frames: 512, max_reply_frames: 16 },
    });
  }

  private status(): Response {
    const r = this.replies.getStatus;
    if (r) return this.reply(r);
    return this.json({
      build: BUILD,
      boot: this.bootId,
      uptime_s: 1,
      page: "next",
      worker: this.workerNow(),
      retained: this.retained(),
      stable: { state: "running", fits: 4, evidence: true, fixer: "thin-v1" },
      hosts: {},
      viewers: this.openStreams,
      long_polls: 0,
      streams: this.allStreams,
    });
  }

  /**
   * The worker's status: the recorded (or appended) one, else running on the current session. Unlike the unit's, it
   * does not change with a camera's phases or a pause (the fake's camera never stops: no reasons).
   */
  private workerNow(): WorkerStatus {
    return this.worker ?? { state: "running", reason: "", session: this.st.session, video: this.st.video };
  }

  private sessionReply(): SessionReply {
    const state = this.state; // the phases that are due first
    const now = this.wall();
    return {
      server_now: now,
      server_recv: now,
      state,
      worker: this.workerNow(),
      viewers: this.openStreams,
      stable: { state: "running", fits: 4, evidence: true, fixer: "thin-v1" },
    };
  }

  private getFocus(): Response {
    const recorded = this.replies.getFocus;
    if (this.empty && recorded) return this.reply(recorded);
    return this.json(this.focusReply());
  }

  private focusReply(): { focus: Focus | null; resolved: unknown } {
    const f = this.st.focus;
    if (!f) return { focus: null, resolved: null };
    const track = this.track(f.id);
    return { focus: f, resolved: track ? { id: f.id, path2d: track.path2d, path3d: track.path3d } : null };
  }

  private listVideos(r: FakeRequest): Response {
    const text = JSON.stringify(this.catalog);
    const etag = etagOf(text);
    if (r.headers.get("if-none-match") === etag) return this.reply({ status: 304, headers: { ETag: etag } });
    return this.reply({ status: 200, body: text, contentType: JSON_TYPE, headers: { ETag: etag } });
  }

  private entry(id: string): VideoEntry {
    const v = this.catalog.videos.find((x) => x.id === id);
    if (!v) throw new HttpError(404, "unknown_video", `Unknown video '${id}'`, "id");
    return v;
  }

  private getVideo(id: string): Response {
    return this.json(this.entry(id));
  }

  private media(m: RegExpExecArray, r: FakeRequest): Response {
    const id = decodeURIComponent(m[1] as string);
    const v = this.entry(id);
    const range = r.headers.get("range");
    if (v.live === true) {
      throw new HttpError(
        404,
        "not_found",
        `${id} is a live camera: it has no proxy video; each frame's picture is /api/v2/session/frames/{g}/image.jpg`,
        "id",
      );
    }
    const recorded = this.replies["getVideoMedia-range"];
    const prefix = recorded?.body instanceof Uint8Array ? recorded.body : new Uint8Array(0);
    const total = Number(/\/(\d+)$/.exec(recorded?.headers?.["Content-Range"] ?? "")?.[1] ?? 65536);
    const etag = recorded?.headers?.ETag ?? '"fake-media"';
    if (r.headers.get("if-none-match") === etag) return this.reply({ status: 304, headers: { ETag: etag } });
    const byte = (k: number): number => (k < prefix.length ? (prefix[k] as number) : (k * 31 + 7) & 0xff);
    const slice = (a: number, b: number): Uint8Array => Uint8Array.from({ length: b - a + 1 }, (_x, i) => byte(a + i));
    const head = { "Accept-Ranges": "bytes", ETag: etag };
    if (range === null) {
      return this.reply(
        {
          status: 200,
          body: slice(0, Math.min(total, 1 << 20) - 1),
          contentType: "video/mp4",
          headers: { ...head, "Content-Length": String(total) },
        },
        r.method,
      );
    }
    const mm = /^bytes=(\d*)-(\d*)$/.exec(range);
    let a = mm?.[1] === "" ? null : Number(mm?.[1]);
    let b = mm?.[2] === "" ? null : Number(mm?.[2]);
    if (mm && a === null && b !== null) {
      a = Math.max(0, total - b);
      b = total - 1;
    }
    if (!mm || a === null || a >= total) {
      return this.reply({ status: 416, body: "", headers: { "Content-Range": `bytes */${total}` } }, r.method);
    }
    b = Math.min(b ?? total - 1, total - 1);
    return this.reply(
      {
        status: 206,
        body: slice(a, b),
        contentType: "video/mp4",
        headers: { ...head, "Content-Range": `bytes ${a}-${b}/${total}` },
      },
      r.method,
    );
  }

  // ---- controls ------------------------------------------------------------------------------------------------------

  private parseBody(r: FakeRequest, required: boolean): Record<string, unknown> {
    if (r.body === null || r.body === "") {
      if (required) throw new HttpError(400, "invalid_json", "a JSON body is required");
      return {};
    }
    if (r.body.length > 512) throw new HttpError(413, "body_too_large", "body over 512 bytes");
    if (!(r.headers.get("content-type") ?? "").includes("application/json")) {
      throw new HttpError(415, "json_only", "the body must be application/json");
    }
    let v: unknown;
    try {
      v = JSON.parse(r.body);
    } catch {
      throw new HttpError(400, "invalid_json", "the body is not JSON");
    }
    if (!isObject(v)) throw new HttpError(400, "not_an_object", "the body is not a JSON object");
    return v;
  }

  /**
   * The source a select or a seek names (`video`), refused in the unit's words: missing (`missing_field`), not a
   * string, null too (`invalid_type`), or not in the catalog (`unknown_video`), all with field `video`.
   */
  private videoOf(body: Record<string, unknown>): VideoEntry {
    if (!("video" in body)) throw new HttpError(400, "missing_field", "Unknown video None", "video");
    const id = body.video;
    if (typeof id !== "string") throw new HttpError(400, "invalid_type", `Unknown video ${pyRepr(id)}`, "video");
    const e = this.catalog.videos.find((v) => v.id === id);
    if (!e) throw new HttpError(400, "unknown_video", `Unknown video '${id}'`, "video");
    return e;
  }

  /** A select's or a seek's `time` within source `e` (`null` is a time of the wrong type, as on the unit). */
  private timeOf(v: unknown, e: VideoEntry): number {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, "invalid_type", timeRange(e), "time");
    if (v < 0 || (typeof e.duration === "number" && v > e.duration)) {
      throw new HttpError(400, "time_out_of_range", timeRange(e), "time");
    }
    return v;
  }

  /** A select, checked in the unit's order: its video, a camera (any `time` refused, `null` too), then the time. */
  private selectState(body: Record<string, unknown>, now: number): State {
    const e = this.videoOf(body);
    const timed = "time" in body;
    if (timed && this.isLiveVideo(e.id)) {
      throw new HttpError(400, "not_seekable", `${e.id} is a live camera: leave time out`, "time");
    }
    const t = timed ? this.timeOf(body.time, e) : typeof e.default_start === "number" ? e.default_start : 0;
    return this.newSession(e, t, now);
  }

  /**
   * A seek, checked in the unit's order: its video (the one it names, else the one shown), a camera (409: a seek naming
   * a recording is applied even while the session shows a camera, and moves every viewer off it), then the time
   * (missing, its type, the range).
   */
  private seekState(body: Record<string, unknown>, now: number): State {
    const e = "video" in body ? this.videoOf(body) : this.catalog.videos.find((v) => v.id === this.st.video);
    if (!e) throw new HttpError(409, "not_seekable", "the session shows no video", "video");
    if (this.isLiveVideo(e.id)) {
      throw new HttpError(409, "not_seekable", `${e.id} is a live camera and cannot seek`, "video");
    }
    if (!("time" in body)) throw new HttpError(400, "missing_field", timeRange(e), "time");
    return this.newSession(e, this.timeOf(body.time, e), now);
  }

  /**
   * The state of a new session (the newest id + 1, the playing state kept) on source `e` from media time `t`: on a
   * camera `connecting`, from media time 0 at rate 1.0; on a recording held for its `hold` (1.4 s without one), at the
   * rate recordings play at.
   */
  private newSession(e: VideoEntry, t: number, now: number): State {
    const session = Math.max(this.st.session, ...this.recordedFrames.map((f) => f.session)) + 1;
    const revision = this.newestRevision() + 1;
    if (this.isLiveVideo(e.id)) return this.connecting(e.id, session, revision, this.st.playing, "viewer", now);
    const next: State = {
      ...this.st,
      session,
      revision,
      video: e.id,
      rate: this.recRate,
      anchor_media: t,
      anchor_wall: now,
      hold_until: now + (typeof e.hold === "number" ? e.hold : 1.4),
      duration: typeof e.duration === "number" ? e.duration : null,
      changed_by: "viewer",
      focus: null,
    };
    delete next.live;
    return next;
  }

  /** `503 world_unavailable`, as the unit answers while its world is not running (before a camera releases a frame). */
  private worldUnavailable(): HttpError {
    return new HttpError(503, "world_unavailable", "the Stable sim is not running", undefined, { retry_ms: 1000 });
  }

  private control(r: FakeRequest, action: "select" | "seek" | "play" | "pause" | "focus" | "unfocus"): Response {
    // checked in the server's order: the Origin, then dry_run (0 or 1), then the body and its fields
    const origin = r.headers.get("origin");
    if (origin !== null && origin !== new URL(r.url).origin) {
      throw new HttpError(403, "cross_origin", "cross-origin control refused");
    }
    const dryText = r.query.get("dry_run");
    if (dryText !== null && dryText !== "0" && dryText !== "1") {
      throw new HttpError(400, "invalid_param", "dry_run must be 0 or 1", "dry_run");
    }
    const dry = dryText === "1";
    const now = this.wall();
    let next: State = { ...this.st };
    const bump = (): void => {
      next.revision = this.newestRevision() + 1;
      next.changed_by = "viewer";
    };
    let program = false;
    if (action === "select" || action === "seek") {
      const body = this.parseBody(r, true);
      next = action === "select" ? this.selectState(body, now) : this.seekState(body, now);
      program = true;
    } else if (action === "play") {
      this.parseBody(r, false); // its fields are ignored
      if (!next.playing) {
        if (isCameraState(next)) {
          const l = next.live;
          if (l.phase === "live") next.anchor_media = Math.max(0, now - l.since - l.lag); // on at the live edge
          next.live = { ...l, phase: "connecting" }; // and connects again: its next frames start a new warm-up
        }
        next.playing = true;
        next.anchor_wall = now;
        bump();
      }
    } else if (action === "pause") {
      this.parseBody(r, false);
      if (next.playing) {
        next.anchor_media = this.mediaTimeOf(this.st, now); // the phase is kept
        next.anchor_wall = now;
        next.playing = false;
        bump();
      }
    } else if (action === "focus") {
      const body = this.parseBody(r, true);
      const id = body.stone_id;
      if (id === undefined) throw new HttpError(400, "missing_field", "stone_id is required", "stone_id");
      if (typeof id !== "number" || !Number.isInteger(id))
        throw new HttpError(400, "invalid_type", "stone_id must be an integer", "stone_id");
      if (id < 0 || id > 1e9) throw new HttpError(400, "invalid_param", "stone_id is out of range", "stone_id");
      if (body.session !== undefined && body.session !== this.st.session) {
        throw new HttpError(409, "stale_session", `session ${JSON.stringify(body.session)} has ended`, "session");
      }
      const world = this.latestWorld();
      if (!world) throw this.worldUnavailable();
      const stone = world.stones.find((s) => s.id === id);
      if (!stone) throw new HttpError(404, "unknown_stone", `no stone ${id} in the world`, "stone_id");
      bump();
      next.focus = {
        n: next.revision,
        session: next.session,
        video: next.video,
        id,
        g: world.g,
        t: world.t,
        x: stone.solid.pos[0],
        y: stone.solid.pos[1],
        z: stone.solid.pos[2],
        L: stone.solid.dims[0],
        W: stone.solid.dims[1],
        yaw: 0,
      };
    } else if (next.focus !== null) {
      next.focus = null;
      bump();
    }
    next.media_time = this.mediaTimeOf(next, now);
    // a dry run, or a control that changes nothing (a play while playing...), moves nothing and sends no clock event
    if (!dry && next.revision !== this.st.revision) {
      this.st = { ...next };
      this.ownWay(); // the session goes its own way: the recording's later clock lines are only sent
      if (program) {
        this.phases = [];
        this.heldFrames = [];
        if (isCameraState(next)) {
          this.startCamera(); // connecting now; warming and live fall due on the fake's clock, live releases the run
          this.startSegment([]);
        } else {
          const { session, video, anchor_media: from } = next;
          this.startSegment(
            this.recordedFrames
              .filter((f) => f.video === video && f.t >= from)
              .map((f) => {
                const c = clone(f);
                c.session = session;
                if (c.world) c.world.session = session;
                return c;
              }),
          );
        }
      } else {
        if (action === "play" && isCameraState(next)) this.restartCamera(now);
        this.timeline.push({ kind: "side", sse: "clock", data: { ...next, server_now: now }, segment: this.segment });
        this.wake();
      }
    }
    return this.json({ state: next, server_now: now, server_recv: now, dry_run: dry });
  }

  // ---- frames, world -------------------------------------------------------------------------------------------------

  private layersOf(r: FakeRequest, fallback = "overlay,scene,cards,world"): Layer[] {
    const v = r.query.get("layers") ?? fallback;
    const out: Layer[] = [];
    for (const l of v.split(",").map((x) => x.trim())) {
      if (l === "") continue;
      if (!(LAYERS as readonly string[]).includes(l))
        throw new HttpError(400, "unknown_layer", `unknown layer '${l}'`, "layers");
      out.push(l as Layer);
    }
    return out;
  }

  /** `?session=`: an integer (empty: not given), and the current session's, else `410 session_gone`. */
  private checkSession(r: FakeRequest): void {
    const s = r.query.get("session");
    if (s === null || s === "") return;
    if (!/^[+-]?\d+$/.test(s)) throw new HttpError(400, "invalid_param", "session must be an integer", "session");
    const n = Number(s);
    if (n !== this.st.session) throw new HttpError(410, "session_gone", `session ${n} has ended`, "session");
  }

  private frameAt(gText: string): Frame {
    if (!/^(latest|[0-9]{1,10})$/.test(gText))
      throw new HttpError(400, "invalid_param", "g must be an integer or latest", "g");
    const byG = this.newestByG();
    const frame = gText === "latest" ? [...byG.values()].sort((a, b) => b.g - a.g)[0] : byG.get(Number(gText));
    if (!frame) {
      const message = gText === "latest" ? "no frame is retained yet" : `frame ${gText} is not retained`;
      throw new HttpError(404, "not_retained", message, "g", { retained: this.retained() });
    }
    return frame;
  }

  /**
   * True when the current session has no frames and is not a camera's: data operations then answer from recorded
   * replies (a camera session's are its own, released or not).
   */
  private get empty(): boolean {
    return this.segmentFrames().length === 0 && !isCameraState(this.st);
  }

  private getFrame(gText: string, r: FakeRequest): Response {
    const layers = this.layersOf(r);
    this.checkSession(r);
    const recorded = this.replies["getFrame-latest"];
    if (this.empty && gText === "latest" && recorded) return this.reply(recorded);
    return this.json(this.view(this.frameAt(gText), layers, false));
  }

  /**
   * `GET /session/frames/{g}/image.jpg`, checked in the unit's order: `g`, a stale session (gone whatever the session
   * shows), a recording, the frame, its picture (only the newest {@link KEEP_PICTURES} released frames have one).
   */
  private picture(gText: string, r: FakeRequest): Response {
    if (!/^(latest|[0-9]{1,10})$/.test(gText)) {
      throw new HttpError(400, "invalid_param", "g must be an integer or latest", "g");
    }
    this.checkSession(r);
    if (!isCameraState(this.st)) {
      throw new HttpError(404, "not_found", `${this.st.video} is a recording: its picture is the proxy video`, "g");
    }
    const frame = this.frameAt(gText);
    const gs = [...this.newestByG().keys()].sort((a, b) => a - b);
    if (gs.length > KEEP_PICTURES && frame.g < (gs[gs.length - KEEP_PICTURES] as number)) {
      throw new HttpError(
        404,
        "not_retained",
        `the picture of frame ${frame.g} is no longer kept: only the newest ${KEEP_PICTURES} pictures are`,
        "g",
      );
    }
    const jpeg = fakePicture(frame.video, frame.g);
    return this.reply({
      body: jpeg,
      contentType: "image/jpeg",
      headers: { "Cache-Control": "no-store", "X-Interp-G": String(frame.g), "Content-Length": String(jpeg.length) },
    });
  }

  private raster(m: RegExpExecArray, r: FakeRequest): Response {
    const kind = m[2] as string;
    if (!["regions", "mask", "depth"].includes(kind))
      throw new HttpError(404, "not_found", `unknown raster ${kind}`, "raster");
    const scale = Number(r.query.get("scale") ?? "1");
    if (!Number.isInteger(scale) || scale < 1 || scale > 8)
      throw new HttpError(400, "invalid_param", "scale must be within 1..8", "scale");
    this.frameAt(m[1] as string);
    const rec = this.replies[`getFrameRaster-${kind}`];
    return this.reply(rec ?? { body: TINY_PNG, contentType: "image/png" });
  }

  private latestWorld(): Frame["world"] | null {
    const fs = [...this.newestByG().values()].filter((f) => f.world).sort((a, b) => b.g - a.g);
    return fs[0]?.world ?? null;
  }

  private getWorld(): Response {
    const w = this.latestWorld();
    const recorded = this.replies.getWorld;
    if (!w && recorded && !isCameraState(this.st)) return this.reply(recorded);
    if (!w) throw this.worldUnavailable();
    return this.json(w);
  }

  private intParam(r: FakeRequest, name: string, def: number, lo: number, hi: number, unit = ""): number {
    const v = r.query.get(name);
    if (v === null) return def;
    const n = Number(v);
    if (!/^-?\d+$/.test(v) || n < lo || n > hi)
      throw new HttpError(400, "invalid_param", `${name} must be within ${lo}..${hi}${unit}`, name);
    return n;
  }

  private worldEvents(r: FakeRequest): Response {
    const after = this.intParam(r, "after", -1, -1, Number.MAX_SAFE_INTEGER);
    const limit = this.intParam(r, "limit", 256, 1, 1024);
    const typeText = r.query.get("type");
    const types = typeText === null ? null : typeText.split(",").filter((x) => x !== "");
    for (const t of types ?? []) {
      if (!(WORLD_EVENT_TYPES as readonly string[]).includes(t))
        throw new HttpError(400, "invalid_param", `unknown event type '${t}'`, "type");
    }
    const byG = this.newestByG();
    const frames = [...byG.values()].filter((f) => f.world).sort((a, b) => a.g - b.g);
    const recorded = this.replies.getWorldEvents;
    if (frames.length === 0 && recorded && !isCameraState(this.st)) return this.reply(recorded);
    const events: Record<string, unknown>[] = [];
    let next = after;
    for (const f of frames) {
      if (f.g <= after) continue;
      if (events.length >= limit) break;
      for (const e of f.world?.events ?? []) {
        if (types && !types.includes(e.type)) continue;
        events.push({ g: f.g, t: f.t, ...e });
      }
      next = f.g;
    }
    const reply: Record<string, unknown> = { session: this.st.session, video: this.st.video, events, next_after: next };
    if (byG.size > 0) reply.oldest_g = Math.min(...byG.keys()); // the oldest retained frame, with a world or not
    return this.json(reply);
  }

  private track(id: number): StoneTrack | null {
    const frames = [...this.newestByG().values()].filter((f) => f.world).sort((a, b) => a.g - b.g);
    let first: Frame | null = null;
    let last: Frame | null = null;
    const path2d: number[][] = [];
    const path3d: number[][] = [];
    for (const f of frames) {
      const s = f.world?.stones.find((x) => x.id === id);
      if (!s) continue;
      first ??= f;
      last = f;
      const n = s.outline.length;
      const cx = s.outline.reduce((a, p) => a + p[0], 0) / n;
      const cy = s.outline.reduce((a, p) => a + p[1], 0) / n;
      path2d.push([Math.round(cx * 100) / 100, Math.round(cy * 100) / 100]);
      path3d.push([s.solid.pos[0], s.solid.pos[1], s.solid.pos[2] + s.solid.dims[2] / 2]);
    }
    if (!first || !last) return null;
    const stone = (last.world as WorldLayer).stones.find((x) => x.id === id) as StoneView;
    return {
      schema: "sts1",
      session: this.st.session,
      video: this.st.video,
      id,
      g: last.g,
      t: last.t,
      stone,
      first_g: first.g,
      last_g: last.g,
      path2d: path2d.slice(-512),
      path3d: path3d.slice(-512),
    };
  }

  private getStone(idText: string): Response {
    if (!/^\d+$/.test(idText)) throw new HttpError(400, "invalid_param", "id must be an integer", "id");
    const t = this.track(Number(idText));
    const recorded = this.replies.getStone;
    if (!t && this.empty && recorded) return this.reply(recorded);
    if (!t) throw new HttpError(404, "unknown_stone", `no stone ${idText} in the world`, "id");
    return this.json(t);
  }

  private render(r: FakeRequest, kind: "2d" | "3d"): Response {
    const g = r.query.get("g");
    const t = r.query.get("t");
    if ((g === null) === (t === null)) throw new HttpError(400, "invalid_param", "give exactly one of g and t", "t");
    const mode = r.query.get("mode") ?? "stable";
    if (mode !== "stable" && mode !== "raw")
      throw new HttpError(400, "invalid_param", "mode must be stable or raw", "mode");
    const draw = r.query.get("draw") ?? "shapes";
    if (draw !== "shapes" && draw !== "primitives")
      throw new HttpError(400, "invalid_param", "draw must be shapes or primitives", "draw");
    const surface = r.query.get("surface") ?? "vertices";
    if (kind === "3d" && !["vertices", "compact", "none"].includes(surface)) {
      throw new HttpError(400, "invalid_param", "surface must be vertices, compact or none", "surface");
    }
    this.checkSession(r);
    let frame: Frame;
    if (g !== null) frame = this.frameAt(g);
    else {
      const tt = Number(t);
      const fs = [...this.newestByG().values()].filter((f) => f.t <= tt).sort((a, b) => b.t - a.t);
      if (!fs[0] || !Number.isFinite(tt))
        throw new HttpError(404, "not_retained", `time ${t} is not retained`, "t", { retained: this.retained() });
      frame = fs[0];
    }
    if (kind === "2d") {
      const name = draw === "primitives" ? "renderOverlay2d-primitives" : "renderOverlay2d";
      const rec = this.replies[name];
      if (rec) return this.reply(rec);
      return this.json(this.overlayOf(frame, mode));
    }
    const name = surface === "vertices" ? "renderScene3d" : `renderScene3d-${surface}`;
    const rec = this.replies[name];
    if (rec) return this.reply(rec);
    return this.json(this.sceneOf(frame, mode));
  }

  private overlayOf(frame: Frame, mode: string): Overlay2D {
    const stones: DrawStone2D[] = (frame.world?.stones ?? []).map((s) => ({
      id: s.id,
      outline: s.outline,
      style: s.side ? "held" : s.detected ? "detected" : s.mode === "placed" ? "placed" : "kept",
      side: s.side,
      alpha: 1,
      detected: s.detected,
      uncertain: s.uncertain,
      shape: s.shape,
      mode: s.mode,
    }));
    const src = this.catalog.videos.find((v) => v.id === frame.video);
    return {
      schema: "r2d1",
      session: frame.session,
      video: frame.video,
      g: frame.g,
      bg: null,
      f: 0,
      t: frame.t,
      mode: mode as Overlay2D["mode"],
      native_wh: frame.overlay?.native_wh ?? src?.native_wh ?? [1920, 1080],
      stones,
      skeleton: { bones: [], joints: [] },
      wrists: [],
      focus: null,
    };
  }

  private sceneOf(frame: Frame, mode: string): Scene3D {
    const stones: DrawStone3D[] = (frame.world?.stones ?? []).map((s) => ({
      id: s.id,
      family: s.family,
      pos: s.solid.pos,
      q: s.solid.q,
      dims: s.solid.dims,
      side: s.side,
      alpha: 1,
      uncertain: s.uncertain,
    }));
    return {
      schema: "r3d1",
      session: frame.session,
      video: frame.video,
      g: frame.g,
      bg: null,
      f: 0,
      t: frame.t,
      mode: mode as Scene3D["mode"],
      plane: (frame.scene?.plane as unknown as Record<string, unknown>) ?? {},
      board: frame.world?.draw?.board ?? null,
      stones,
      skeleton: { joints: frame.scene?.skeleton.world ?? [], bones: [], rings: frame.scene?.rings ?? [] },
      surface: null,
      focus: null,
    };
  }

  private rawPacket(gText: string, r: FakeRequest): Response {
    this.checkSession(r);
    const noRaw = !isCameraState(this.st) && !this.segmentFrames().some((e) => e.frame.raw);
    if (gText === "latest" && this.replies["rawPacket-latest"] && noRaw) {
      return this.reply(this.replies["rawPacket-latest"]);
    }
    const frame = this.frameAt(gText);
    if (!frame.raw)
      throw new HttpError(404, "not_retained", `packet ${gText} is not retained`, "g", { retained: this.retained() });
    return this.json(packetOf(frame.raw, frame, frame.cursor));
  }

  // ---- streams -------------------------------------------------------------------------------------------------------

  /** Where a stream starts, and the side events it starts with. NDJSON has no event ids: `Last-Event-ID` is SSE only. */
  private startIndex(r: FakeRequest, sse: boolean): { index: number; prelude: { sse: string; data: unknown }[] } {
    const prelude = this.preludes.shift() ?? [];
    const reset = { sse: "reset", data: { boot: this.bootId, cursor: this.nextCursor - 1 } };
    if (this.pendingReset) {
      this.pendingReset = false;
      prelude.unshift(reset);
    }
    const lastId = r.headers.get("last-event-id");
    const after = r.query.get("after");
    if (sse && lastId !== null && lastId !== "") {
      const dash = lastId.lastIndexOf("-");
      const boot = lastId.slice(0, dash);
      const cursor = Number(lastId.slice(dash + 1));
      if (boot !== this.bootId) {
        if (!prelude.includes(reset)) prelude.push(reset);
        return { index: this.connectIndex(), prelude };
      }
      return { index: this.resumeAt(cursor), prelude };
    }
    if (after !== null) return { index: this.resumeAt(Number(after)), prelude };
    return { index: this.connectIndex(), prelude };
  }

  /** Where a stream without a position starts (`connect`). */
  private connectIndex(): number {
    return this.options.connect === "newest" ? this.newestIndex() : this.segmentStart;
  }

  /** The timeline index of the current session's newest frame (the end of the timeline when it has none). */
  private newestIndex(): number {
    for (let i = this.timeline.length - 1; i >= this.segmentStart; i--) {
      const e = this.timeline[i] as Entry;
      if (e.kind === "frame" && e.frame.session === this.st.session) return i;
    }
    return this.timeline.length;
  }

  /** The timeline index after the last frame entry with a cursor <= `cursor`. */
  private indexAfter(cursor: number): number {
    let index = 0;
    for (let i = 0; i < this.timeline.length; i++) {
      const e = this.timeline[i] as Entry;
      if (e.kind === "frame" && e.cursor <= cursor) index = i + 1;
    }
    return index;
  }

  /**
   * Where a resumed stream starts: at the first frame after `cursor`. Side events are live state on a real server and
   * are not replayed, so those between that cursor and the next frame are skipped.
   */
  private resumeAt(cursor: number): number {
    let index = this.indexAfter(cursor);
    while (index < this.timeline.length && (this.timeline[index] as Entry).kind === "side") index++;
    return index;
  }

  private stream(r: FakeRequest, signal: AbortSignal | undefined, kind: "frames" | "raw"): Response {
    const format = r.query.get("format") ?? (r.headers.get("accept")?.includes("ndjson") ? "ndjson" : "sse");
    if (format !== "sse" && format !== "ndjson")
      throw new HttpError(400, "invalid_param", "format must be ndjson or sse", "format");
    const layers = kind === "frames" ? this.layersOf(r) : [];
    const limit = this.intParam(r, "limit", 0, 1, 4096);
    const maxS = this.intParam(r, "max_s", 0, 1, 3600);
    this.intParam(r, "observe", 0, 0, 1);
    const observe = r.query.get("observe") === "1";
    const sse = format === "sse";
    const start = this.startIndex(r, sse);
    this.passTo(start.index); // playback has passed the clock lines before where it starts (those a resume skips too)
    let index = start.index;
    const prelude = start.prelude;
    let dropAfter = this.dropAfterEvents;
    this.dropAfterEvents = null;
    const epoch = this.restarts;
    let sent = 0;
    let frames = 0;
    let firstT: number | null = null;
    let startWall = this.clock.now();
    const enc = new TextEncoder();
    const ctl = new AbortController();
    if (!observe) this.openStreams++;
    this.allStreams++;
    let open = true;
    const finish = (): void => {
      if (!open) return;
      open = false;
      if (!observe) this.openStreams--;
      this.allStreams--;
      ctl.abort();
    };
    const encodeFrame = (e: Extract<Entry, { kind: "frame" }>): string | null => {
      let data: unknown;
      if (kind === "raw") {
        if (!e.frame.raw) return null;
        data = packetOf(e.frame.raw, e.frame, e.cursor);
      } else data = this.view(e.frame, layers, true);
      const json = JSON.stringify(data);
      return sse ? `id: ${this.bootId}-${e.cursor}\nevent: frame\ndata: ${json}\n\n` : `${json}\n`;
    };
    const encodeSide = (e: { sse: string; data: unknown }): string | null => {
      if (!sse) return e.sse === "gap" ? `${JSON.stringify(e.data)}\n` : null;
      return `event: ${e.sse}\ndata: ${JSON.stringify(e.data)}\n\n`;
    };
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const onAbort = (): void => {
      finish();
      controllerRef?.error(abortReason(signal as AbortSignal));
    };
    /** The stream reached its `limit` or `max_s`: end it, or (`atLimit: "hold"`) send nothing until the client closes. */
    const finished = async (): Promise<void> => {
      if (this.options.atLimit !== "hold") {
        finish();
        controllerRef?.close();
        return;
      }
      // called only while the stream is open (no await since `pull` checked), so the abort is still to come
      await new Promise<void>((resolve) => ctl.signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const body = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          controllerRef = c;
        },
        pull: async (c) => {
          for (;;) {
            if (!open) return;
            if (epoch !== this.restarts) {
              finish();
              c.error(new TypeError("network connection was lost: the unit restarted (fake)"));
              return;
            }
            const pre = prelude.shift();
            if (pre !== undefined) {
              const text = encodeSide(pre);
              if (text === null) continue;
              sent++;
              c.enqueue(enc.encode(text));
              return;
            }
            if (dropAfter !== null && sent >= dropAfter) {
              dropAfter = null;
              finish();
              c.error(new TypeError("network connection was lost (fake)"));
              return;
            }
            if (limit > 0 && frames >= limit) {
              await finished();
              return;
            }
            if (index < this.segmentStart) index = this.segmentStart; // an open stream moves on to a new program
            const e = this.timeline[index];
            if (e === undefined) {
              if (this.phases.length > 0 && !this.closed) {
                // a camera on its way to live: on the fake's own clock on to its next phase, else waiting for it
                if (!this.canSkip(Number.POSITIVE_INFINITY)) await this.untilPhase(ctl.signal);
                else await this.skipToPhase();
                continue;
              }
              if (this.closed || this.options.endOfData === "close") {
                await settle(); // one macrotask turn: endless reconnects to an exhausted fake cannot starve timers
                finish();
                c.close();
                return;
              }
              await this.waitForMore(ctl.signal);
              continue;
            }
            if (e.kind === "side") {
              index++;
              this.pass(e); // a later clock line of the recording becomes the shared state (NDJSON sends none)
              const text = encodeSide(e);
              if (text === null) continue;
              sent++;
              c.enqueue(enc.encode(text));
              return;
            }
            const text = encodeFrame(e);
            if (text === null) {
              index++;
              continue;
            }
            if (firstT === null) {
              firstT = e.frame.t;
              startWall = this.clock.now();
            } else if (maxS > 0 && e.frame.t - firstT >= maxS) {
              await finished();
              return;
            }
            if (this.options.realtime) {
              const wait = startWall + (e.frame.t - firstT) * 1000 - this.clock.now();
              if (wait > 0) await this.clock.sleep(wait, ctl.signal).catch(() => undefined);
              if (!open) return;
            }
            index++;
            frames++;
            sent++;
            c.enqueue(enc.encode(text));
            return;
          }
        },
        cancel: () => {
          finish();
          signal?.removeEventListener("abort", onAbort);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": sse ? "text/event-stream" : "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Interp-Build": BUILD,
      },
    });
  }

  private async poll(r: FakeRequest, signal: AbortSignal | undefined): Promise<Response> {
    const cursor = this.intParam(r, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
    const rev = this.intParam(r, "rev", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = this.intParam(r, "limit", 8, 1, 16);
    const wait = this.intParam(r, "wait", 1000, 0, 1000, " ms");
    const cid = r.query.get("cid");
    if (cid !== null && !/^[A-Za-z0-9_-]{8,40}$/.test(cid))
      throw new HttpError(400, "invalid_param", "cid must match ^[A-Za-z0-9_-]{8,40}$", "cid");
    const layers = this.layersOf(r);
    const until = this.wall() + wait / 1000;
    // on the fake's own clock: on to each of the camera's phases due within the wait, taken in turn
    while (this.canSkip(until)) await this.skipToPhase();
    this.takeDuePhases();
    const pick = (): Extract<Entry, { kind: "frame" }>[] => {
      const out: Extract<Entry, { kind: "frame" }>[] = [];
      if (cursor === 0 && this.options.connect === "newest") {
        // as the unit: the newest `limit` frames of the session
        for (let i = this.timeline.length - 1; i >= this.segmentStart && out.length < limit; i--) {
          const e = this.timeline[i] as Entry;
          if (e.kind === "frame") out.unshift(e);
        }
        return out;
      }
      // a cursor of an earlier program: the current one's frames (the poll moves on, as an open stream does)
      const from = cursor === 0 ? this.segmentStart : Math.max(this.segmentStart, this.indexAfter(cursor));
      this.passTo(from);
      for (let i = from; i < this.timeline.length && out.length < limit; i++) {
        const e = this.timeline[i] as Entry;
        // a reply ends before a clock line not yet taken, so that its state is that of all its frames
        if (e.kind === "side" && e.pending === true && out.length > 0) break;
        this.pass(e);
        if (e.kind === "frame") out.push(e);
      }
      return out;
    };
    let picked = pick();
    // Nothing to send: the unit waits up to `wait` for a frame or a change. The fake's own clock moves only with the
    // test, so on it the poll answers at once, as Go's fake does (the camera's phases within the wait were taken
    // above); on a clock the fake was given it waits on that clock, and a camera on its way to live answers when its
    // next phase comes, if that is sooner.
    const holds = this.ownClock === null && (this.options.endOfData !== "close" || this.phases.length > 0);
    // the waiter is registered in the same turn as the pick, so frames appended meanwhile cannot be missed
    if (picked.length === 0 && rev === this.st.revision && wait > 0 && !this.closed && holds) {
      const ctl = new AbortController();
      const onAbort = (): void => ctl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const phase = this.st.playing ? this.phases[0] : undefined;
      const ms = phase === undefined ? wait : Math.min(wait, Math.max(0, phase.at * 1000 - this.clock.now()));
      await Promise.race([this.waitForMore(ctl.signal), this.clock.sleep(ms, ctl.signal).catch(() => undefined)]);
      ctl.abort();
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) throw abortReason(signal);
      this.takeDuePhases();
      picked = pick();
    }
    if (picked.length === 0) await settle(); // an empty reply takes one macrotask turn, as an exhausted stream does
    const last = picked[picked.length - 1];
    return this.json({
      ...this.sessionReply(),
      cursor: last ? last.cursor : cursor,
      frames: picked.map((e) => this.view(e.frame, layers, true)),
    });
  }
}
