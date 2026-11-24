import { FactoryError } from "../errors.js";

/**
 * The longest line, and the most data of one event, a stream may send, in characters (a frame is well under a
 * million). More is a `decode` error that ends the connection.
 */
export const MAX_LINE = 64 * 1024 * 1024;

/** The `decode` error of a line or an event longer than `limit`. */
export function tooLarge(what: string, limit: number): FactoryError {
  return new FactoryError({ code: "decode", message: `${what} of the stream is longer than ${limit} characters` });
}

/** Decodes standard or URL-safe base64 (padding optional) into bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/"));
  } catch (cause) {
    throw new FactoryError({ code: "decode", message: "not valid base64", cause });
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Joins byte chunks into one array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** UTF-8 text of bytes (a leading BOM is dropped). */
export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Splits text into lines on LF, dropping a CR before the LF; a last line without LF is kept when not empty. */
export function* textLines(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) {
      yield stripCr(text.slice(start));
      return;
    }
    yield stripCr(text.slice(start, nl));
    start = nl + 1;
  }
}

/**
 * Splits a byte stream into UTF-8 lines on LF (a CR before the LF is dropped). Only new text is scanned for line ends,
 * and a line longer than `limit` characters is a `decode` error.
 */
export async function* byteLines(chunks: AsyncIterable<Uint8Array>, limit = MAX_LINE): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  let rest = "";
  for await (const chunk of chunks) {
    const from = rest.length; // the text before has no line end
    rest += decoder.decode(chunk, { stream: true });
    let nl = rest.indexOf("\n", from);
    while (nl >= 0) {
      if (nl > limit) throw tooLarge("a line", limit);
      yield stripCr(rest.slice(0, nl));
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
    if (rest.length > limit) throw tooLarge("a line", limit);
  }
  rest += decoder.decode();
  if (rest.length > 0) yield* textLines(rest);
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Reads a web ReadableStream as an async iterable of chunks, cancelling the stream when the iteration stops early. */
export async function* readStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
