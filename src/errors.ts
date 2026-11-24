/**
 * The one error type of the SDK: every failure of a request, a stream or a decoder is a {@link FactoryError} carrying
 * the API's stable `code` (or one of the SDK-only codes). Key your code on `code`, never on `message`.
 *
 * @module
 */
import type { ApiErrorCode, Retained } from "./models.js";

/**
 * Codes the SDK adds to the API's: no HTTP reply, an undocumented reply, no live camera, a camera that did not go live
 * in time (`session.untilLive`), a stream that ended.
 */
export type SdkErrorCode = "transport" | "decode" | "live_unavailable" | "live_timeout" | "stream_closed";

/** Every code a {@link FactoryError} can carry. Unknown future server codes pass through as strings. */
export type ErrorCode = ApiErrorCode | SdkErrorCode | (string & Record<never, never>);

/** What a {@link FactoryError} is made of. */
export interface FactoryErrorInit {
  /** The API's stable code, or an SDK-only code. */
  code: ErrorCode;
  /** Human-readable (the API's `error`). */
  message: string;
  /** HTTP status, or null when there was no HTTP reply (or the error was raised locally). */
  status?: number | null;
  /** The parameter or body field at fault. */
  field?: string | null;
  /** How long the server asks to wait before retrying, in ms. */
  retryMs?: number | null;
  /** The retained window (on `not_retained`). */
  retained?: Retained | null;
  /** What readiness is waiting for (on `not_ready`). */
  waiting?: string[] | null;
  /** The parsed error body, when there was one. */
  body?: unknown;
  /** The error reply's HTTP headers, when there was a reply. */
  headers?: Headers | null;
  /** The underlying error. */
  cause?: unknown;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** The error of every SDK call. */
export class FactoryError extends Error {
  override readonly name = "FactoryError";
  /**
   * The API's stable code, or an SDK-only code (`transport`, `decode`, `live_unavailable`, `live_timeout`,
   * `stream_closed`).
   */
  readonly code: ErrorCode;
  /** HTTP status, or null without an HTTP reply. */
  readonly status: number | null;
  /** The parameter or body field at fault. */
  readonly field: string | null;
  /** How long the server asks to wait before retrying, in ms. */
  readonly retryMs: number | null;
  /** The retained window (on `not_retained`). */
  readonly retained: Retained | null;
  /** What readiness is waiting for (on `not_ready`). */
  readonly waiting: string[] | null;
  /** The parsed error body, when there was one. */
  readonly body: unknown;
  /**
   * The error reply's HTTP headers, when there was a reply (`Retry-After`, `X-Interp-Build`; on a 416 of
   * `getVideoMedia` the `Content-Range` with the file's size).
   */
  readonly headers: Headers | null;

  constructor(init: FactoryErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status ?? null;
    this.field = init.field ?? null;
    this.retryMs = init.retryMs ?? null;
    this.retained = init.retained ?? null;
    this.waiting = init.waiting ?? null;
    this.body = init.body;
    this.headers = init.headers ?? null;
  }

  /** True for errors a retry can cure: no HTTP reply, 429, 502, 503, 504. */
  isRetryable(): boolean {
    return this.code === "transport" || (this.status !== null && RETRYABLE_STATUS.has(this.status));
  }

  /** True when the frame asked for is outside the retained window (`not_retained`). */
  isNotRetained(): boolean {
    return this.code === "not_retained";
  }

  /** True when the session named by the request has ended (`session_gone`, or `stale_session` for a focus). */
  isSessionGone(): boolean {
    return this.code === "session_gone" || this.code === "stale_session";
  }

  /** The error as a plain object (for logs). */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      field: this.field,
      retryMs: this.retryMs,
      retained: this.retained,
      waiting: this.waiting,
    };
  }
}

/** True when `err` is a {@link FactoryError} (with the given code, when one is given). */
export function isFactoryError(err: unknown, code?: ErrorCode): err is FactoryError {
  return err instanceof FactoryError && (code === undefined || err.code === code);
}
