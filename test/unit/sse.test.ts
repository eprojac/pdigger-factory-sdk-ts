import { describe, expect, it } from "vitest";
import {
  EventStream,
  FactoryError,
  MAX_LINE,
  SseParser,
  StreamEvent,
  parseNdjson,
  parseSse,
  type StreamHandle,
} from "pdigger-factory-sdk";
import { all, rejection } from "../helpers/fake.js";
import { readBytes } from "../helpers/fixtures.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === "string" ? enc(p) : p;
}

function handle(body: ReadableStream<Uint8Array>, type: string): StreamHandle & { closed: number } {
  const c = new AbortController();
  const h = {
    response: new Response(null, { headers: { "Content-Type": type } }),
    body,
    signal: c.signal,
    closed: 0,
    close() {
      h.closed++;
      c.abort();
    },
  };
  return h;
}

const streamOf = (...parts: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc(p));
      c.close();
    },
  });

describe("SseParser", () => {
  it("bounds lines and events", () => {
    const tooLong = (f: () => unknown): string => {
      try {
        f();
      } catch (err) {
        return `${(err as FactoryError).code}: ${(err as FactoryError).message}`;
      }
      return "no error";
    };
    expect(tooLong(() => new SseParser(null, 8).push("data: 123\n"))).toBe(
      "decode: a line of the stream is longer than 8 characters",
    );
    const p = new SseParser(null, 8);
    expect(p.push("data: 12")).toEqual([]);
    expect(tooLong(() => p.push("3"))).toContain("a line of the stream");
    expect(tooLong(() => new SseParser(null, 8).push("data:123\ndata:123\ndata:123\n"))).toBe(
      "decode: an event of the stream is longer than 8 characters",
    );
    expect(MAX_LINE).toBe(64 * 1024 * 1024);
  });

  it("parses fields, comments, ids and retry as the HTML spec says", () => {
    const p = new SseParser("boot-1");
    expect(p.lastEventId).toBe("boot-1");
    expect(p.push("")).toEqual([]);
    const evs = p.push(
      '﻿: comment\nevent: frame\ndata: {"a":1}\nid: boot-2\nretry: 1500\n\n' +
        "data:no space\ndata: two\nunknown: x\nfield-only\n\n" +
        "id: bad\0id\nretry: soon\nevent: clock\n\n" +
        "data\n\n",
    );
    expect(evs.map((e) => [e.event, e.data, e.id, e.retry])).toEqual([
      ["frame", '{"a":1}', "boot-2", 1500],
      ["message", "no space\ntwo", "boot-2", 1500],
      ["message", "", "boot-2", 1500],
    ]);
    expect(p.retry).toBe(1500);
    expect(evs[0]?.json()).toEqual({ a: 1 });
    expect(evs[0]?.json()).toEqual({ a: 1 });
    expect(() => evs[1]?.json()).toThrow(FactoryError);
  });

  it("moves the last event id only when an event is dispatched, as the HTML spec says", () => {
    const p = new SseParser("b-0");
    expect(p.push("id: b-1\nevent: frame\ndata: {}\n")).toEqual([]);
    expect(p.lastEventId).toBe("b-0"); // cut here, a resume from b-0 gets the event again
    expect(p.push("\n").map((e) => e.id)).toEqual(["b-1"]);
    expect(p.lastEventId).toBe("b-1");
    expect(p.push("id: b-2\n\n")).toEqual([]); // a blank line with an id and no data: no event, the id is set
    expect(p.lastEventId).toBe("b-2");
    expect(p.push("data: x\n\n").map((e) => e.id)).toEqual(["b-2"]);
    expect(new SseParser().lastEventId).toBeNull();
    expect(new SseParser().push("data: y\n\n").map((e) => e.id)).toEqual([null]);
  });

  it("handles CR, LF and CRLF split across chunks", () => {
    const p = new SseParser();
    expect(p.push("data: a\r")).toEqual([]);
    expect(p.push("\ndata: b\r\r").map((e) => e.data)).toEqual(["a\nb"]);
    expect(p.push("data: c\r\n\r\n").map((e) => e.data)).toEqual(["c"]);
    expect(p.push("data: d\r").map((e) => e.data)).toEqual([]);
    expect(p.push("\r").map((e) => e.data)).toEqual(["d"]);
    expect(p.push("data: e\n").map((e) => e.data)).toEqual([]);
    expect(p.push("\n").map((e) => e.data)).toEqual(["e"]);
  });

  it("parses a recorded SSE stream", async () => {
    const evs = await all(parseSse(chunks(readBytes("api/streamFrames-sse.sse"))));
    expect(evs.length).toBeGreaterThan(2);
    expect(evs[0]?.event).toBe("frame");
    expect(evs[0]?.id).toMatch(/^[0-9a-f]+-\d+$/);
    const split = await all(parseSse(chunks("data: x", "\n", "\n", "data: é".slice(0, 7), "\n\n")));
    expect(split.map((e) => e.data)).toEqual(["x", "é"]);
  });
});

describe("parseNdjson", () => {
  it("yields frames and gaps, skipping blank lines", async () => {
    const evs = await all(parseNdjson(chunks('{"g":1}\n\n{"gap":3}\nnot json\n{"gap":1,"x":2}\n[1]')));
    expect(evs.map((e) => e.event)).toEqual(["frame", "gap", "frame", "frame", "frame"]);
    expect(evs[1]?.json()).toEqual({ gap: 3 });
    expect(() => evs[2]?.json()).toThrow(FactoryError);
    expect(new StreamEvent("x", "1").json()).toBe(1);
  });
  it("parses a recorded NDJSON stream", async () => {
    const evs = await all(parseNdjson(chunks(readBytes("api/streamFrames-ndjson.ndjson"))));
    expect(evs.length).toBeGreaterThan(2);
    expect((evs[0]?.json() as { g: number }).g).toBeGreaterThan(0);
  });
});

describe("EventStream", () => {
  it("iterates once, picks the format from the content type, and closes", async () => {
    const h = handle(streamOf("id: b-1\nevent: frame\ndata: {}\n\n"), "text/event-stream");
    const s = new EventStream(h, "b-0");
    expect(s.format).toBe("sse");
    expect(s.status).toBe(200);
    expect(s.headers.get("content-type")).toBe("text/event-stream");
    expect(s.lastEventId).toBe("b-0");
    expect((await all(s)).map((e) => e.id)).toEqual(["b-1"]);
    expect(s.lastEventId).toBe("b-1");
    expect(h.closed).toBeGreaterThan(0);
    expect(((await rejection(all(s))) as FactoryError).code).toBe("stream_closed");
    s.close();
    const nd = new EventStream(handle(streamOf('{"g":2}\n'), "application/x-ndjson"));
    expect(nd.format).toBe("ndjson");
    expect((await all(nd)).map((e) => e.event)).toEqual(["frame"]);
    const none = new EventStream({ ...handle(streamOf(), ""), response: new Response(null) });
    expect(none.format).toBe("sse");
    const text = ": hello\nid: b-9\nevent: frame\ndata: {}\n\n";
    const counted = new EventStream(handle(streamOf(text), "text/event-stream"));
    expect(counted.received).toBe(0);
    expect((await all(counted)).map((e) => e.id)).toEqual(["b-9"]);
    expect(counted.received).toBe(new TextEncoder().encode(text).length); // every byte, comments too
  });

  it("wraps read errors as transport errors, but passes aborts and FactoryErrors", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new TypeError("socket hang up"));
      },
    });
    const err = (await rejection(all(new EventStream(handle(failing, "text/event-stream"))))) as FactoryError;
    expect(err.code).toBe("transport");
    const h = handle(
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(new DOMException("aborted", "AbortError"));
        },
      }),
      "text/event-stream",
    );
    h.close();
    expect(((await rejection(all(new EventStream(h)))) as Error).name).toBe("AbortError");
    const fe = new FactoryError({ code: "decode", message: "x" });
    const h2 = handle(
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(fe);
        },
      }),
      "text/event-stream",
    );
    expect(await rejection(all(new EventStream(h2)))).toBe(fe);
  });
});
