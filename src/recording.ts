/**
 * The recording format `pfr1` (SDK-DESIGN.md section 6): NDJSON, optionally gzip; line 1 is the header, every other line
 * a Frame exactly as the API sent it or a side event `{"sse": "clock" | "worker" | "gap" | "reset", "data", "recv"}`.
 * Readers ignore lines they do not understand.
 *
 * @module
 */
import { FactoryError } from "./errors.js";
import { byteLines, bytesToText, concatBytes, readStream, textLines } from "./internal/bytes.js";
import { gunzip, isGzip } from "./internal/inflate.js";
import { cleanFrame } from "./internal/looks.js";
import { platform } from "./internal/platform.js";
import { frameProblem, headerProblem, sideLineProblem, withoutBadSource } from "./internal/shape.js";
import type { Frame, Layer, VideoEntry } from "./models.js";
import { errorFromResponse, type FetchLike } from "./transport.js";

/** Line 1 of a recording. */
export interface RecordingHeader {
  recording: "pfr1";
  name?: string;
  /** The video, or null for a recording of several. */
  video: string | null;
  /** The catalog entry of the source. */
  source?: VideoEntry;
  build?: string;
  api?: string;
  model?: string;
  backend?: string;
  layers?: Layer[];
  /** The redacted fields (public recordings). */
  redacted?: string[];
  recorded_from?: string;
  recorded_at?: string;
  frames?: number;
  g_first?: number | null;
  g_last?: number | null;
  sessions?: number[];
  backfilled_layers?: number;
  frames_still_missing?: number;
  complete?: unknown;
  notes?: string;
  [key: string]: unknown;
}

/** A side event line of a recording. */
export interface SideLine {
  sse: "clock" | "worker" | "gap" | "reset" | (string & Record<never, never>);
  data: unknown;
  /** Epoch seconds when it was received. */
  recv?: number;
}

/** What a recording line is. */
export type RecordingLine =
  | { kind: "header"; header: RecordingHeader }
  | { kind: "frame"; frame: Frame }
  | { kind: "side"; side: SideLine }
  | { kind: "other"; value: unknown };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Classifies a parsed line by its keys alone (SDK-DESIGN.md section 6): the header (a `recording` field, when
 * `haveHeader` is false), a side event (an `sse` field), a frame (`g` and `cursor`), or something else. Whether it
 * decodes is not checked ({@link classifyLine} checks it); the fake server reads its recordings so.
 */
export function classifyKeys(value: unknown, haveHeader: boolean): RecordingLine {
  if (!isObject(value)) return { kind: "other", value };
  if ("recording" in value && !haveHeader) return { kind: "header", header: value as unknown as RecordingHeader };
  if ("sse" in value) return { kind: "side", side: value as unknown as SideLine };
  if ("g" in value && "cursor" in value) return { kind: "frame", frame: cleanFrame(value) as unknown as Frame };
  return { kind: "other", value };
}

/**
 * Classifies a parsed line as the reference reader does (SDK-DESIGN.md section 6): by its keys ({@link classifyKeys};
 * pass `haveHeader` false only for the first line that is not blank, the only one a header can be), and a header, side
 * line or frame that does not decode (2.3 rule 9: a field missing or of the wrong type, say) is something else too, a
 * line a reader ignores. A header's `source` that does not decode is left out.
 */
export function classifyLine(value: unknown, haveHeader: boolean): RecordingLine {
  const line = classifyKeys(value, haveHeader);
  switch (line.kind) {
    case "header":
      if (headerProblem(line.header) !== null) return { kind: "other", value };
      return { kind: "header", header: withoutBadSource(line.header) };
    case "side":
      return sideLineProblem(line.side as unknown as Record<string, unknown>) === null
        ? line
        : { kind: "other", value };
    case "frame":
      return frameProblem(line.frame) === null ? line : { kind: "other", value };
    default:
      return line;
  }
}

/** Parses one line: undefined for a blank line or one that is not JSON. */
export function parseLine(line: string): unknown {
  const s = line.trim();
  if (s.length === 0) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

/** Where a recording can come from. */
export type RecordingSource =
  | string
  | URL
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** Options to read a recording. */
export interface ReadOptions {
  /** The fetch used for HTTP(S) URLs (default: the global fetch). */
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * The lines of in-memory bytes (gzip detected by its magic), now: gzip is inflated whole and synchronously by the
 * built-in inflater (about 15 MB/s), so this is for small recordings; {@link readLines} streams.
 */
export function linesOfBytes(bytes: Uint8Array): Generator<string> {
  return textLines(bytesToText(isGzip(bytes) ? gunzip(bytes) : bytes));
}

async function* prepend(first: Uint8Array, it: AsyncIterator<Uint8Array>): AsyncGenerator<Uint8Array> {
  let done = false;
  try {
    yield first;
    for (;;) {
      const r = await it.next();
      if (r.done) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!done) await it.return?.();
  }
}

/**
 * Decompresses a gzip byte stream: `DecompressionStream`, else Node's zlib, else the built-in inflater. Gzip data that
 * is corrupt or ends early is a `decode` error, as in every SDK; an error of the source itself (a broken download) is
 * thrown as it is.
 */
export async function* gunzipChunks(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let failed: { error: unknown } | null = null;
  async function* source(): AsyncGenerator<Uint8Array> {
    try {
      yield* chunks;
    } catch (error) {
      failed = { error };
      throw error;
    }
  }
  try {
    yield* inflateChunks(source());
  } catch (err) {
    const sourceError = (failed as { error: unknown } | null)?.error;
    if (err === sourceError || err instanceof FactoryError || (err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
    throw new FactoryError({ code: "decode", message: `recording: bad gzip data (${String(err)})`, cause: err });
  }
}

async function* inflateChunks(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const DS = platform.decompressionStream();
  if (DS) {
    const it = chunks[Symbol.asyncIterator]();
    const input = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const r = await it.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      },
      async cancel() {
        await it.return?.();
      },
    });
    const ds = new DS("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    yield* readStream(input.pipeThrough(ds));
    return;
  }
  const zlib = await platform.importZlib().catch(() => null);
  if (zlib) {
    const gz = zlib.createGunzip();
    // write() says false when gunzip's input buffer is full: wait for it to drain (or to end), as a pipe would
    const drained = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const done = (): void => {
          gz.off("drain", done);
          gz.off("close", done);
          resolve();
        };
        gz.on("drain", done);
        gz.on("close", done);
      });
    const feed = (async () => {
      for await (const c of chunks) {
        if (gz.destroyed) return; // the reader stopped early
        if (!gz.write(c)) await drained();
      }
      gz.end();
    })().catch((err: unknown) => {
      gz.destroy(err);
    });
    try {
      for await (const out of gz) yield out;
    } finally {
      gz.destroy();
    }
    await feed;
    return;
  }
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  yield gunzip(concatBytes(parts));
}

/** Bytes in memory are read in pieces of this size, so that decompression streams them too. */
const CHUNK = 1 << 16;

function* pieces(bytes: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += CHUNK) yield bytes.subarray(at, at + CHUNK);
}

/** Raw bytes of a source, as chunks. */
async function* sourceChunks(source: RecordingSource, options: ReadOptions): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield* pieces(source);
    return;
  }
  if (source instanceof ArrayBuffer) {
    yield* pieces(new Uint8Array(source));
    return;
  }
  if (typeof ReadableStream !== "undefined" && source instanceof ReadableStream) {
    yield* readStream(source);
    return;
  }
  if (typeof source !== "string" && !(source instanceof URL)) {
    yield* source as AsyncIterable<Uint8Array>;
    return;
  }
  const text = String(source);
  if (/^https?:/i.test(text)) {
    yield* fetchChunks(text, options);
    return;
  }
  const fs = await platform.importFs().catch(() => null);
  if (fs === null) {
    yield* fetchChunks(text, options);
    return;
  }
  const stream = fs.createReadStream(text.startsWith("file:") ? new URL(text) : text);
  try {
    for await (const chunk of stream) yield chunk;
  } finally {
    stream.destroy();
  }
}

async function* fetchChunks(url: string, options: ReadOptions): AsyncGenerator<Uint8Array> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(url, { signal: options.signal });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new FactoryError({ code: "transport", message: `cannot fetch ${url}: ${String(cause)}`, cause });
  }
  if (!res.ok) {
    // a reply is not a transport error: its code is the API error body's, else the status's (spec 2.1)
    const e = await errorFromResponse(res);
    throw new FactoryError({
      code: e.code,
      status: e.status,
      field: e.field,
      retryMs: e.retryMs,
      retained: e.retained,
      waiting: e.waiting,
      body: e.body,
      headers: e.headers,
      message: `cannot fetch ${url}: ${e.message}`,
    });
  }
  if (res.body === null) return; // a success without a body (204): no lines
  try {
    yield* readStream(res.body);
  } catch (cause) {
    // a download that breaks off is transport, as in every SDK; an abort is the caller's own
    if (options.signal?.aborted || cause instanceof FactoryError) throw cause;
    throw new FactoryError({ code: "transport", message: `cannot read ${url}: ${String(cause)}`, cause });
  }
}

/**
 * The text lines of a recording, streamed: a local path (Node, Deno, Bun), an HTTP(S) URL (or a relative URL in a
 * browser), bytes, or a byte stream. Gzip is detected by its magic bytes, whatever the name says.
 */
export async function* readLines(source: RecordingSource, options: ReadOptions = {}): AsyncGenerator<string> {
  const it = sourceChunks(source, options)[Symbol.asyncIterator]();
  let first: Uint8Array = new Uint8Array(0);
  let done = false;
  while (first.length < 2) {
    const r = await it.next();
    if (r.done) {
      done = true;
      break;
    }
    first = first.length === 0 ? r.value : concatBytes([first, r.value]);
  }
  const chunks = done ? prepend(first, emptyIterator()) : prepend(first, it);
  yield* byteLines(isGzip(first) ? gunzipChunks(chunks) : chunks);
}

function emptyIterator(): AsyncIterator<Uint8Array> {
  return { next: () => Promise.resolve({ value: undefined, done: true }) };
}
