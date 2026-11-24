/**
 * The client: one base URL, one transport, and the five layers on top of it.
 *
 * @module
 */
import { Api } from "./api.js";
import { FactoryError } from "./errors.js";
import { Interpreter, type InterpreterOptions } from "./interpreter/interpreter.js";
import { Session } from "./session.js";
import { LIVE_ID, type Source } from "./sources.js";
import { Streams } from "./streams.js";
import { Transport, type RequestOptions, type TransportOptions } from "./transport.js";

/** Options of a {@link FactoryClient}: the transport's, plus the defaults of its streams. */
export interface ClientOptions extends Omit<TransportOptions, "baseUrl"> {
  /** Default of `observe` for streams and Interpreters (default false: a stream counts as a viewer). */
  observe?: boolean;
  /**
   * Default of the streams' `idleTimeoutMs` (default 30 s): a connection that has sent something and then nothing for
   * this long (checked once per period: one to two periods after its last byte) is closed and resumed. 0 turns the
   * watchdog off. It runs on `clock`.
   */
  idleTimeoutMs?: number;
}

/** The URL of the docs' unit. */
export const DEFAULT_URL = "http://factory-orin.local:8120";

/**
 * A client of one pDigger Factory unit.
 *
 * ```ts
 * const factory = new FactoryClient("http://factory-orin.local:8120");
 * for await (const ev of factory.interpreter().events()) console.log(ev.describe());
 * ```
 */
export class FactoryClient {
  /** The HTTP layer (timeouts, retries, errors). */
  readonly transport: Transport;
  /** Low level: one method per operation. */
  readonly api: Api;
  /** Mid level: frames with resume, backfill and revisions; long-poll; raw packets. */
  readonly streams: Streams;
  /** The shared session: state, clock and controls. */
  readonly session: Session;
  /** Default `observe` of streams and Interpreters. */
  readonly observe: boolean;
  /** The Interpreters whose stream is open: `close()` stops them. */
  private readonly active = new Set<Interpreter>();

  constructor(baseUrl: string, options: ClientOptions = {}) {
    this.transport = new Transport({ ...options, baseUrl });
    this.observe = options.observe ?? false;
    this.api = new Api(this.transport, { observe: this.observe });
    this.session = new Session(this.api, this.transport.clock);
    this.streams = new Streams(
      this.api,
      this.transport,
      { observe: this.observe, idleTimeoutMs: options.idleTimeoutMs },
      (state) => this.session.note(state),
    );
  }

  /** A client of `PDIGGER_FACTORY_URL` (or `fallback`). */
  static fromEnv(options: ClientOptions & { fallback?: string } = {}): FactoryClient {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const fromEnv = env?.PDIGGER_FACTORY_URL;
    const url = fromEnv !== undefined && fromEnv !== "" ? fromEnv : options.fallback;
    if (url === undefined || url === "") throw new TypeError("PDIGGER_FACTORY_URL is not set");
    return new FactoryClient(url, options);
  }

  /** The base URL. */
  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /**
   * An Interpreter following the shared session (`layers` world and cards, `observe` the client's, `backfill` true by
   * default). Iterate `updates()`, `events()` or `activities()`, or `await waitFor(...)`. The client holds it only
   * while its stream is open (until its last consumer leaves), so `await factory.interpreter().waitFor(...)` leaves
   * nothing behind.
   */
  interpreter(options: InterpreterOptions = {}): Interpreter {
    return new Interpreter(this.streams, this.api, this.transport.clock, options, (interp, active) => {
      if (active) this.active.add(interp);
      else this.active.delete(interp);
    });
  }

  /** The catalog: every source the shared session can show (the recordings, then the live cameras). */
  async sources(options?: RequestOptions): Promise<Source[]> {
    return (await this.api.listVideos(options)).videos;
  }

  /** One source by id (`"dry1"`, a camera's serial such as `"CAM00000001"`, ...). */
  source(id: string, options?: RequestOptions): Promise<Source> {
    return this.api.getVideo(id, options);
  }

  /**
   * The live cameras of the catalog (`kind: camera`), in catalog order; empty when the unit lists none. Each is a
   * source like a recording: `session.watch(camera)` selects it for the shared session, and `session.untilLive()` waits
   * out its connection and warm-up. Their ids are the camera serials.
   */
  async cameras(options?: RequestOptions): Promise<Source[]> {
    return (await this.sources(options)).filter((s) => s.isLive || s.id === LIVE_ID);
  }

  /**
   * The first live camera of the catalog, or a `live_unavailable` error when it has none. For code written for one
   * camera; a unit may list several (20.20 lists six plant cameras): prefer {@link FactoryClient.cameras}.
   */
  async live(options?: RequestOptions): Promise<Source> {
    const [first] = await this.cameras(options);
    if (first === undefined) {
      throw new FactoryError({ code: "live_unavailable", message: "the server's catalog has no live camera" });
    }
    return first;
  }

  /** Stops every Interpreter of this client whose stream is open (their iterations end). The client stays usable. */
  close(): void {
    for (const i of [...this.active]) i.close();
    this.active.clear();
  }

  /** `using factory = new FactoryClient(url)`: {@link FactoryClient.close} at the end of the block. */
  [Symbol.dispose](): void {
    this.close();
  }

  /** `await using factory = new FactoryClient(url)`: {@link FactoryClient.close} at the end of the block. */
  [Symbol.asyncDispose](): Promise<void> {
    this.close();
    return Promise.resolve();
  }
}
