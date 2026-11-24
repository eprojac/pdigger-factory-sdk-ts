/**
 * Replay (SDK-DESIGN.md section 2.5): the same Interpreter over a recording file (`pfr1`), offline. Open a local file
 * or an HTTP(S) URL (streamed, not loaded whole), or give bytes or text. Every iteration is a fresh pass with a fresh
 * {@link InterpreterCore}; `pace: "realtime"` sleeps so frames come at their media times.
 *
 * @module
 */
import { abortReason, throwIfAborted } from "./internal/abort.js";
import { textLines } from "./internal/bytes.js";
import { systemClock, type Clock } from "./internal/clock.js";
import { InterpreterCore, type InterpreterCoreOptions } from "./interpreter/core.js";
import type { Summary } from "./interpreter/summary.js";
import type { Tray, TrayFact, TrayReport } from "./interpreter/trays.js";
import type { Activity, FactoryEvent, Update } from "./interpreter/types.js";
import type { Frame } from "./models.js";
import {
  classifyLine,
  linesOfBytes,
  parseLine,
  readLines,
  type ReadOptions,
  type RecordingHeader,
  type RecordingSource,
} from "./recording.js";

/** Options to open a replay. */
export interface ReplayOpenOptions extends ReadOptions {
  core?: InterpreterCoreOptions;
}

/** Options of a pass. */
export interface ReplayPassOptions {
  /** `none` (default): as fast as it reads. `realtime`: frames at their media times (divided by `speed`). */
  pace?: "none" | "realtime";
  /** Real-time speed factor (default 1.0). */
  speed?: number;
  /** Clock for the pacing (default the system clock). */
  clock?: Clock;
  signal?: AbortSignal;
}

type LineSource =
  | { kind: "memory"; lines: readonly (string | object)[] }
  | { kind: "stream"; source: RecordingSource }
  | { kind: "once" };

/** A line that is not JSON: no line kind, but a line all the same (the first line is the header only if it is one). */
const NOT_JSON: unique symbol = Symbol("not JSON");

/** The JSON value of a line (an object given as it is), {@link NOT_JSON} for one that is not JSON, undefined for a
 * blank line. */
function valueOf(line: string | object): unknown {
  if (typeof line !== "string") return line;
  if (line.trim().length === 0) return undefined;
  const v = parseLine(line);
  return v === undefined ? NOT_JSON : v;
}

/** A line that is not blank, and whether it is the first such line of the recording (the only one a header can be). */
interface Entry {
  value: unknown;
  first: boolean;
}

/** One pass over the lines, feeding a core: the logic of the reference reader. */
class Pass {
  readonly core: InterpreterCore;
  header: RecordingHeader | null = null;

  constructor(options: InterpreterCoreOptions | undefined) {
    this.core = new InterpreterCore(options);
  }

  /** The update of a frame line (null for other lines and dropped duplicates), and the frame. */
  line({ value, first }: Entry): { update: Update | null; frame: Frame | null } {
    const line = classifyLine(value, !first);
    switch (line.kind) {
      case "header":
        this.header = line.header;
        return { update: null, frame: null };
      case "side":
        // a side line that decodes: a clock line's data is a clock state (2.3 rule 9); at a gap or reset line the
        // stream dropped frames, which the tray rules count (4.6.1)
        if (line.side.sse === "clock")
          this.core.setClock(line.side.data as { anchor_wall: number; anchor_media: number });
        else if (line.side.sse === "gap" || line.side.sse === "reset") this.core.gap();
        return { update: null, frame: null };
      case "frame": {
        const u = this.core.feed(line.frame);
        return { update: u.isDuplicate ? null : u, frame: line.frame };
      }
      default:
        return { update: null, frame: null };
    }
  }

  /** The final update: what `end()` closed and the facts of the open tray leaving. */
  finish(): Update {
    return this.core.end();
  }
}

/** Waits so that frames come at their media times. */
class Pacer {
  private anchorWall = 0;
  private anchorT = 0;
  private session: number | null | undefined = undefined;

  constructor(
    private readonly clock: Clock,
    private readonly speed: number,
  ) {}

  async wait(frame: Frame, signal: AbortSignal | undefined): Promise<void> {
    if (this.session === undefined || frame.session !== this.session) {
      this.session = frame.session;
      this.anchorWall = this.clock.now();
      this.anchorT = frame.t;
      return;
    }
    const target = this.anchorWall + ((frame.t - this.anchorT) / this.speed) * 1000;
    const delay = target - this.clock.now();
    if (delay > 0) await this.clock.sleep(delay, signal);
  }
}

/** A recording, replayed through the Interpreter. */
export class Replay {
  private lastCore: InterpreterCore | null = null;
  private completed: Summary | null = null;
  private pendingFirst: AsyncGenerator<string> | null;

  private constructor(
    private readonly src: LineSource,
    /** The recording header (line 1), or null when the recording has none. */
    readonly header: RecordingHeader | null,
    first: AsyncGenerator<string> | null,
    private readonly options: ReplayOpenOptions,
  ) {
    this.pendingFirst = first;
  }

  /**
   * Opens a recording: a local path (Node, Deno, Bun), an HTTP(S) URL (or a relative URL in a browser), bytes, or a
   * byte stream; `.ndjson` or `.ndjson.gz` (gzip is detected by its magic). Reads the header now and streams the rest:
   * the decompressed text is never in memory as a whole, and bytes you hold are decompressed in pieces too, without
   * blocking the event loop. A path, URL or bytes can be replayed again; a byte stream once.
   */
  static async open(source: RecordingSource, options: ReplayOpenOptions = {}): Promise<Replay> {
    const lines = readLines(source, options);
    let header: RecordingHeader | null = null;
    const head: string[] = [];
    for (;;) {
      const r = await lines.next();
      if (r.done) break;
      head.push(r.value);
      const v = valueOf(r.value);
      if (v === undefined) continue;
      const c = classifyLine(v, false);
      if (c.kind === "header") header = c.header;
      break;
    }
    const first = (async function* () {
      yield* head;
      yield* lines;
    })();
    const reopenable =
      typeof source === "string" ||
      source instanceof URL ||
      source instanceof Uint8Array ||
      source instanceof ArrayBuffer;
    return new Replay(reopenable ? { kind: "stream", source } : { kind: "once" }, header, first, options);
  }

  /** Reads a whole recording into memory, so that the `...Sync` methods work too. */
  static async load(source: RecordingSource, options: ReplayOpenOptions = {}): Promise<Replay> {
    const lines: string[] = [];
    for await (const line of readLines(source, options)) lines.push(line);
    return Replay.fromLines(lines, options);
  }

  /**
   * A replay of recording bytes (gzip or not), in memory, so that the `...Sync` methods work. It inflates and splits
   * the whole recording now, synchronously, with the built-in inflater (about 15 MB/s): for small recordings. For large
   * ones, `Replay.open(bytes)` streams instead.
   */
  static fromBytes(bytes: Uint8Array, options: ReplayOpenOptions = {}): Replay {
    return Replay.fromLines([...linesOfBytes(bytes)], options);
  }

  /** A replay of recording text (NDJSON). */
  static fromText(text: string, options: ReplayOpenOptions = {}): Replay {
    return Replay.fromLines([...textLines(text)], options);
  }

  /** A replay of lines: NDJSON strings, or objects already parsed (header, frames, side events). */
  static fromLines(lines: Iterable<string | object>, options: ReplayOpenOptions = {}): Replay {
    const all = [...lines];
    let header: RecordingHeader | null = null;
    for (const l of all) {
      const v = valueOf(l);
      if (v === undefined) continue;
      const c = classifyLine(v, false);
      if (c.kind === "header") header = c.header;
      break;
    }
    return new Replay({ kind: "memory", lines: all }, header, null, options);
  }

  /** True when the recording is in memory (the `...Sync` methods work). */
  get inMemory(): boolean {
    return this.src.kind === "memory" && this.pendingFirst === null;
  }

  /** The core of the newest pass (its state and summary), or null before the first pass. */
  get core(): InterpreterCore | null {
    return this.lastCore;
  }

  private async *lines(signal: AbortSignal | undefined): AsyncGenerator<Entry> {
    const first = this.pendingFirst;
    this.pendingFirst = null;
    let it: AsyncIterable<string | object>;
    if (first !== null) it = first;
    else if (this.src.kind === "memory") it = toAsync(this.src.lines);
    else if (this.src.kind === "stream") it = readLines(this.src.source, { ...this.options, signal });
    else
      throw new TypeError("this replay reads a stream, which can be read once: use Replay.load() to replay it again");
    let isFirst = true;
    for await (const l of it) {
      throwIfAborted(signal);
      const value = valueOf(l);
      if (value === undefined) continue;
      yield { value, first: isFirst };
      isFirst = false;
    }
  }

  private *linesSync(): Generator<Entry> {
    if (!this.inMemory) {
      throw new TypeError(
        "this replay streams its recording: use the async methods, or Replay.load(), fromBytes(), fromText() or fromLines()",
      );
    }
    let first = true;
    for (const l of (this.src as { lines: readonly (string | object)[] }).lines) {
      const value = valueOf(l);
      if (value === undefined) continue;
      yield { value, first };
      first = false;
    }
  }

  /** Every frame of the recording, as recorded (revisions and duplicates included). */
  async *frames(options: ReplayPassOptions = {}): AsyncGenerator<Frame> {
    const pacer = options.pace === "realtime" ? new Pacer(options.clock ?? systemClock, options.speed ?? 1) : null;
    for await (const { value, first } of this.lines(options.signal)) {
      const c = classifyLine(value, !first); // the first line is the header's candidate, as in every pass
      if (c.kind !== "frame") continue;
      if (pacer) await pacer.wait(c.frame, options.signal);
      yield c.frame;
    }
  }

  /**
   * The updates of a fresh pass, then a final update (`isFinal`, `frame` null) with what `end()` closed and the facts
   * of the last tray leaving.
   */
  async *updates(options: ReplayPassOptions = {}): AsyncGenerator<Update> {
    yield* this.pass(options, new Pass(this.options.core));
  }

  private async *pass(options: ReplayPassOptions, pass: Pass): AsyncGenerator<Update> {
    this.lastCore = pass.core;
    const pacer = options.pace === "realtime" ? new Pacer(options.clock ?? systemClock, options.speed ?? 1) : null;
    for await (const entry of this.lines(options.signal)) {
      const { update, frame } = pass.line(entry);
      if (frame !== null && pacer !== null) await pacer.wait(frame, options.signal);
      if (update !== null) yield update;
    }
    if (options.signal?.aborted) throw abortReason(options.signal);
    const final = pass.finish();
    this.completed = pass.core.summary();
    yield final;
  }

  /** The events of a fresh pass. */
  async *events(options: ReplayPassOptions = {}): AsyncGenerator<FactoryEvent> {
    for await (const u of this.updates(options)) yield* u.events;
  }

  /** The activities of a fresh pass, including those `end()` closes at the end. */
  async *activities(options: ReplayPassOptions = {}): AsyncGenerator<Activity> {
    for await (const u of this.updates(options)) yield* u.activities;
  }

  /**
   * The tray facts of a fresh pass (section 4.6), the last tray's leaving included: trays arriving and leaving, tray
   * stones removed, set down or no longer sure, each named by the SDK's own id, which no other stone ever gets.
   */
  async *trayFacts(options: ReplayPassOptions = {}): AsyncGenerator<TrayFact> {
    for await (const u of this.updates(options)) yield* u.trayFacts;
  }

  /**
   * Every tray of the recording (a pass now that keeps them all), oldest first: each with its `arrived` and `leaving`
   * points, the span to replay or show (`tray.window()`), its tray stones and its facts.
   */
  async trays(options: Omit<ReplayPassOptions, "pace" | "speed" | "clock"> = {}): Promise<Tray[]> {
    const pass = new Pass({ ...this.options.core, traysKept: 0 }); // its own pass: another one cannot replace it
    for await (const u of this.pass(options, pass)) void u;
    return pass.core.trays();
  }

  /**
   * The report of every tray that arrived, oldest first (a pass now; section 4.7): which stones were removed, added and
   * moved, and whether that is the tray's whole account.
   */
  async trayReports(options: Omit<ReplayPassOptions, "pace" | "speed" | "clock"> = {}): Promise<TrayReport[]> {
    const reports: TrayReport[] = [];
    for (const tray of await this.trays(options)) {
      const r = tray.report();
      if (r !== null) reports.push(r);
    }
    return reports;
  }

  /** The summary of the whole recording (the last complete pass's, else a pass now). */
  async summary(options: Omit<ReplayPassOptions, "pace" | "speed" | "clock"> = {}): Promise<Summary> {
    if (this.completed === null) for await (const u of this.updates(options)) void u;
    return this.completed as unknown as Summary;
  }

  /** Every frame, synchronously (in-memory replays). */
  *framesSync(): Generator<Frame> {
    for (const { value, first } of this.linesSync()) {
      const c = classifyLine(value, !first);
      if (c.kind === "frame") yield c.frame;
    }
  }

  /** The updates of a fresh pass, synchronously (in-memory replays). */
  *updatesSync(): Generator<Update> {
    yield* this.passSync(new Pass(this.options.core));
  }

  private *passSync(pass: Pass): Generator<Update> {
    const lines = this.linesSync();
    this.lastCore = pass.core;
    for (const entry of lines) {
      const { update } = pass.line(entry);
      if (update !== null) yield update;
    }
    const final = pass.finish();
    this.completed = pass.core.summary();
    yield final;
  }

  /** The events of a fresh pass, synchronously. */
  *eventsSync(): Generator<FactoryEvent> {
    for (const u of this.updatesSync()) yield* u.events;
  }

  /** The activities of a fresh pass, synchronously. */
  *activitiesSync(): Generator<Activity> {
    for (const u of this.updatesSync()) yield* u.activities;
  }

  /** The tray facts of a fresh pass, synchronously. */
  *trayFactsSync(): Generator<TrayFact> {
    for (const u of this.updatesSync()) yield* u.trayFacts;
  }

  /** Every tray of the recording, synchronously (a pass now that keeps them all). */
  traysSync(): Tray[] {
    const pass = new Pass({ ...this.options.core, traysKept: 0 });
    for (const u of this.passSync(pass)) void u;
    return pass.core.trays();
  }

  /** The report of every tray that arrived, synchronously (section 4.7). */
  trayReportsSync(): TrayReport[] {
    const reports: TrayReport[] = [];
    for (const tray of this.traysSync()) {
      const r = tray.report();
      if (r !== null) reports.push(r);
    }
    return reports;
  }

  /** The summary of the whole recording, synchronously. */
  summarySync(): Summary {
    if (this.completed === null) for (const u of this.updatesSync()) void u;
    return this.completed as unknown as Summary;
  }
}

async function* toAsync<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const x of items) yield x;
}
