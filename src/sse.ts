/**
 * Server-sent events and NDJSON on a byte stream (SDK-DESIGN.md section 2.3 rule 1): the SSE parser follows the HTML
 * spec (fields `event`, `data` joined with `\n`, `id`, `retry`; `:` comments; CRLF, LF or CR line ends; UTF-8; a BOM
 * at the start ignored). {@link EventStream} is what the low-level stream operations return.
 *
 * @module
 */
import { FactoryError } from "./errors.js";
import { MAX_LINE, byteLines, readStream, tooLarge } from "./internal/bytes.js";
import type { StreamFormat } from "./models.js";
import type { StreamHandle } from "./transport.js";

/** One event of a stream: an SSE event, or one NDJSON line (event `frame`, or `gap` for a `{"gap": n}` line). */
export class StreamEvent {
  private parsed: { value: unknown } | null;

  constructor(
    /** The SSE event type (`message` when the stream gave none). */
    readonly event: string,
    /** The data, lines joined with `\n`. */
    readonly data: string,
    /** The last event id when this event was dispatched (SSE), or null. */
    readonly id: string | null = null,
    /** The reconnection time the stream asked for, in ms, or null. */
    readonly retry: number | null = null,
    parsed?: { value: unknown },
  ) {
    this.parsed = parsed ?? null;
  }

  /** The data parsed as JSON (cached); a `decode` error when it is not JSON. */
  json<T = unknown>(): T {
    if (this.parsed === null) {
      try {
        this.parsed = { value: JSON.parse(this.data) as unknown };
      } catch (cause) {
        throw new FactoryError({ code: "decode", message: `stream event ${this.event}: data is not JSON`, cause });
      }
    }
    return this.parsed.value as T;
  }
}

/**
 * An incremental SSE parser: `push` decoded text, get the dispatched events. As in the HTML spec, an `id:` line fills
 * the id buffer, and the buffer becomes the last event id when a blank line dispatches its event: an event cut off
 * before its blank line never changes {@link SseParser.lastEventId}. The buffer starts at the id the stream resumed from.
 * A line or an event's data longer than `limit` characters ({@link MAX_LINE} by default) is a `decode` error.
 */
export class SseParser {
  private readonly limit: number;
  private buffer = "";
  private dataBuffer = "";
  private eventType = "";
  private idBuffer: string | null;
  private dispatchedId: string | null;
  private retryMs: number | null = null;
  private skipLf = false;
  private started = false;

  constructor(lastEventId: string | null = null, limit: number = MAX_LINE) {
    this.idBuffer = lastEventId;
    this.dispatchedId = lastEventId;
    this.limit = limit;
  }

  /** The id of the last dispatched event (it persists across events, as the spec says), to resume from. */
  get lastEventId(): string | null {
    return this.dispatchedId;
  }

  /** The newest `retry` value, in ms. */
  get retry(): number | null {
    return this.retryMs;
  }

  /** Feeds text; returns the events completed by it. */
  push(text: string): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (text.length === 0) return out;
    let s = text;
    if (!this.started) {
      this.started = true;
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    }
    let i = 0;
    if (this.skipLf) {
      this.skipLf = false;
      if (s.charCodeAt(0) === 10) i = 1;
    }
    let segment = i;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      const line = this.buffer + s.slice(segment, i);
      if (line.length > this.limit) throw tooLarge("a line", this.limit);
      this.line(line, out);
      this.buffer = "";
      if (c === 13) {
        if (i + 1 < s.length) {
          if (s.charCodeAt(i + 1) === 10) i++;
        } else this.skipLf = true;
      }
      segment = i + 1;
    }
    this.buffer += s.slice(segment);
    if (this.buffer.length > this.limit) throw tooLarge("a line", this.limit);
    return out;
  }

  private line(line: string, out: StreamEvent[]): void {
    if (line.length === 0) {
      this.dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ':' comment
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataBuffer += `${value}\n`;
        if (this.dataBuffer.length > this.limit) throw tooLarge("an event", this.limit);
        break;
      case "id":
        if (!value.includes("\0")) this.idBuffer = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break;
    }
  }

  private dispatch(out: StreamEvent[]): void {
    this.dispatchedId = this.idBuffer; // step 1 of the spec's dispatch, also for a blank line without data
    if (this.dataBuffer.length === 0) {
      this.eventType = "";
      return;
    }
    const data = this.dataBuffer.slice(0, -1);
    out.push(new StreamEvent(this.eventType || "message", data, this.idBuffer, this.retryMs));
    this.dataBuffer = "";
    this.eventType = "";
  }
}

export { MAX_LINE };

/** Parses an SSE byte stream into events. */
export async function* parseSse(
  chunks: AsyncIterable<Uint8Array>,
  parser: SseParser = new SseParser(),
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of chunks) {
    for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) yield ev;
  }
  // the decoder's flush cannot complete an event: events end with a blank line, so they need a newline already read
}

/** Parses an NDJSON byte stream into events: `gap` for a `{"gap": n}` line, else `frame`. Blank lines are skipped. */
export async function* parseNdjson(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<StreamEvent> {
  for await (const line of byteLines(chunks)) {
    if (line.trim().length === 0) continue;
    let parsed: { value: unknown } | undefined;
    try {
      parsed = { value: JSON.parse(line) as unknown };
    } catch {
      parsed = undefined;
    }
    const v = parsed?.value;
    const isGap = typeof v === "object" && v !== null && !Array.isArray(v) && "gap" in v && Object.keys(v).length === 1;
    yield new StreamEvent(isGap ? "gap" : "frame", line, null, null, parsed);
  }
}

/**
 * A server stream (the low-level `streamFrames` and `rawStream`): iterate it once with `for await`; `close()` (or a
 * `break`, or the request's signal) closes the connection.
 */
export class EventStream implements AsyncIterable<StreamEvent> {
  /** `sse` or `ndjson`, from the reply's content type. */
  readonly format: StreamFormat;
  private readonly parser: SseParser;
  private used = false;
  private bytes = 0;

  constructor(
    private readonly handle: StreamHandle,
    lastEventId: string | null = null,
  ) {
    const type = handle.response.headers.get("content-type") ?? "";
    this.format = type.includes("ndjson") ? "ndjson" : "sse";
    this.parser = new SseParser(lastEventId);
  }

  /** HTTP status of the reply. */
  get status(): number {
    return this.handle.response.status;
  }

  /** Headers of the reply. */
  get headers(): Headers {
    return this.handle.response.headers;
  }

  /** The id of the last SSE event delivered (dispatched), to resume from. */
  get lastEventId(): string | null {
    return this.parser.lastEventId;
  }

  /** Bytes of the body read so far (comments and partial events included): how the streams tell a quiet connection. */
  get received(): number {
    return this.bytes;
  }

  /** Closes the connection. Idempotent. */
  close(): void {
    this.handle.close();
  }

  private async *counted(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    for await (const chunk of chunks) {
      this.bytes += chunk.length;
      yield chunk;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    if (this.used) throw new FactoryError({ code: "stream_closed", message: "an EventStream can be iterated once" });
    this.used = true;
    try {
      const chunks = this.counted(readStream(this.handle.body));
      yield* this.format === "ndjson" ? parseNdjson(chunks) : parseSse(chunks, this.parser);
    } catch (err) {
      if (this.handle.signal.aborted || err instanceof FactoryError) throw err;
      throw new FactoryError({ code: "transport", message: `stream interrupted: ${String(err)}`, cause: err });
    } finally {
      this.handle.close();
    }
  }
}
