/**
 * The shared session (SDK-DESIGN.md section 2.6): its state and clock, and the controls. Every control moves the shared
 * session for every viewer unless `dryRun` is set.
 *
 * @module
 */
import type { Api, Picture } from "./api.js";
import { FactoryError } from "./errors.js";
import type { Clock } from "./internal/clock.js";
import type { ControlReply, SessionReply, State } from "./models.js";
import type { RequestOptions } from "./transport.js";
import { LIVE_ID, type Source } from "./sources.js";

/** {@link Session.untilLive} reads the shared state at most this often, milliseconds. */
export const UNTIL_LIVE_POLL_MS = 250;

/** True when `s` shows a live camera: it has `live` (or the id the design gave the camera before cameras shipped). */
function isLiveState(s: State): boolean {
  return (s.live !== undefined && s.live !== null) || s.video === LIVE_ID;
}

/** Options of the controls. */
export interface ControlParams extends RequestOptions {
  /** Validate and answer without moving the shared session. */
  dryRun?: boolean;
}

/** Where the playhead starts running: after the worker's warm-up hold (`hold_until`) of a select or seek. */
function runStart(s: State): number {
  return typeof s.hold_until === "number" ? Math.max(s.anchor_wall, s.hold_until) : s.anchor_wall;
}

/**
 * Maps between media time, the server's wall clock and the local wall clock. The offset comes from one or more
 * `getSession` samples: `offset = server_recv - (t_send + t_recv) / 2`, the round trip with the shortest wait wins.
 * While the session plays, media time runs at `rate` from `max(anchor_wall, hold_until)` (after a select or seek the
 * playhead waits for the worker's hold); while it is paused it stands at `anchor_media`. The `wall` of events and of
 * the Interpreter's state starts from the same point, so it equals {@link SessionClock.wallOf} of their media time.
 */
export class SessionClock {
  constructor(
    /** The shared state of the sample. */
    readonly state: State,
    /** Server wall clock minus local wall clock, seconds. */
    readonly offset: number,
    /** Round trip of the sample, seconds. */
    readonly rtt: number,
    private readonly clock: Clock,
  ) {}

  /** True when the session shows a live camera (its state has `live`). */
  get isLive(): boolean {
    return isLiveState(this.state);
  }

  /** The server's wall clock now (epoch seconds). */
  serverNow(): number {
    return this.clock.now() / 1000 + this.offset;
  }

  /** The shared playhead (media seconds) at a server wall time (epoch seconds), clamped to a recording's duration. */
  mediaTimeAt(serverWall: number): number {
    const s = this.state;
    let t = s.playing ? s.anchor_media + Math.max(0, serverWall - runStart(s)) * s.rate : s.anchor_media;
    if (s.duration !== null) t = Math.min(t, s.duration);
    return Math.max(0, t);
  }

  /** Media time now. */
  mediaTimeNow(): number {
    return this.mediaTimeAt(this.serverNow());
  }

  /**
   * The server wall time (epoch seconds) when the playhead is (or was) at media time `t`, at the current rate; while
   * paused, mapped back from the pause (`anchor_wall`). Null for a rate of 0.
   */
  wallOf(t: number): number | null {
    const s = this.state;
    if (!(s.rate > 0)) return null;
    const start = s.playing ? runStart(s) : s.anchor_wall;
    return start + (t - s.anchor_media) / s.rate;
  }

  /** The local wall time (epoch seconds) of media time `t`, or null for a rate of 0. */
  localWallOf(t: number): number | null {
    const wall = this.wallOf(t);
    return wall === null ? null : wall - this.offset;
  }

  /** Progress of a recording (0..1), null on a live camera. */
  progress(t = this.mediaTimeNow()): number | null {
    const d = this.state.duration;
    if (this.isLive || d === null || d <= 0) return null;
    return Math.min(1, Math.max(0, t / d));
  }
}

function notSeekable(message: string, field: "time" | "video"): FactoryError {
  return new FactoryError({ code: "not_seekable", field, message });
}

/** The session helpers. Reach them as `factory.session`. */
export class Session {
  private last: State | null = null;

  constructor(
    private readonly api: Api,
    private readonly clockSource: Clock,
  ) {}

  /**
   * The newest shared state this client has seen, without a request: from `state()`, `clock()`, `watch()`, the replies
   * of the controls (not of dry runs) and the `clock` items of the client's streams and Interpreters. Null before any.
   * Other viewers move the session too, so it can be out of date.
   */
  get lastState(): State | null {
    return this.last;
  }

  /**
   * Keeps `state` as the newest unless it is older than the one kept (the same session with a lower revision).
   *
   * @internal
   */
  note(state: State): void {
    const old = this.last;
    if (old === null || old.session !== state.session || state.revision >= old.revision) this.last = state;
  }

  private reply(reply: ControlReply, dryRun: boolean | undefined): State {
    if (!dryRun) this.note(reply.state);
    return reply.state;
  }

  /** The shared state now. */
  async state(options?: RequestOptions): Promise<State> {
    const { state } = await this.api.getSession(options);
    this.note(state);
    return state;
  }

  /** A {@link SessionClock} from `samples` reads of `getSession` (default 1). */
  async clock(options: { samples?: number } & RequestOptions = {}): Promise<SessionClock> {
    const samples = Math.max(1, options.samples ?? 1);
    let best: { reply: SessionReply; offset: number; rtt: number } | null = null;
    for (let i = 0; i < samples; i++) {
      const tSend = this.clockSource.now() / 1000;
      const reply = await this.api.getSession(options);
      const tRecv = this.clockSource.now() / 1000;
      this.note(reply.state);
      const rtt = tRecv - tSend;
      const offset = reply.server_recv - (tSend + tRecv) / 2;
      if (best === null || rtt < best.rtt) best = { reply, offset, rtt };
    }
    const b = best as { reply: SessionReply; offset: number; rtt: number };
    return new SessionClock(b.reply.state, b.offset, b.rtt, this.clockSource);
  }

  /**
   * Shows a source to every viewer (an id such as `"dry1"` or a camera's serial, or a {@link Source}): plays first if
   * paused (playing gives the worker its hold to warm up), then selects it, at `at` seconds or its default start. A
   * live camera has no time: `at` for a camera `Source`, or for an id the catalog lists as a camera, is refused locally
   * (`not_seekable`, field `time`) without the select. Returns the new state: on a camera it is `connecting`, and
   * {@link Session.untilLive} waits out the connection and the warm-up. Moves the shared session for every viewer
   * (unless `dryRun`).
   */
  async watch(source: string | Source, options: { at?: number } & ControlParams = {}): Promise<State> {
    const sourceId = typeof source === "string" ? source : source.id;
    if (options.at !== undefined && (await this.isCamera(source, options))) {
      throw notSeekable(`${sourceId} is a live camera: it has no time; leave \`at\` out`, "time");
    }
    const control = { dryRun: options.dryRun, signal: options.signal, headers: options.headers };
    const now = await this.api.getSession(options);
    this.note(now.state);
    if (!now.state.playing) this.reply(await this.api.sessionPlay(control), options.dryRun);
    const body = options.at === undefined ? { video: sourceId } : { video: sourceId, time: options.at };
    return this.reply(await this.api.sessionSelect(body, control), options.dryRun);
  }

  /** Whether `source` is a live camera: a {@link Source} says so itself; an id is looked up in the catalog. */
  private async isCamera(source: string | Source, options: RequestOptions): Promise<boolean> {
    if (typeof source !== "string") return source.isLive;
    if (source === LIVE_ID) return true;
    return (await this.api.listVideos(options)).videos.some((s) => s.id === source && s.isLive);
  }

  /**
   * Moves the shared playhead to `t` seconds (a new run for every viewer, unless `dryRun`). A live camera cannot be
   * seeked; pause and play instead. Without `video`, the SDK reads the shared state first (`GET /session`: another
   * viewer may have switched the session since this client last looked), and when it shows a camera it refuses the seek
   * locally (`not_seekable`, field `video`) without sending it. With the id of a recording in `video`, it sends the
   * seek in that recording without reading the state. The unit refuses a seek whose video is a camera (409
   * `not_seekable`): one naming a camera, or one without `video` that races another viewer's switch to a camera. A seek
   * naming a recording is applied even while a camera shows, and moves every viewer to that recording.
   */
  async seek(t: number, options: { video?: string } & ControlParams = {}): Promise<State> {
    if (options.video === LIVE_ID || (options.video === undefined && isLiveState(await this.state(options)))) {
      throw notSeekable("a live camera cannot be seeked; pause and play instead", "video");
    }
    const body = options.video === undefined ? { time: t } : { time: t, video: options.video };
    const control = { dryRun: options.dryRun, signal: options.signal, headers: options.headers };
    return this.reply(await this.api.sessionSeek(body, control), options.dryRun);
  }

  /**
   * Pauses the shared playhead for every viewer (on a live camera: freezes the shared view and stops the interpreter),
   * unless `dryRun`.
   */
  async pause(options: ControlParams = {}): Promise<State> {
    return this.reply(await this.api.sessionPause(options), options.dryRun);
  }

  /**
   * Resumes the shared playhead for every viewer (on a live camera: at the live edge, after a new warm-up; `g` jumps
   * over the pause), unless `dryRun`.
   */
  async play(options: ControlParams = {}): Promise<State> {
    return this.reply(await this.api.sessionPlay(options), options.dryRun);
  }

  /**
   * Waits until the session's camera shows live frames (`state.live.phase` is `live`) and returns that state.
   *
   * After `watch(camera)` the session is `connecting` until the camera's first frame, then `warming` while the
   * interpreter runs on its first `hold` seconds (3 on the plant cameras; nothing is released meanwhile), then `live`;
   * after `play()`, and when a playing camera sent no frame for 5 s, it is `connecting` again until a new warm-up ends.
   * This reads the shared state at most every {@link UNTIL_LIVE_POLL_MS} ms on the client's clock and sends no control;
   * on a recording, and on a paused camera that was live (a pause keeps the phase), it returns the state at once. The
   * unit interprets only while someone watches: an open stream (the interpreter's), the page, or for 15 s the address
   * that sent a control that is not a dry run (its worker idles 20 s after the last). A `watch()` that is not a dry run
   * counts, so `watch()` then `untilLive()` goes live on a unit nobody else watches, while a camera session nobody
   * watches stays `connecting` (the worker's reason: `nobody is watching`). After `timeout` ms (default 30 000) it
   * rejects with `live_timeout`, with the phase it saw last in the message (the worker's reason in
   * `factory.api.getSession()` says why: nobody watching, or a camera that does not answer).
   */
  async untilLive(options: { timeout?: number } & RequestOptions = {}): Promise<State> {
    const timeout = options.timeout ?? 30_000;
    const deadline = this.clockSource.now() + timeout;
    for (;;) {
      const state = await this.state(options);
      if (state.live === undefined || state.live === null || state.live.phase === "live") return state;
      const left = deadline - this.clockSource.now();
      if (left <= 0) {
        throw new FactoryError({
          code: "live_timeout",
          message: `${state.video} is still ${state.live.phase} after ${timeout / 1000} s`,
        });
      }
      await this.clockSource.sleep(Math.min(UNTIL_LIVE_POLL_MS, left), options.signal);
    }
  }

  /**
   * The camera picture live frame `g` (the newest by default) was interpreted from: `{ g, jpeg }`. Draw a frame's
   * layers over its own picture: `await factory.session.picture(frame.g)`. The newest 64 are kept (older:
   * `not_retained`); a recording has none (`not_found`); `session` refuses a frame of an ended session (`session_gone`).
   */
  picture(g: number | "latest" = "latest", options: { session?: number } & RequestOptions = {}): Promise<Picture> {
    return this.api.getFramePicture(g, options);
  }

  /** Highlights a stone for every viewer, unless `dryRun`. */
  async focus(stoneId: number, options: { g?: number; session?: number } & ControlParams = {}): Promise<State> {
    return this.reply(await this.api.putFocus(stoneId, options), options.dryRun);
  }

  /** Clears the highlight for every viewer, unless `dryRun`. */
  async clearFocus(options: ControlParams = {}): Promise<State> {
    return this.reply(await this.api.deleteFocus(options), options.dryRun);
  }
}
