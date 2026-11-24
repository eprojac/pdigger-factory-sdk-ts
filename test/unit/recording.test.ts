import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryError } from "pdigger-factory-sdk";
import { Replay } from "pdigger-factory-sdk";
import { ManualClock, settle } from "pdigger-factory-sdk/testing";
import { platform } from "../../src/internal/platform.js";
import { classifyLine, gunzipChunks, linesOfBytes, parseLine, readLines } from "../../src/recording.js";
import { all, rejection } from "../helpers/fake.js";
import { readText, recordingPath } from "../helpers/fixtures.js";
import { mkFrame } from "../helpers/frames.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
async function* iter(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield p;
}
const header = { recording: "pfr1", name: "t", video: "dry1" };
/** A clock state that decodes (2.3 rule 9: every field of `State` and `server_now`). */
const clockState = (anchorWall: number) => ({
  session: 1,
  revision: 1,
  video: "dry1",
  playing: true,
  rate: 1,
  anchor_media: 0,
  anchor_wall: anchorWall,
  hold_until: anchorWall,
  duration: null,
  changed_by: "viewer",
  focus: null,
  media_time: 0,
  server_now: anchorWall,
});
const recText = [
  JSON.stringify(header),
  "",
  "not json",
  JSON.stringify({ sse: "clock", data: clockState(100) }),
  JSON.stringify({ sse: "worker", data: { state: "running" } }),
  JSON.stringify({ sse: "clock", data: null }),
  JSON.stringify(mkFrame(1, { events: [{ type: "lift", id: 1, side: "left" }] })),
  JSON.stringify(mkFrame(1)),
  JSON.stringify({ something: "else" }),
  JSON.stringify(mkFrame(2, { events: [{ type: "place", id: 1 }] })),
  JSON.stringify(mkFrame(3, { session: 2, events: [{ type: "lift", id: 2, side: "right" }] })),
].join("\n");

afterEach(() => vi.restoreAllMocks());

describe("recording lines", () => {
  it("classifies lines as SDK-DESIGN.md section 6 says", () => {
    expect(classifyLine(5, false).kind).toBe("other");
    expect(classifyLine([1], false).kind).toBe("other");
    expect(classifyLine(header, false).kind).toBe("header");
    expect(classifyLine(header, true).kind).toBe("other");
    expect(classifyLine({ sse: "gap", data: { gap: 1 } }, true).kind).toBe("side");
    expect(classifyLine({ sse: "hello", data: 5 }, true).kind).toBe("side"); // an event no SDK knows: not checked
    expect(classifyLine(mkFrame(1), true).kind).toBe("frame");
    expect(classifyLine({ g: 1 }, true).kind).toBe("other");
    // lines that do not decode (2.3 rule 9) are ignored; fixtures/damaged has one of each kind
    expect(classifyLine({ g: 1, cursor: 2 }, true).kind).toBe("other");
    expect(classifyLine({ ...mkFrame(1), g: "x" }, true).kind).toBe("other");
    expect(classifyLine({ ...mkFrame(1), g: 1.5 }, true).kind).toBe("other");
    expect(classifyLine({ ...mkFrame(1), cursor: null }, true).kind).toBe("other");
    expect(classifyLine({ ...mkFrame(1), world: 5 }, true).kind).toBe("other");
    expect(classifyLine({ ...mkFrame(1), world: null, missing: null }, true).kind).toBe("frame"); // null is not there
    expect(classifyLine({ sse: 5, data: {} }, true).kind).toBe("other");
    expect(classifyLine({ sse: "clock", data: clockState(1), recv: "x" }, true).kind).toBe("other");
    expect(classifyLine({ sse: "clock", data: clockState(1), recv: 2 }, true).kind).toBe("side");
    expect(classifyLine({ sse: "gap", data: { gap: "x" } }, true).kind).toBe("other");
    expect(classifyLine({ ...header, frames: "x" }, false).kind).toBe("other");
    const noSource = classifyLine({ ...header, source: 5 }, false); // a source that does not decode is left out
    expect(noSource.kind === "header" && !("source" in noSource.header)).toBe(true);
    const withSource = classifyLine(
      { ...header, source: { id: "dry1", fps: 25, grid_step: 5, proxy: "p", proxy_wh: [], native_wh: [] } },
      false,
    );
    expect(withSource.kind === "header" && withSource.header.source?.id).toBe("dry1");
    const entry = { id: "cam", fps: 3, grid_step: 1, proxy: "p", proxy_wh: [], native_wh: [] };
    const camera = classifyLine({ ...header, source: { ...entry, station: "s" } }, false);
    expect(camera.kind === "header" && camera.header.source?.station).toBe("s");
    const badStation = classifyLine({ ...header, source: { ...entry, station: 5 } }, false); // no catalog entry
    expect(badStation.kind === "header" && !("source" in badStation.header)).toBe(true);
    expect(parseLine("  ")).toBeUndefined();
    expect(parseLine("{x")).toBeUndefined();
    expect(parseLine(' {"a":1} ')).toEqual({ a: 1 });
  });

  it("reads bytes, gzip or not", () => {
    expect([...linesOfBytes(enc("a\nb"))]).toEqual(["a", "b"]);
    expect([...linesOfBytes(gzipSync("a\nb\n"))]).toEqual(["a", "b"]);
  });

  it("reads every kind of source", async () => {
    const gz = gzipSync(recText);
    expect((await all(readLines(enc(recText)))).length).toBe(11);
    expect((await all(readLines(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length)))).length).toBe(11);
    expect(await all(readLines(new Blob([enc("x\ny") as Uint8Array<ArrayBuffer>]).stream()))).toEqual(["x", "y"]);
    expect(await all(readLines(iter(enc("a"), enc("b\nc"))))).toEqual(["ab", "c"]);
    expect(await all(readLines(iter(new Uint8Array([0x1f]), new Uint8Array([0x8b]), gz.subarray(2))))).toHaveLength(11);
    expect(await all(readLines(iter(enc("z"))))).toEqual(["z"]);
    expect(await all(readLines(iter()))).toEqual([]);
    const path = recordingPath("joined-mid-move");
    const n = (await all(readLines(path))).length;
    expect(n).toBeGreaterThan(20);
    expect(await all(readLines(pathToFileURL(path)))).toHaveLength(n);
    expect(await all(readLines(pathToFileURL(path).href))).toHaveLength(n);
  });

  it("stops reading a file early", async () => {
    for await (const line of readLines(recordingPath("dry1-0000-0130"))) {
      expect(line.startsWith("{")).toBe(true);
      break;
    }
  });

  it("fetches HTTP(S) URLs with the given fetch", async () => {
    const bytes = readFileSync(recordingPath("joined-mid-move"));
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/missing")) return new Response("no", { status: 404 });
      if (u.endsWith("/broken")) return new Response("no", { status: 500 });
      if (u.endsWith("/empty")) return new Response(null, { status: 204 });
      if (u.endsWith("/s429-ra")) return new Response("slow", { status: 429, headers: { "Retry-After": "7" } });
      if (u.endsWith("/s503-api")) {
        const body = { error: "not ready", code: "not_ready", retry_ms: 1500, waiting: ["model"] };
        return new Response(JSON.stringify(body), { status: 503 });
      }
      const status = /\/s(\d+)$/.exec(u);
      if (status) return new Response(null, { status: Number(status[1]) });
      if (u.endsWith("/api-error"))
        return new Response(JSON.stringify({ error: "no such video", code: "unknown_video" }), { status: 404 });
      if (u.endsWith("/down")) throw new TypeError("connection refused");
      return new Response(bytes);
    });
    const lines = await all(readLines("https://example.invalid/r.ndjson.gz", { fetch }));
    expect(lines.length).toBeGreaterThan(20);
    const notFound = (await rejection(all(readLines("https://example.invalid/missing", { fetch })))) as FactoryError;
    expect(notFound.code).toBe("not_found");
    expect(((await rejection(all(readLines("https://example.invalid/broken", { fetch })))) as FactoryError).code).toBe(
      "internal",
    );
    expect(await all(readLines("http://example.invalid/empty", { fetch }))).toEqual([]); // a success without a body
    // a reply is no transport error: the code is the API body's, else the status's, as in every SDK (spec 2.1)
    const codes: string[] = [];
    for (const path of ["s403", "s410", "s503", "s304", "api-error"]) {
      const e = (await rejection(all(readLines(`https://example.invalid/${path}`, { fetch })))) as FactoryError;
      codes.push(`${e.status} ${e.code} ${e.isRetryable()}`);
    }
    expect(codes).toEqual([
      "403 cross_origin false",
      "410 decode false",
      "503 not_ready true",
      "304 decode false",
      "404 unknown_video false",
    ]);
    // the reply's own fields come with the error, as from every request (Python's FactoryError.from_reply)
    const fail = async (path: string) =>
      (await rejection(all(readLines(`https://example.invalid/${path}`, { fetch })))) as FactoryError;
    const slow = await fail("s429-ra");
    expect([slow.code, slow.retryMs, slow.headers?.get("retry-after")]).toEqual(["too_many_requests", 7000, "7"]);
    const notReady = await fail("s503-api");
    expect([notReady.code, notReady.retryMs, notReady.waiting]).toEqual(["not_ready", 1500, ["model"]]);
    expect((notReady.body as { code?: string } | null)?.code).toBe("not_ready");
    const range = await fail("s416");
    expect([range.code, range.field]).toEqual(["invalid_param", "range"]);
    const down = (await rejection(all(readLines("http://example.invalid/down", { fetch })))) as FactoryError;
    expect(down.code).toBe("transport");
    const c = new AbortController();
    c.abort();
    const abortingFetch = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const aborted = await rejection(
      all(readLines("http://example.invalid/x", { fetch: abortingFetch, signal: c.signal })),
    );
    expect((aborted as Error).name).toBe("AbortError");
  });

  it("gives a transport error, and no final update, for a download that breaks off, plain or gzip", async () => {
    const gz = readFileSync(recordingPath("joined-mid-move"));
    const plain = gunzipSync(gz);
    /** A body that sends the first half of `bytes`, then breaks as undici's fetch does ("terminated"). */
    const halfBody = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
      let sent = false;
      return new ReadableStream({
        pull(c) {
          if (sent) c.error(new TypeError("terminated"));
          else c.enqueue(bytes.subarray(0, bytes.length >> 1));
          sent = true;
        },
      });
    };
    const fetch = vi.fn(
      async (url: string | URL | Request) => new Response(halfBody(String(url).endsWith(".gz") ? gz : plain)),
    );
    const got: string[] = [];
    let plainUpdates = 0;
    const cases = [
      ["r.ndjson", "-"],
      ["r.ndjson.gz", "DecompressionStream"],
      ["r.ndjson.gz", "zlib"],
    ] as const;
    for (const [name, inflate] of cases) {
      if (inflate === "zlib") vi.spyOn(platform, "decompressionStream").mockReturnValue(undefined);
      const url = `https://example.invalid/${name}`;
      let final = false; // the open, or the updates after it, fail (the inflater may hold back what it had)
      const e = (await rejection(
        (async () => {
          for await (const u of (await Replay.open(url, { fetch })).updates()) {
            final ||= u.isFinal;
            if (inflate === "-") plainUpdates += 1;
          }
        })(),
      )) as FactoryError;
      const s = (await rejection((async () => (await Replay.open(url, { fetch })).summary())())) as FactoryError;
      got.push(`${e.code} ${(e.cause as Error).message} ${final} ${s.code}`);
      vi.restoreAllMocks();
    }
    expect(got).toEqual(Array<string>(3).fill("transport terminated false transport"));
    expect(plainUpdates).toBe(10); // it broke off mid-way: the 10 frames of 22 whose lines are whole in the first half
    const c = new AbortController(); // an abort while the body is read is the caller's own, not transport
    const stalled = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (ctl) => {
              c.abort();
              ctl.error(new DOMException("aborted", "AbortError"));
            },
          }),
        ),
    );
    const aborted = await rejection(
      all(readLines("https://example.invalid/r.ndjson", { fetch: stalled, signal: c.signal })),
    );
    expect((aborted as Error).name).toBe("AbortError");
  });

  it("gives a decode error for gzip data that is cut or corrupt, on every inflate path; a source error as it is", async () => {
    const gz = gzipSync(recText);
    const cut = gz.subarray(0, gz.length - 10);
    const corrupt = Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0xff, 0xff, 0xff, 0xff]);
    const codes = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const bytes of [cut, corrupt]) {
        const e = (await rejection(all(gunzipChunks(iter(bytes))))) as FactoryError;
        out.push(`${e.code} ${e.message.startsWith("recording: bad gzip data")}`);
      }
      const replayed = (async () => all((await Replay.open(cut)).updates()))(); // the open or the updates fail
      out.push(((await rejection(replayed)) as FactoryError).code);
      const boom = new Error("the download broke");
      async function* broken(): AsyncGenerator<Uint8Array> {
        yield gz.subarray(0, 40);
        throw boom;
      }
      out.push((await rejection(all(gunzipChunks(broken())))) === boom ? "as it is" : "changed");
      return out;
    };
    expect(await codes()).toEqual(["decode true", "decode true", "decode", "as it is"]); // DecompressionStream
    vi.spyOn(platform, "decompressionStream").mockReturnValue(undefined);
    expect(await codes()).toEqual(["decode true", "decode true", "decode", "as it is"]); // Node's zlib
  });

  it("falls back to fetch without a file system", async () => {
    vi.spyOn(platform, "importFs").mockRejectedValue(new Error("no fs here"));
    const fetch = vi.fn(async () => new Response("a\nb\n"));
    expect(await all(readLines("recordings/r.ndjson", { fetch }))).toEqual(["a", "b"]);
    expect(fetch).toHaveBeenCalledWith("recordings/r.ndjson", { signal: undefined });
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("c\n"));
    expect(await all(readLines("r.ndjson"))).toEqual(["c"]);
    expect(globalFetch).toHaveBeenCalled();
  });

  it("feeds zlib no faster than it inflates, and stops feeding when the reader stops", async () => {
    vi.spyOn(platform, "decompressionStream").mockReturnValue(undefined);
    const plain = new Uint8Array(1 << 20);
    let x = 7;
    for (let i = 0; i < plain.length; i++) plain[i] = (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24; // incompressible
    const gz = gzipSync(plain);
    let pulled = 0;
    async function* pieces(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < gz.length; i += 1 << 16) {
        pulled++;
        yield gz.subarray(i, i + (1 << 16));
      }
    }
    const whole = Buffer.concat(await all(gunzipChunks(pieces())));
    expect(whole.equals(Buffer.from(plain))).toBe(true); // every write over the buffer waited for its drain
    const total = pulled;
    expect(total).toBe(Math.ceil(gz.length / (1 << 16)));
    pulled = 0;
    for await (const out of gunzipChunks(pieces())) {
      expect(out.length).toBeGreaterThan(0);
      break; // the reader stops after the first piece
    }
    for (let i = 0; i < 20; i++) await settle();
    expect(pulled).toBeLessThan(total); // the feed stopped too
    vi.restoreAllMocks();
  });

  it("gunzips with DecompressionStream, zlib, or the built-in inflater", async () => {
    const gz = gzipSync("hello\nworld\n");
    const text = async (): Promise<string> =>
      new TextDecoder().decode(Buffer.concat(await all(gunzipChunks(iter(gz.subarray(0, 5), gz.subarray(5))))));
    expect(await text()).toBe("hello\nworld\n");
    vi.spyOn(platform, "decompressionStream").mockReturnValue(undefined);
    expect(await text()).toBe("hello\nworld\n");
    vi.spyOn(platform, "importZlib").mockRejectedValue(new Error("no zlib"));
    expect(await text()).toBe("hello\nworld\n");
  });

  it("passes source errors through the zlib path", async () => {
    vi.spyOn(platform, "decompressionStream").mockReturnValue(undefined);
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield gzipSync("a\n").subarray(0, 4);
      throw new Error("source failed");
    }
    const err = await rejection(all(gunzipChunks(failing())));
    expect(String(err)).toContain("source failed");
  });

  it("cancels the source when a gzip read stops early", async () => {
    let returned = false;
    const big = gzipSync("line\n".repeat(200_000));
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < big.length; i += 1024) yield big.subarray(i, i + 1024);
      } finally {
        returned = true;
      }
    }
    for await (const line of readLines(source())) {
      expect(line).toBe("line");
      break;
    }
    await settle();
    expect(returned).toBe(true);
  });
});

describe("Replay", () => {
  it("replays text, lines and bytes in memory, sync and async", async () => {
    const r = Replay.fromText(recText);
    expect(r.header?.name).toBe("t");
    expect(r.inMemory).toBe(true);
    expect(r.core).toBeNull();
    const events = [...r.eventsSync()].map((e) => e.describe());
    expect(events).toEqual([
      "0:00.2 Left hand lifts stone 1",
      "0:00.4 A hand places stone 1",
      "0:00.6 Right hand lifts stone 2",
    ]);
    expect(r.core?.summary().sessions).toBe(2);
    expect([...r.activitiesSync()].map((a) => a.describe())).toEqual([
      "0:00.2 Left hand lifts stone 1 and sets it down (0.2 s)",
      "0:00.6 Right hand is still holding stone 2 (0.0 s so far)",
    ]);
    expect([...r.framesSync()]).toHaveLength(4);
    expect(r.summarySync().frames).toBe(3);
    expect((await r.summary()).frames).toBe(3);
    expect((await all(r.events())).length).toBe(3);
    expect((await all(r.activities())).length).toBe(2);
    expect((await all(r.frames())).length).toBe(4);
    const ups = [...r.updatesSync()];
    expect(ups[0]?.events[0]?.wall).toBeCloseTo(100.2);
    expect(ups[ups.length - 1]?.isFinal).toBe(true);
    const lines = Replay.fromLines([header, mkFrame(1), "", JSON.stringify(mkFrame(2))]);
    expect(lines.header?.video).toBe("dry1");
    expect(lines.summarySync().frames).toBe(2);
    expect(Replay.fromLines(["", JSON.stringify(mkFrame(1))]).header).toBeNull();
    // the first line is the header's only candidate in every pass: one with `recording` that does not decode (here
    // with a frame's keys too) is skipped by the frames as by the updates
    const odd = Replay.fromLines([{ ...mkFrame(1), recording: 5 }, mkFrame(2)]);
    expect(odd.header).toBeNull();
    expect([...odd.framesSync()].map((f) => f.g)).toEqual([2]);
    expect((await all(odd.frames())).map((f) => f.g)).toEqual([2]);
    expect(odd.summarySync().frames).toBe(1);
    expect(Replay.fromBytes(gzipSync(recText)).summarySync().frames).toBe(3);
    const fresh = Replay.fromText(recText);
    expect((await fresh.summary()).sessions).toBe(2);
    expect(Replay.fromText(recText).summarySync().sessions).toBe(2);
  });

  it("streams a file, reopens it per pass, and refuses the sync methods", async () => {
    const r = await Replay.open(recordingPath("joined-mid-move"));
    expect(r.header?.name).toBe("joined-mid-move");
    expect(r.inMemory).toBe(false);
    expect(() => [...r.eventsSync()]).toThrow(TypeError);
    const first = (await all(r.events())).map((e) => e.describe());
    const second = (await all(r.events())).map((e) => e.describe());
    expect(second).toEqual(first);
    expect(first.join("\n") + "\n").toBe(readText("golden/joined-mid-move.events.txt"));
    const loaded = await Replay.load(recordingPath("joined-mid-move"));
    expect(loaded.inMemory).toBe(true);
    expect([...loaded.eventsSync()].map((e) => e.describe())).toEqual(first);
  });

  it("opens bytes, buffers and streams; a stream replays once", async () => {
    const bytes = readFileSync(recordingPath("joined-mid-move"));
    const fromBytes = await Replay.open(new Uint8Array(bytes)); // streamed in pieces, not held as lines
    expect(fromBytes.inMemory).toBe(false);
    expect(fromBytes.header?.name).toBe("joined-mid-move");
    const held = Replay.fromBytes(new Uint8Array(bytes)); // the synchronous way, held in memory
    expect(held.inMemory).toBe(true);
    const first = await all(fromBytes.updates());
    expect(first.map((u) => u.frame?.g ?? "final")).toEqual(
      (await all(held.updates())).map((u) => u.frame?.g ?? "final"),
    );
    expect((await all(fromBytes.updates())).map((u) => u.frame?.g ?? "final")).toEqual(
      first.map((u) => u.frame?.g ?? "final"),
    ); // reopenable
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    const fromBuffer = await Replay.open(ab);
    expect(fromBuffer.header?.name).toBe("joined-mid-move");
    expect((await fromBuffer.summary()).frames).toBe(22);
    const once = await Replay.open(new Blob([bytes]).stream());
    expect((await once.summary()).frames).toBe(22);
    await expect(all(once.updates())).rejects.toThrow(TypeError);
    const noHeader = await Replay.open(iter(enc("\n" + JSON.stringify(mkFrame(1)) + "\n")));
    expect(noHeader.header).toBeNull();
    const empty = await Replay.open(iter());
    expect(empty.header).toBeNull();
  });

  it("paces frames in real time on the given clock", async () => {
    const clock = new ManualClock();
    const r = Replay.fromLines([
      mkFrame(1, { t: 1 }),
      mkFrame(2, { t: 2 }),
      mkFrame(3, { t: 2.5 }),
      mkFrame(1, { session: 9, t: 50 }),
    ]);
    const seen: number[] = [];
    const done = (async () => {
      for await (const f of r.frames({ pace: "realtime", speed: 2, clock })) seen.push(f.g);
    })();
    await settle();
    expect(seen).toEqual([1]);
    await clock.advance(500);
    expect(seen).toEqual([1, 2]);
    await clock.advance(250);
    expect(seen).toEqual([1, 2, 3, 1]);
    await done;
    const ups: number[] = [];
    const d2 = (async () => {
      for await (const u of r.updates({ pace: "realtime", clock })) ups.push(u.frame?.g ?? -1);
    })();
    await clock.runAll();
    await d2;
    expect(ups).toEqual([1, 2, 3, 1, -1]);
    expect(
      (await all(Replay.fromLines([mkFrame(1, { t: 1 }), mkFrame(2, { t: 1 })]).frames({ pace: "realtime", clock })))
        .length,
    ).toBe(2);
  });

  it("paces on the system clock by default (frames at the same time do not wait)", async () => {
    const r = Replay.fromLines([mkFrame(1, { t: 1 }), mkFrame(2, { t: 1 })]);
    expect((await all(r.frames({ pace: "realtime" }))).length).toBe(2);
    expect((await all(r.updates({ pace: "realtime" }))).length).toBe(3);
  });

  it("throws when aborted while the last frame is handled", async () => {
    const r = Replay.fromLines([mkFrame(1)]);
    const c = new AbortController();
    const p = (async () => {
      for await (const u of r.updates({ signal: c.signal })) if (u.frame !== null) c.abort(new Error("at the end"));
    })();
    await expect(p).rejects.toThrow("at the end");
  });

  it("stops on abort", async () => {
    const r = Replay.fromText(recText);
    const c = new AbortController();
    c.abort(new Error("stop"));
    await expect(all(r.updates({ signal: c.signal }))).rejects.toThrow("stop");
    const c2 = new AbortController();
    const clock = new ManualClock();
    const it = r.updates({ signal: c2.signal, pace: "realtime", clock });
    const p = all(it);
    await settle();
    c2.abort(new Error("later"));
    await expect(p).rejects.toThrow("later");
    const c3 = new AbortController();
    const file = await Replay.open(recordingPath("joined-mid-move"));
    const p3 = (async () => {
      for await (const u of file.updates({ signal: c3.signal })) if (u.frame?.g === 405) c3.abort(new Error("mid"));
    })();
    await expect(p3).rejects.toThrow("mid");
  });
});
