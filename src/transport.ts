/**
 * HTTP transport (SDK-DESIGN.md section 2.1): timeouts, retries with full-jitter backoff, typed errors. Every request of
 * the SDK goes through one {@link Transport}; it uses an injectable `fetch`, which is how tests run without a network.
 *
 * @module
 */
import { FactoryError } from "./errors.js";
import { abortReason, linkSignals, throwIfAborted, type LinkedController } from "./internal/abort.js";
import { systemClock, type Clock } from "./internal/clock.js";
import type { ApiError } from "./models.js";
import { USER_AGENT } from "./version.js";

/** A `fetch` implementation: the global one, or a fake (see `pdigger-factory-sdk/testing`). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Retry backoff: `delay = random() * min(maxMs, baseMs * factor^attempt)` (full jitter). */
export interface BackoffOptions {
  /** Default 250 ms. */
  baseMs?: number;
  /** Default 2. */
  factor?: number;
  /** Default 5000 ms. */
  maxMs?: number;
}

/** Options of a {@link Transport} (and of a `FactoryClient`). */
export interface TransportOptions {
  /** Base URL of the unit, e.g. `http://factory-orin.local:8120`; in a browser also `""` or `/` (same origin). */
  baseUrl: string;
  /** The fetch to use (default: the global fetch). */
  fetch?: FetchLike;
  /**
   * Time for a whole request, headers and body (default 10 s). Streams use `connectTimeoutMs` only. Like fetch's own
   * timeouts it runs on a real timer (`setTimeout`), not on `clock`.
   */
  timeoutMs?: number;
  /** Time until the response headers arrive (default 5 s): fetch has no separate connect phase. A real timer too. */
  connectTimeoutMs?: number;
  /** Retries after the first attempt (default 3). */
  retries?: number;
  backoff?: BackoffOptions;
  /** Random source in [0, 1) for the jitter (default `Math.random`; tests pass `seededRandom(seed)`). */
  random?: () => number;
  /**
   * Clock of every wait of the SDK but the request timeouts: backoff, backfill, the streams' `maxS` and idle watchdog,
   * `waitFor` timeouts (default the system clock). Tests pass `ManualClock` or `InstantClock`.
   */
  clock?: Clock;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Bearer token (`Authorization: Bearer <token>`); 20.20 ignores it, a deployment may require it. */
  token?: string;
  /** Appended to the user agent `pdigger-factory-sdk-ts/<version>`. */
  userAgentSuffix?: string;
}

/** Query parameters; `undefined` and `null` are left out, arrays are joined with commas, booleans are `1`/`0`. */
export type Query = Record<string, string | number | boolean | null | undefined | readonly string[]>;

/** HTTP methods the API uses. */
export type Method = "GET" | "HEAD" | "POST" | "PUT" | "DELETE";

/** Per-request options every API method takes. */
export interface RequestOptions {
  /** Cancels the request (and closes the connection). */
  signal?: AbortSignal;
  /** Extra headers for this request. */
  headers?: Record<string, string>;
  /** Overrides the client's `timeoutMs` for this request. */
  timeoutMs?: number;
  /** Overrides the client's `retries` for this request (0: one attempt). */
  retries?: number;
}

/** One request. */
export interface RequestSpec extends RequestOptions {
  method: Method;
  path: string;
  query?: Query;
  /** JSON-encoded when defined. */
  body?: unknown;
  accept?: string;
  /** Statuses besides 2xx that are a success (e.g. 304). */
  okStatus?: readonly number[];
}

/** An open streaming response: read `body`, then `close()` (also when done) to release the connection. */
export interface StreamHandle {
  readonly response: Response;
  readonly body: ReadableStream<Uint8Array>;
  /** Aborted when the stream is closed or the caller's signal aborts. */
  readonly signal: AbortSignal;
  /** Aborts the request and releases the signal listeners. Idempotent. */
  close(): void;
}

const IDEMPOTENT = new Set<Method>(["GET", "HEAD"]);
const RETRY_IDEMPOTENT = new Set([502, 503, 504]);
const STATUS_CODES: Record<number, string> = {
  400: "invalid_param",
  403: "cross_origin",
  404: "not_found",
  405: "method_not_allowed",
  413: "body_too_large",
  415: "json_only",
  416: "invalid_param", // a range not satisfiable (an empty reply; `Content-Range` gives the size)
  429: "too_many_requests",
  503: "not_ready",
};

/**
 * The code of an error reply that does not carry the API's JSON error body (the empty 416 of `getVideoMedia`, a
 * proxy's page), the same in every SDK: 400 and 416 `invalid_param`, 403 `cross_origin`, 404 `not_found`, 405
 * `method_not_allowed`, 413 `body_too_large`, 415 `json_only`, 429 `too_many_requests`, 503 `not_ready`, any other
 * 5xx `internal`, anything else `decode`.
 */
export function codeOfStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 && status <= 599 ? "internal" : "decode");
}

function isApiErrorBody(v: unknown): v is ApiError {
  return typeof v === "object" && v !== null && typeof (v as { code?: unknown }).code === "string";
}

/** The `Retry-After` header in ms (seconds, or an HTTP date relative to `nowMs`), or null. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === "") return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** The {@link FactoryError} of a non-success reply (reads the body). */
export async function errorFromResponse(res: Response, nowMs = Date.now()): Promise<FactoryError> {
  const text = await res.text().catch(() => "");
  let body: unknown;
  try {
    body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    body = undefined;
  }
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"), nowMs);
  if (isApiErrorBody(body)) {
    return new FactoryError({
      status: res.status,
      code: body.code,
      message: typeof body.error === "string" ? body.error : body.code,
      field: body.field,
      retryMs: typeof body.retry_ms === "number" ? body.retry_ms : retryAfter,
      retained: body.retained,
      waiting: body.waiting,
      body,
      headers: res.headers,
    });
  }
  return new FactoryError({
    status: res.status,
    code: codeOfStatus(res.status),
    message: `HTTP ${res.status}${text.length > 0 ? `: ${text.slice(0, 200)}` : ""}`,
    field: res.status === 416 ? "range" : null,
    retryMs: retryAfter,
    body: text.length > 0 ? text : undefined,
    headers: res.headers,
  });
}

/** Resolves the base URL; a relative one (browsers) is resolved against the page. */
function resolveBase(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    const here = (globalThis as { location?: { href?: string } }).location?.href;
    if (here === undefined) throw new TypeError(`base URL ${JSON.stringify(baseUrl)} is not absolute`);
    return new URL(baseUrl === "" ? "/" : baseUrl, here);
  }
}

/** The HTTP layer of a client. */
export class Transport {
  readonly baseUrl: string;
  readonly clock: Clock;
  readonly random: () => number;
  readonly retries: number;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: URL;
  private readonly headers: Record<string, string>;
  private readonly token: string | undefined;
  private readonly backoff: Required<BackoffOptions>;

  constructor(options: TransportOptions) {
    this.base = resolveBase(options.baseUrl);
    this.baseUrl = this.base.href.replace(/\/+$/, "");
    const f = options.fetch;
    this.fetchImpl = f ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.retries = Math.max(0, options.retries ?? 3);
    this.backoff = {
      baseMs: options.backoff?.baseMs ?? 250,
      factor: options.backoff?.factor ?? 2,
      maxMs: options.backoff?.maxMs ?? 5_000,
    };
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? systemClock;
    this.headers = { ...(options.headers ?? {}) };
    this.token = options.token;
    this.userAgent = options.userAgentSuffix ? `${USER_AGENT} ${options.userAgentSuffix}` : USER_AGENT;
  }

  /** The delay before retry number `attempt` (0-based), full jitter. */
  backoffDelay(attempt: number): number {
    const { baseMs, factor, maxMs } = this.backoff;
    // base 0 gives 0 at every attempt: 0 * factor ** attempt would be 0 * Infinity = NaN once the power overflows
    const cap = baseMs === 0 ? 0 : Math.min(maxMs, baseMs * factor ** attempt);
    return this.random() * cap;
  }

  /** The absolute URL of a path with a query. */
  url(path: string, query?: Query): string {
    const u = new URL(this.base.href);
    u.pathname = `${u.pathname.replace(/\/+$/, "")}${path}`;
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) u.searchParams.set(k, v.join(","));
        else if (typeof v === "boolean") u.searchParams.set(k, v ? "1" : "0");
        else u.searchParams.set(k, String(v as string | number));
      }
    }
    return u.href;
  }

  private headersFor(spec: RequestSpec): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": this.userAgent, Accept: spec.accept ?? "application/json" };
    Object.assign(h, this.headers);
    if (this.token !== undefined) h.Authorization = `Bearer ${this.token}`;
    if (spec.body !== undefined) h["Content-Type"] = "application/json";
    Object.assign(h, spec.headers ?? {});
    return h;
  }

  private isOk(res: Response, spec: RequestSpec): boolean {
    return (res.status >= 200 && res.status < 300) || (spec.okStatus ?? []).includes(res.status);
  }

  private failure(cause: unknown, spec: RequestSpec, timedOut: boolean, timeoutMs: number): unknown {
    if (spec.signal?.aborted) return abortReason(spec.signal);
    if (cause instanceof FactoryError) return cause;
    const what = `${spec.method} ${spec.path}`;
    if (timedOut)
      return new FactoryError({ code: "transport", message: `${what} timed out after ${timeoutMs} ms`, cause });
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new FactoryError({ code: "transport", message: `${what} failed: ${detail}`, cause });
  }

  /** Runs `attempt` with the retry policy of section 2.1. */
  private async withRetries<T>(spec: RequestSpec, attempt: () => Promise<T>): Promise<T> {
    const idempotent = IDEMPOTENT.has(spec.method);
    const retries = Math.max(0, spec.retries ?? this.retries);
    let error: FactoryError | null = null;
    let n = 0;
    do {
      if (error !== null) await this.clock.sleep(error.retryMs ?? this.backoffDelay(n - 1), spec.signal);
      throwIfAborted(spec.signal);
      try {
        return await attempt();
      } catch (err) {
        if (!(err instanceof FactoryError)) throw err;
        error = err;
      }
      const retryable =
        error.code === "transport"
          ? idempotent
          : error.status === 429 || (idempotent && error.status !== null && RETRY_IDEMPOTENT.has(error.status));
      if (!retryable) throw error;
    } while (++n <= retries);
    throw error;
  }

  /** One exchange under a timeout: fetch, check the status, read the body with `read`. */
  private async once<T>(spec: RequestSpec, read: (res: Response) => Promise<T>): Promise<T> {
    const timeoutMs = spec.timeoutMs ?? this.timeoutMs;
    const link = linkSignals(spec.signal);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      link.abort(new DOMException(`timed out after ${timeoutMs} ms`, "TimeoutError"));
    }, timeoutMs);
    let result: T;
    try {
      const res = await this.fetchImpl(this.url(spec.path, spec.query), {
        method: spec.method,
        headers: this.headersFor(spec),
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: link.signal,
      });
      if (!this.isOk(res, spec)) throw await errorFromResponse(res, this.clock.now());
      result = await read(res);
    } catch (err) {
      throw this.failure(err, spec, timedOut, timeoutMs);
    } finally {
      clearTimeout(timer);
      link.dispose();
    }
    return result;
  }

  /** A request whose body is read by `read`, with retries. */
  request<T>(spec: RequestSpec, read: (res: Response) => Promise<T>): Promise<T> {
    return this.withRetries(spec, () => this.once(spec, read));
  }

  /** The JSON of a reply's body; a `decode` error (with the reply's status) when it is not JSON or not an object. */
  private async parse<T>(spec: RequestSpec, res: Response, object: boolean): Promise<T> {
    const text = await res.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new FactoryError({
        code: "decode",
        status: res.status,
        message: `${spec.method} ${spec.path}: the reply is not JSON`,
        cause,
        body: text.slice(0, 200),
      });
    }
    if (object && (typeof value !== "object" || value === null || Array.isArray(value))) {
      throw new FactoryError({
        code: "decode",
        status: res.status,
        message: `${spec.method} ${spec.path}: the reply is not a JSON object`,
        body: text.slice(0, 200),
      });
    }
    return value as T;
  }

  /** A JSON request. */
  json<T>(spec: RequestSpec): Promise<T> {
    return this.request(spec, (res) => this.parse<T>(spec, res, false));
  }

  /** A JSON object request: a reply that is not a JSON object is a `decode` error. */
  object<T>(spec: RequestSpec): Promise<T> {
    return this.request(spec, (res) => this.parse<T>(spec, res, true));
  }

  /** A text request. */
  text(spec: RequestSpec): Promise<string> {
    return this.request(spec, (res) => res.text());
  }

  /** A binary request: the bytes and the response (for its headers). */
  bytes(spec: RequestSpec): Promise<{ bytes: Uint8Array; response: Response }> {
    return this.request(spec, async (res) => ({ bytes: new Uint8Array(await res.arrayBuffer()), response: res }));
  }

  /**
   * Opens a streaming response (SSE, NDJSON): only the connect timeout applies, and the connection stays open until
   * `close()` or the caller's signal aborts. Retried like any GET until the headers arrive.
   */
  stream(spec: RequestSpec): Promise<StreamHandle> {
    return this.withRetries(spec, () => this.openOnce(spec));
  }

  private async openOnce(spec: RequestSpec): Promise<StreamHandle> {
    const timeoutMs = this.connectTimeoutMs;
    const link: LinkedController = linkSignals(spec.signal);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      link.abort(new DOMException(`no reply after ${timeoutMs} ms`, "TimeoutError"));
    }, timeoutMs);
    const close = (): void => {
      clearTimeout(timer);
      if (!link.signal.aborted) link.abort(new DOMException("stream closed", "AbortError"));
      link.dispose();
    };
    try {
      const res = await this.fetchImpl(this.url(spec.path, spec.query), {
        method: spec.method,
        headers: this.headersFor(spec),
        signal: link.signal,
      });
      clearTimeout(timer);
      if (!this.isOk(res, spec)) throw await errorFromResponse(res, this.clock.now());
      if (res.body === null) {
        throw new FactoryError({ code: "decode", status: res.status, message: `${spec.path}: the stream has no body` });
      }
      return { response: res, body: res.body, signal: link.signal, close };
    } catch (err) {
      close();
      throw this.failure(err, spec, timedOut, timeoutMs);
    }
  }
}
