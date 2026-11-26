import { describe, expect, it, vi } from "vitest";
import {
  FactoryClient,
  FactoryError,
  seededRandom,
  type Api,
  type Frame,
  type FrameItem,
  type RawItem,
  type StoneLook,
  type StreamItem,
} from "pdigger-factory-sdk";
import { BACKFILL, Deduper, PacketCursors, completeFrame, holdForBackfill } from "../../src/streams.js";
import { InstantClock, ManualClock, settle } from "pdigger-factory-sdk/testing";
import { all, clientOf, fixtureFake, rejection, take, until } from "../helpers/fake.js";
import { card, mkFrame, sip1, stone } from "../helpers/frames.js";

const frames = (items: readonly StreamItem[]): FrameItem[] => items.filter((i): i is FrameItem => i.kind === "frame");
const cursors = (items: readonly StreamItem[]): number[] => frames(items).map((i) => i.frame.cursor);

describe("streams.frames", () => {
  it("yields side events and frames with ids, and closes the connection on break", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    // the recording sends a clock, 12 frames, a worker and 10 frames: break after the worker, mid-stream
    const items = await take(factory.streams.frames({ layers: ["world"] }), 20);
    expect(items[0]?.kind).toBe("clock");
    expect(items.some((i) => i.kind === "worker")).toBe(true);
    const f = frames(items)[0]!;
    expect(f.id).toBe(`fakeboot01-${f.frame.cursor}`);
    expect(f.isRevision).toBe(false);
    expect(f.frame.cards).toBeUndefined();
    await settle();
    expect(fake.streams).toBe(0);
  });

  it("resumes with Last-Event-ID after a dropped connection, without losing or repeating frames", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const factory = clientOf(fake);
    const whole = cursors(await all(factory.streams.frames({ resume: false })));
    fake.dropAfter(7);
    const items: StreamItem[] = [];
    await rejection(
      (async () => {
        for await (const i of factory.streams.frames({ maxReconnects: 1 })) items.push(i);
      })(),
    );
    expect(cursors(items)).toEqual(whole);
    const streams = fake.requests.filter((r) => r.operationId === "streamFrames");
    const ids = streams.map((r) => r.headers.get("last-event-id"));
    expect(ids.some((id) => id !== null && id.startsWith("fakeboot01-"))).toBe(true);
  });

  it("reconnects at once when the server ends a connection after `limit` frames", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const factory = clientOf(fake);
    const items: StreamItem[] = [];
    const err = (await rejection(
      (async () => {
        for await (const i of factory.streams.frames({ limit: 5, maxReconnects: 0 })) items.push(i);
      })(),
    )) as FactoryError;
    expect(err.code).toBe("stream_closed");
    expect(frames(items)).toHaveLength(22);
    expect(fake.requests.filter((r) => r.operationId === "streamFrames").length).toBe(6);
  });

  it("counts `limit` itself: a finished stream the unit holds open is closed, and resumed at once", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close", atLimit: "hold" });
    const factory = clientOf(fake);
    const items: StreamItem[] = [];
    const err = (await rejection(
      (async () => {
        for await (const i of factory.streams.frames({ limit: 5, maxReconnects: 0 })) items.push(i);
      })(),
    )) as FactoryError;
    expect(err.code).toBe("stream_closed");
    expect(cursors(items)).toEqual([...Array(22).keys()].map((k) => 452 + k));
    const reqs = fake.requests.filter((r) => r.operationId === "streamFrames");
    expect(reqs.map((r) => r.query.get("limit"))).toEqual(Array(6).fill("5"));
    expect(reqs.map((r) => r.headers.get("last-event-id"))).toEqual([
      null,
      "fakeboot01-456",
      "fakeboot01-461",
      "fakeboot01-466",
      "fakeboot01-471",
      "fakeboot01-473",
    ]);
    await settle();
    expect(fake.streams).toBe(0); // every held connection was closed by the SDK
    const raw = await fixtureFake("dry1-0296-0306-full", { endOfData: "close", atLimit: "hold" });
    const packets = await rejection(
      (async () => {
        let n = 0;
        for await (const i of clientOf(raw).streams.rawPackets({ limit: 10, maxReconnects: 0 }))
          if (i.kind === "packet" && ++n === 51) throw new Error(`all ${n} packets`);
      })(),
    );
    expect(String(packets)).toContain("all 51 packets");
  });

  it("times `maxS` on the client's clock, reconnecting at once after events and with the backoff after none", async () => {
    // 22 frames over 4.2 media seconds: the fake sends them all, then holds the stream at the end of its data
    const fake = await fixtureFake("joined-mid-move", { atLimit: "hold" });
    const clock = new ManualClock();
    const factory = clientOf(fake, { clock, idleTimeoutMs: 0 });
    const items: StreamItem[] = [];
    const done = rejection(
      (async () => {
        for await (const i of factory.streams.frames({ maxS: 5, maxReconnects: 1 })) items.push(i);
      })(),
    );
    const opened = (): number => fake.requests.filter((r) => r.operationId === "streamFrames").length;
    await until(() => frames(items).length === 22);
    expect(opened()).toBe(1);
    await clock.advance(4999);
    expect(opened()).toBe(1);
    await clock.advance(1); // max_s: closed after events, so reopened at once
    await until(() => opened() === 2);
    expect(fake.requests.at(-1)?.headers.get("last-event-id")).toBe("fakeboot01-473");
    await clock.advance(5000); // max_s without an event: a failure, reopened after the backoff (at most 250 ms)
    await clock.advance(250);
    await until(() => opened() === 3);
    await clock.advance(5000); // a second failure in a row: more than maxReconnects
    expect(((await done) as FactoryError).code).toBe("stream_closed");
    expect(frames(items)).toHaveLength(22);
    const reqs = fake.requests.filter((r) => r.operationId === "streamFrames");
    expect(reqs.map((r) => r.query.get("max_s"))).toEqual(["5", "5", "5"]);
    await settle();
    expect(fake.streams).toBe(0);
  });

  it("ends a connection whose maxS ran out while the consumer was busy, before the next event", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const clock = new ManualClock();
    const factory = clientOf(fake, { clock, idleTimeoutMs: 0 });
    const got: number[] = [];
    for await (const i of factory.streams.frames({ maxS: 1, resume: false })) {
      if (i.kind !== "frame") continue;
      got.push(i.frame.g);
      await clock.advance(600); // a slow consumer: 1.2 s after two frames
    }
    expect(got).toHaveLength(2);
    await settle();
    expect(fake.streams).toBe(0);
  });

  it("closes a connection silent for idleTimeoutMs after it began sending, and leaves a quiet new one open", async () => {
    const fake = await fixtureFake("joined-mid-move"); // holds the stream at the end of its data
    const clock = new ManualClock();
    const factory = clientOf(fake, { clock });
    const items: StreamItem[] = [];
    const c = new AbortController();
    const done = rejection(
      (async () => {
        for await (const i of factory.streams.frames({ signal: c.signal })) items.push(i);
      })(),
    );
    const opened = (): number => fake.requests.filter((r) => r.operationId === "streamFrames").length;
    await until(() => frames(items).length === 22);
    await clock.advance(29_999);
    expect(opened()).toBe(1);
    await clock.advance(1); // 30 s (the default) without a byte: a half-open connection, as far as anyone can tell
    await until(() => opened() === 2);
    expect(fake.requests.at(-1)?.headers.get("last-event-id")).toBe("fakeboot01-473");
    await clock.advance(600_000); // the new connection has sent nothing: a quiet unit, left alone
    expect(opened()).toBe(2);
    expect(fake.streams).toBe(1);
    fake.appendFrames([mkFrame(421, { session: frames(items)[0]!.frame.session })]);
    await until(() => frames(items).length === 23);
    await clock.advance(30_000); // sending again, so watched again
    await until(() => opened() === 3);
    c.abort(new Error("enough"));
    expect(String(await done)).toContain("enough");
    await settle();
    expect(fake.streams).toBe(0);
    const off = await fixtureFake("joined-mid-move");
    const f2 = clientOf(off, { clock: new ManualClock() });
    const it2 = f2.streams.frames({ idleTimeoutMs: 0 });
    await take({ [Symbol.asyncIterator]: () => it2 }, 22 + 2);
    expect(off.requests.filter((r) => r.operationId === "streamFrames")).toHaveLength(1);
  });

  it("keeps a connection that sends bytes without events (comments) open, and closes it once they stop", async () => {
    const clock = new ManualClock();
    const enc = new TextEncoder();
    const pushes: ((text: string) => void)[] = [];
    const lastIds: (string | null)[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      lastIds.push(new Headers(init?.headers).get("last-event-id"));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          pushes.push((text) => controller.enqueue(enc.encode(text)));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
    const factory = new FactoryClient("http://unit.test", { fetch, clock, random: seededRandom(1) });
    const items: StreamItem[] = [];
    const c = new AbortController();
    const done = rejection(
      (async () => {
        for await (const i of factory.streams.frames({ signal: c.signal, idleTimeoutMs: 30_000 })) items.push(i);
      })(),
    );
    await until(() => pushes.length === 1);
    pushes[0]!(`id: b-1\nevent: frame\ndata: ${JSON.stringify(mkFrame(1))}\n\n`);
    await until(() => items.length === 1);
    await clock.advance(20_000);
    pushes[0]!(": still here\n"); // a comment: bytes, no event
    await settle();
    await clock.advance(20_000); // 40 s after the frame, 20 s after the comment
    expect(pushes).toHaveLength(1);
    await clock.advance(20_000); // 30 s after the watchdog saw the comment: closed
    await until(() => pushes.length === 2);
    expect(lastIds).toEqual([null, "b-1"]);
    c.abort(new Error("done"));
    expect(String(await done)).toContain("done");
  });

  it("resumes after a reset from the new boot's cursor", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    fake.failNext("streamFrames", 1, {
      body: 'event: reset\ndata: {"boot":"b2","cursor":7}\n\nevent: reset\ndata: {"boot":1,"cursor":2}\n\n',
      contentType: "text/event-stream",
    });
    const skipped: string[] = [];
    const items = await take(factory.streams.frames({ onDecodeError: (e) => void skipped.push(e.message) }), 3);
    expect(items[0]).toEqual({ kind: "reset", boot: "b2", cursor: 7 });
    expect(skipped).toEqual(["a reset event that does not decode: boot is not a string"]); // and its id moves nothing
    const reqs = fake.requests.filter((r) => r.operationId === "streamFrames");
    expect(reqs.map((r) => r.headers.get("last-event-id"))).toEqual([null, "b2-7"]);
    expect(items[1]).toMatchObject({ kind: "reset", boot: "fakeboot01" }); // another boot for the fake: its own reset
    for (const data of ["5", "{bad"]) {
      fake.failNext("streamFrames", 1, { body: `event: reset\ndata: ${data}\n\n`, contentType: "text/event-stream" });
      const codes: string[] = [];
      const onDecodeError = (e: FactoryError): void => void codes.push(e.code);
      expect(await all(factory.streams.frames({ resume: false, onDecodeError }))).toEqual([]); // skipped (rule 9)
      expect(codes).toEqual(["decode"]);
    }
  });

  it("reads the shared state after every (re)connect when asked (clockOnConnect)", async () => {
    // as on the 20.20 unit: a new stream starts at the newest frame and sends no clock event on connect
    const fake = await fixtureFake("joined-mid-move", { connect: "newest", endOfData: "close" });
    const factory = clientOf(fake);
    const out: StreamItem[] = [];
    const err = await rejection(
      (async () => {
        for await (const i of factory.streams.frames({ clockOnConnect: true, maxReconnects: 0 })) out.push(i);
      })(),
    );
    expect((err as FactoryError).code).toBe("stream_closed");
    expect(fake.requests.map((r) => r.operationId)).toEqual([
      "streamFrames",
      "getSession",
      "streamFrames",
      "getSession",
    ]);
    expect(out.filter((i) => i.kind !== "worker").map((i) => i.kind)).toEqual(["clock", "frame", "clock"]); // then the recording's worker events
    const { media_time: _media, ...state } = fake.state;
    expect(out[0]).toMatchObject({ kind: "clock", state: { ...state } });
    expect(typeof (out[0] as Extract<StreamItem, { kind: "clock" }>).serverNow).toBe("number");
    expect(cursors(out)).toEqual([473]);
    expect(factory.session.lastState).toMatchObject(state); // the client keeps the newest state its streams saw
    const plain = await fixtureFake("joined-mid-move", { connect: "newest", endOfData: "close" });
    await rejection(all(clientOf(plain).streams.frames({ maxReconnects: 0 })));
    expect(plain.requests.map((r) => r.operationId)).toEqual(["streamFrames", "streamFrames"]); // off by default
  });

  it("passes gap and reset events, and a reset for an id of another boot", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    fake.injectGap(4);
    expect((await take(factory.streams.frames(), 2))[0]).toEqual({ kind: "gap", count: 4 });
    fake.injectReset("newboot"); // the unit restarts: its 22 frames are numbered 1 to 22 now
    const after = await take(factory.streams.frames(), 6);
    expect(after[0]).toEqual({ kind: "reset", boot: "newboot", cursor: 22 });
    expect(frames(after)[0]?.id).toBe("newboot-1");
    const other = await take(factory.streams.frames({ lastEventId: "otherboot-5" }), 2);
    expect(other[0]).toMatchObject({ kind: "reset", boot: "newboot" });
  });

  it("flags revisions and drops duplicates", async () => {
    const fake = await fixtureFake("revisions-synthetic", { endOfData: "close" });
    const items = frames(await all(clientOf(fake).streams.frames({ resume: false })));
    expect(items.map((i) => `${i.frame.g}${i.isRevision ? "r" : ""}`)).toEqual([
      "546", "547", "548", "549", "550", "548r", "551", "552", "553", "554", "555", "556",
    ]); // prettier-ignore
  });

  it("starts after a cursor, honours observe, and skips events that do not decode (rule 9)", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const factory = clientOf(fake, { observe: true });
    const items = await all(factory.streams.frames({ after: 463, resume: false }));
    expect(cursors(items)[0]).toBe(464);
    expect(fake.requests.at(-1)?.query.get("observe")).toBe("1");
    const bad = {
      body:
        "event: frame\ndata: [1]\n\nevent: frame\ndata: {nope\n\nevent: clock\ndata: 5\n\n" +
        'event: x\ndata: 1\n\nevent: gap\ndata: {"gap":2}\n\n',
      contentType: "text/event-stream",
    };
    const errors: string[] = [];
    const onDecodeError = (e: FactoryError): void => void errors.push(`${e.code}: ${e.message}`);
    fake.failNext("streamFrames", 1, bad);
    const kinds = (await all(factory.streams.frames({ resume: false, onDecodeError }))).map((i) => i.kind);
    expect(kinds).toEqual(["gap"]); // the stream went on past the three
    expect(errors).toEqual([
      "decode: a frame event that does not decode: not an object",
      "decode: stream event frame: data is not JSON",
      "decode: a clock event that does not decode: not an object",
    ]);
    fake.failNext("streamFrames", 1, bad); // without the option they are skipped silently
    expect((await all(factory.streams.frames({ resume: false }))).map((i) => i.kind)).toEqual(["gap"]);
    fake.failNext("streamFrames", 1, { body: "event: other\ndata: 1\n\n", contentType: "text/event-stream" });
    expect(await all(factory.streams.frames({ resume: false }))).toEqual([]);
  });

  it("throws errors it cannot cure, and the first connection's error", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const factory = clientOf(fake, { retries: 0 });
    fake.failNext("streamFrames", 1, "network");
    expect(((await rejection(all(factory.streams.frames()))) as FactoryError).code).toBe("transport");
    fake.dropAfter(3);
    fake.failNext("streamFrames", 1, { status: 400, body: { error: "bad", code: "invalid_param" } });
    const items: StreamItem[] = [];
    let failed = false;
    try {
      for await (const i of factory.streams.frames()) {
        items.push(i);
        if (items.length === 3)
          fake.failNext("streamFrames", 1, { status: 400, body: { error: "bad", code: "invalid_param" } });
      }
    } catch (err) {
      failed = (err as FactoryError).code === "invalid_param";
    }
    expect(failed).toBe(true);
  });

  it("waits the server's retry_ms after a busy reply, then goes on", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const clock = new InstantClock();
    const sleep = vi.spyOn(clock, "sleep");
    const factory = clientOf(fake, { clock, retries: 0 });
    fake.dropAfter(4);
    const items: StreamItem[] = [];
    await rejection(
      (async () => {
        for await (const i of factory.streams.frames({ maxReconnects: 2 })) {
          items.push(i);
          if (items.length === 4)
            fake.failNext("streamFrames", 1, { status: 503, body: { error: "busy", code: "busy", retry_ms: 1234 } });
        }
      })(),
    );
    expect(sleep.mock.calls.map((c) => c[0])).toContain(1234);
    expect(frames(items)).toHaveLength(22);
  });

  it("gives up with the last error after maxReconnects failed reconnects", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake, { retries: 0 });
    fake.dropAfter(3);
    const items: StreamItem[] = [];
    const err = (await rejection(
      (async () => {
        for await (const i of factory.streams.frames({ maxReconnects: 1 })) {
          // connected: from now on every reconnect is refused
          if (items.push(i) === 1)
            fake.failNext("streamFrames", 2, { status: 503, body: { error: "busy", code: "busy" } });
        }
      })(),
    )) as FactoryError;
    expect([err.status, err.code]).toEqual([503, "busy"]);
    expect(items).toHaveLength(3);
  });

  it("stops with the caller's abort reason", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const c = new AbortController();
    const items: StreamItem[] = [];
    const err = await rejection(
      (async () => {
        for await (const i of factory.streams.frames({ signal: c.signal })) {
          items.push(i);
          if (frames(items).length === 22) setTimeout(() => c.abort(new Error("enough")), 0);
        }
      })(),
    );
    expect(String(err)).toContain("enough");
    await settle();
    expect(fake.streams).toBe(0);
  });
});

describe("backfill", () => {
  it("holds a late frame and those after it, reads its layers back, and releases them in order", async () => {
    const fake = await fixtureFake("joined-mid-move", {
      endOfData: "close",
      late: { g: [402, 404], layers: ["world"] },
    });
    const factory = clientOf(fake);
    const items = frames(await all(factory.streams.frames({ resume: false, backfill: true })));
    expect(items.map((i) => i.frame.g)).toEqual([...Array(22).keys()].map((k) => 399 + k));
    const late = items.filter((i) => i.isBackfill).map((i) => i.frame.g);
    expect(late).toEqual([402, 404]);
    expect(items.every((i) => i.frame.world !== undefined && i.frame.missing === undefined)).toBe(true);
    const reads = fake.requests.filter((r) => r.operationId === "getFrame");
    expect(reads.map((r) => r.query.get("layers"))).toEqual(["world", "world"]);
    const plain = frames(await all(factory.streams.frames({ resume: false })));
    expect(plain.find((i) => i.frame.g === 402)?.frame.missing).toEqual(["world"]);
  });

  it("reads late layers back in the stream's precision", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close", late: { g: [402], layers: ["world"] } });
    const items = frames(
      await all(clientOf(fake).streams.frames({ resume: false, backfill: true, precision: "full" })),
    );
    expect(items.find((i) => i.frame.g === 402)?.isBackfill).toBe(true);
    const reads = fake.requests.filter((r) => r.operationId === "getFrame");
    expect(reads.map((r) => [r.query.get("layers"), r.query.get("precision")])).toEqual([["world", "full"]]);
  });

  it("drops a streamed look that does not fit, and keeps its stone", async () => {
    // 4.6.2: a look outside the schema is no look, from the stream as from every other reader
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const look: StoneLook = {
      v: 1,
      g: 420,
      nu: 1,
      nv: 1,
      d: "AA==",
      sp: 0.01,
      q: 0.9,
      px: [1, 1],
      at: { cx: 0, cy: 0, theta: 0, L: 0.3, S: 0.2 },
    };
    const stones = [stone(7, [0, 0, 0.05], { look: {} as StoneLook }), stone(8, [0.4, 0, 0.05], { look }), stone(9)];
    fake.appendFrames([{ ...mkFrame(421, { session: fake.state.session, stones }), cursor: 9000 }]);
    const items = frames(await all(clientOf(fake).streams.frames({ resume: false })));
    const last = items.find((i) => i.frame.cursor === 9000)?.frame.world?.stones;
    expect(last?.map((s) => [s.id, s.look === undefined ? "no look" : s.look.d])).toEqual([
      [7, "no look"],
      [8, "AA=="],
      [9, "no look"],
    ]);
  });

  it("stops while the source is waiting for more frames", async () => {
    const fake = await fixtureFake("joined-mid-move", { late: { g: [420], layers: ["world"] } });
    let last: FrameItem | null = null;
    for await (const i of clientOf(fake).streams.frames({ backfill: true })) {
      if (i.kind === "frame" && i.frame.g === 420) {
        last = i;
        break;
      }
    }
    expect(last?.isBackfill).toBe(true);
    await settle();
    expect(fake.streams).toBe(0);
  });

  it("releases a frame unchanged when its layers stay missing", async () => {
    const fake = await fixtureFake("dry2-0582-0600", { endOfData: "close" });
    const clock = new InstantClock();
    const items = frames(await all(clientOf(fake, { clock }).streams.frames({ resume: false, backfill: true })));
    const missing = items.filter((i) => i.frame.missing !== undefined);
    expect(missing.length).toBe(13);
    expect(missing.every((i) => !i.isBackfill)).toBe(true);
    expect(items.map((i) => i.frame.g)).toEqual([...items.map((i) => i.frame.g)].sort((a, b) => a - b));
  });

  it("completeFrame: retries other errors, gives up on not_retained and session_gone, follows the timing", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const clock = new ManualClock();
    const f = mkFrame(410, { session: (await factory.api.getSession()).state.session, missing: ["world"] });
    f.cursor = 463;
    delete f.world;
    fake.failNext("getFrame", 1, { status: 500, body: { error: "x", code: "internal" } });
    const signal = new AbortController().signal;
    const p = completeFrame(factory.api, clock, f, signal);
    await clock.advance(BACKFILL.delayMs);
    expect(fake.requests.filter((r) => r.operationId === "getFrame")).toHaveLength(1);
    await clock.advance(BACKFILL.spacingMs);
    const full = await p;
    expect(full?.world?.g).toBe(410);
    expect(full?.missing).toBeUndefined();
    fake.failNext("getFrame", 1, "getFrame-404");
    expect(await completeFrame(factory.api, new InstantClock(), f, signal)).toBeNull();
    fake.failNext("getFrame", 1, "getFrame-410");
    expect(await completeFrame(factory.api, new InstantClock(), f, signal)).toBeNull();
    fake.failNext("getFrame", 3, { status: 500, body: { error: "x", code: "internal" } });
    expect(await completeFrame(factory.api, new InstantClock(), f, signal)).toBeNull();
    const whole = mkFrame(405, { session: f.session });
    expect((await completeFrame(factory.api, new InstantClock(), whole, signal))?.g).toBe(405);
    const c = new AbortController();
    fake.failNext("getFrame", 1, { status: 500, body: { error: "x", code: "internal" } });
    const aborting = completeFrame(factory.api, { now: () => 0, sleep: () => Promise.resolve() }, f, c.signal, {
      delayMs: 0,
      tries: 2,
      spacingMs: 0,
    });
    c.abort(new Error("stop"));
    expect(String(await rejection(aborting))).toContain("stop");
  });

  it("completeFrame: each read is one request bounded by readTimeoutMs, due on a fixed schedule", async () => {
    const fake = await fixtureFake("joined-mid-move");
    let reads = 0;
    const factory = new FactoryClient("http://fake.factory", {
      clock: new InstantClock(),
      random: seededRandom(7),
      fetch: (input, init) => {
        if (!String(input).includes("/frames/410")) return fake.fetch(input, init);
        reads++;
        const signal = init?.signal as AbortSignal; // the request's timeout aborts it
        return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
    });
    const f = mkFrame(410, { session: (await factory.api.getSession()).state.session, missing: ["world"] });
    const timing = { delayMs: 1500, tries: 3, spacingMs: 1000, readTimeoutMs: 5 };
    const clock = new ManualClock();
    const p = completeFrame(factory.api, clock, f, new AbortController().signal, timing);
    await clock.advance(1500);
    await until(() => reads === 1);
    await clock.advance(999); // a read that took long does not move the next one
    expect(reads).toBe(1);
    await clock.advance(1);
    await until(() => reads === 2);
    await clock.advance(1000);
    expect(await p).toBeNull();
    expect(reads).toBe(3); // no retries
  });

  it("completeFrame keeps the layers each try read and asks only for the rest", async () => {
    const f = mkFrame(7, { missing: ["world", "cards"] });
    const world = f.world;
    delete f.world;
    const asked: string[] = [];
    const replies: (Partial<Frame> | Error)[] = [];
    const api = {
      getFrame: (_g: number, p: { layers: string[]; precision?: string }): Promise<Frame> => {
        asked.push(`${p.layers.join(",")}${p.precision === undefined ? "" : ` ${p.precision}`}`);
        const r = replies.shift() as Partial<Frame> | Error;
        return r instanceof Error ? Promise.reject(r) : Promise.resolve({ ...mkFrame(7, { world: false }), ...r });
      },
    } as unknown as Api;
    const signal = new AbortController().signal;
    const cards = card("Holding a stone");
    // the world comes first, the cards on the next try: both are kept
    replies.push({ world, missing: ["cards"] }, { cards });
    const full = await completeFrame(api, new InstantClock(), f, signal, BACKFILL, "full");
    expect(asked).toEqual(["world,cards full", "cards full"]);
    expect([full?.world, full?.cards, full?.missing]).toEqual([world, cards, undefined]);
    // the world comes, then the cards never: the frame with its world, still missing its cards
    asked.length = 0;
    const internal = new FactoryError({ code: "internal", message: "x", status: 500 });
    replies.push({ world, missing: ["cards"] }, internal, internal);
    const part = await completeFrame(api, new InstantClock(), f, signal);
    expect(asked).toEqual(["world,cards", "cards", "cards"]);
    expect([part?.world, part?.cards, part?.missing]).toEqual([world, undefined, ["cards"]]);
    // the frame is gone after the world came: what came is kept too
    replies.push({ world, missing: ["cards"] }, new FactoryError({ code: "not_retained", message: "x", status: 404 }));
    expect((await completeFrame(api, new InstantClock(), f, signal))?.missing).toEqual(["cards"]);
    expect(f.missing).toEqual(["world", "cards"]); // the frame itself is never changed
  });

  it("holdForBackfill waits for the source alone while it holds nothing", async () => {
    const plain = (g: number): FrameItem => ({
      kind: "frame",
      frame: mkFrame(g),
      id: null,
      isRevision: false,
      isBackfill: false,
    });
    async function* source(): AsyncGenerator<StreamItem> {
      for (let g = 0; g < 50; g++) yield plain(g);
    }
    const race = vi.spyOn(Promise, "race");
    try {
      const out = await all(holdForBackfill(source(), () => Promise.resolve(null), new AbortController().signal));
      expect(out).toHaveLength(50);
      expect(race).not.toHaveBeenCalled(); // no wake-up reaction left behind per frame
    } finally {
      race.mockRestore();
    }
  });

  it("holdForBackfill passes side items, survives a failing completion, and waits for held frames at the end", async () => {
    const item = (g: number, late = false): FrameItem => ({
      kind: "frame",
      frame: mkFrame(g, late ? { missing: ["world"] } : {}),
      id: null,
      isRevision: false,
      isBackfill: false,
    });
    async function* source(): AsyncGenerator<StreamItem> {
      yield item(1, true);
      yield { kind: "gap", count: 1 };
      yield item(2);
      yield item(3, true);
    }
    let calls = 0;
    const complete = async (frame: { g: number }): Promise<null> => {
      calls++;
      await new Promise((r) => setTimeout(r, 1));
      if (frame.g === 3) throw new Error("cannot");
      return null;
    };
    const out = await all(holdForBackfill(source(), complete as never, new AbortController().signal));
    expect(out.map((i) => (i.kind === "frame" ? i.frame.g : i.kind))).toEqual(["gap", 1, 2, 3]);
    expect(calls).toBe(2);
  });
});

describe("Deduper", () => {
  it("forgets the oldest keys beyond its bound", () => {
    const d = new Deduper();
    const it = (g: number, rev = 0): FrameItem => ({
      kind: "frame",
      frame: mkFrame(g, { rev }),
      id: null,
      isRevision: false,
      isBackfill: false,
    });
    for (let g = 0; g <= 8192; g++) expect(d.check(it(g))).not.toBeNull();
    expect(d.check(it(0))).not.toBeNull();
    expect(d.check(it(8192))).toBeNull();
    expect(d.check(it(8192, 1))?.isRevision).toBe(true);
    const nw = mkFrame(9000, { world: false });
    expect(d.check({ kind: "frame", frame: nw, id: null, isRevision: false, isBackfill: false })).not.toBeNull();
  });
});

describe("streams.poll", () => {
  it("long-polls frames with a viewer id, yielding clock and worker changes", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const items: StreamItem[] = [];
    for await (const i of factory.streams.poll({ layers: "world", limit: 16, wait: 0 })) {
      items.push(i);
      if (frames(items).length === 20) await factory.api.sessionPause();
      if (frames(items).length === 22 && items.filter((x) => x.kind === "clock").length === 2) break;
    }
    expect(items[0]?.kind).toBe("clock");
    expect(items[1]?.kind).toBe("worker");
    expect(cursors(items)).toEqual([...Array(22).keys()].map((k) => 452 + k));
    const cid = fake.requests.find((r) => r.operationId === "pollFrames")?.query.get("cid");
    expect(cid).toMatch(/^sdk-ts-[A-Za-z0-9]{16}$/);
    const observing = clientOf(fake, { observe: true });
    await take(observing.streams.poll({ cursor: 463, cid: "ignored-when-observing" }), 2);
    expect(fake.requests.at(-1)?.query.get("cid")).toBeNull();
    await take(factory.streams.poll({ cid: "my-viewer-01", cursor: 463 }), 1);
    expect(fake.requests.at(-1)?.query.get("cid")).toBe("my-viewer-01");
  });

  it("sees a new worker status, frames appended later, and backfills", async () => {
    const fake = await fixtureFake("joined-mid-move", { late: { g: (f) => f.g === 400, layers: ["world"] } });
    const factory = clientOf(fake);
    const items: StreamItem[] = [];
    for await (const i of factory.streams.poll({ backfill: true, wait: 1000 })) {
      items.push(i);
      if (frames(items).length === 22) {
        fake.appendSide("worker", { state: "idle", reason: "no viewers", fps: 0, session: null, g: null, errors: 0 });
        fake.appendFrames([{ ...mkFrame(421, { session: frames(items)[0]!.frame.session }), cursor: 9000 }]);
      }
      if (frames(items).length === 23) break;
    }
    expect(frames(items).find((i) => i.frame.g === 400)?.isBackfill).toBe(true);
    expect(items.filter((i) => i.kind === "worker").map((i) => (i.kind === "worker" ? i.worker.state : ""))).toEqual([
      "running",
      "idle",
    ]);
    expect(cursors(items).at(-1)).toBe(9000);
  });

  it("polls and reads late layers back in the poll's precision", async () => {
    const fake = await fixtureFake("joined-mid-move", { late: { g: [402], layers: ["world"] } });
    const items: FrameItem[] = [];
    for await (const i of clientOf(fake).streams.poll({ backfill: true, precision: "full", wait: 0 })) {
      if (i.kind === "frame") items.push(i);
      if (items.length === 22) break;
    }
    expect(items.find((i) => i.frame.g === 402)?.isBackfill).toBe(true);
    const asked = (id: string): (string | null)[][] =>
      fake.requests.filter((r) => r.operationId === id).map((r) => [r.query.get("layers"), r.query.get("precision")]);
    expect(asked("getFrame")).toEqual([["world", "full"]]);
    expect(new Set(asked("pollFrames").map(([, precision]) => precision))).toEqual(new Set(["full"]));
  });

  it("fails on the first poll, retries later failures up to maxReconnects", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake, { retries: 0 });
    fake.failNext("pollFrames", 1, "network");
    expect(((await rejection(take(factory.streams.poll(), 1))) as FactoryError).code).toBe("transport");
    const clock = new InstantClock();
    const sleep = vi.spyOn(clock, "sleep");
    const f2 = clientOf(fake, { retries: 0, clock });
    const items: StreamItem[] = [];
    const err = (await rejection(
      (async () => {
        for await (const i of f2.streams.poll({ maxReconnects: 1, limit: 16 })) {
          items.push(i);
          if (items.length === 3)
            fake.failNext("pollFrames", 2, { status: 503, body: { error: "busy", code: "busy", retry_ms: 50 } });
        }
      })(),
    )) as FactoryError;
    expect(err.code).toBe("busy");
    expect(sleep.mock.calls.map((c) => c[0])).toContain(50);
    const f3 = clientOf(fake, { retries: 0 });
    const it3 = f3.streams.poll({ limit: 16 });
    await it3.next();
    fake.failNext("pollFrames", 1, { status: 400, body: { error: "bad", code: "invalid_param" } });
    const err3 = (await rejection(
      (async () => {
        for (;;) if ((await it3.next()).done) break;
      })(),
    )) as FactoryError;
    expect(err3.code).toBe("invalid_param");
    const c = new AbortController();
    const aborted = rejection(take(f3.streams.poll({ signal: c.signal, cursor: 99_999 }), 5));
    await settle();
    c.abort(new Error("bye"));
    expect(String(await aborted)).toContain("bye");
    const fails = clientOf(fake, { retries: 0 });
    const it4 = fails.streams.poll({ limit: 16 });
    await it4.next();
    fake.failNext("pollFrames", 2, "network");
    const res: StreamItem[] = [];
    for await (const i of { [Symbol.asyncIterator]: () => it4 }) {
      res.push(i);
      if (frames(res).length >= 20) break;
    }
    expect(frames(res).length).toBe(20);
  });
});

describe("streams.rawPackets", () => {
  it("streams packets over SSE and NDJSON, resuming without repeats", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full", { endOfData: "close" });
    const factory = clientOf(fake);
    const sse = await all(factory.streams.rawPackets({ resume: false }));
    const packets = sse.filter((i) => i.kind === "packet");
    expect(packets).toHaveLength(51);
    expect(packets[0]).toMatchObject({ kind: "packet", id: "fakeboot01-1533" });
    fake.dropAfter(10);
    const resumed: number[] = [];
    await rejection(
      (async () => {
        for await (const i of factory.streams.rawPackets({ maxReconnects: 1 }))
          if (i.kind === "packet") resumed.push(i.packet.cursor as number);
      })(),
    );
    expect(resumed).toEqual(packets.map((p) => (p.kind === "packet" ? p.packet.cursor : -1)));
    fake.dropAfter(10);
    const nd: number[] = [];
    await rejection(
      (async () => {
        for await (const i of factory.streams.rawPackets({ format: "ndjson", maxReconnects: 1, after: 1532 })) {
          if (i.kind === "packet") nd.push(i.packet.cursor as number);
        }
      })(),
    );
    expect(nd).toEqual(resumed);
    expect(
      fake.requests
        .filter((r) => r.operationId === "rawStream")
        .at(-2)
        ?.query.get("after"),
    ).not.toBeNull();
  });

  it("passes packets without a cursor, skips repeated cursors, and yields side events", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full");
    const factory = clientOf(fake);
    fake.failNext("rawStream", 1, {
      body:
        `event: frame\ndata: ${sip1({ cursor: undefined })}\n\n` +
        `event: frame\ndata: ${sip1({ cursor: 5 })}\n\n` +
        `event: frame\ndata: ${sip1({ cursor: 5 })}\n\n` +
        "event: frame\ndata: {cut\n\nevent: frame\ndata: 7\n\nevent: gap\ndata: 2\n\n" +
        'event: gap\ndata: {"gap":2}\n\n' +
        "event: unknown\ndata: {}\n\n",
      contentType: "text/event-stream",
    });
    const errors: string[] = [];
    const items = await all(
      factory.streams.rawPackets({ resume: false, observe: true, onDecodeError: (e) => void errors.push(e.message) }),
    );
    expect(items.map((i) => i.kind)).toEqual(["packet", "packet", "gap"]);
    expect(errors).toEqual([
      "stream event frame: data is not JSON",
      "a packet event that does not decode: not an object",
      "a gap event that does not decode: not an object",
    ]);
    const c = new AbortController();
    const p = rejection(all(factory.streams.rawPackets({ signal: c.signal, lastEventId: "fakeboot01-1593" })));
    await settle();
    c.abort(new Error("stop"));
    expect(String(await p)).toContain("stop");
  });

  const packet = (g: number, cursor: number, boot?: string): string =>
    `${boot === undefined ? "" : `id: ${boot}-${cursor}\n`}event: frame\ndata: ${sip1({ g, cursor })}\n\n`;
  const sse = (body: string) => ({ body, contentType: "text/event-stream" });
  const ndjson = (...lines: [number, number][]) => ({
    body: lines.map(([g, cursor]) => `${sip1({ g, cursor })}\n`).join(""),
    contentType: "application/x-ndjson",
  });
  const gs = (items: readonly RawItem[]): string[] =>
    items.map((i) => (i.kind === "packet" ? `${i.packet.g}@${i.packet.cursor}` : i.kind));

  it("goes on after a reset whose new boot's cursors start below the old ones (SSE)", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full");
    const factory = clientOf(fake);
    fake.failNext("rawStream", 1, sse(packet(10, 100, "bootA") + packet(11, 101, "bootA")));
    fake.failNext("rawStream", 1, {
      ...sse(`event: reset\ndata: {"boot":"bootB","cursor":5}\n\n${packet(12, 6, "bootB")}${packet(13, 7, "bootB")}`),
    });
    fake.failNext("rawStream", 1, sse(packet(14, 8, "bootB") + packet(14, 8, "bootB") + packet(13, 7, "bootB")));
    const items = await take(factory.streams.rawPackets(), 6);
    expect(gs(items)).toEqual(["10@100", "11@101", "reset", "12@6", "13@7", "14@8"]);
    const reqs = fake.requests.filter((r) => r.operationId === "rawStream");
    expect(reqs.map((r) => r.headers.get("last-event-id"))).toEqual([null, "bootA-101", "bootB-7"]);
    expect(reqs.map((r) => r.query.get("after"))).toEqual([null, null, null]);
    // a frame id of another boot starts a new count too, without a reset item
    fake.failNext("rawStream", 1, sse(packet(20, 200, "bootC") + packet(21, 3, "bootD") + packet(21, 3, "bootD")));
    expect(gs(await take(factory.streams.rawPackets({ resume: false }), 3))).toEqual(["20@200", "21@3"]);
  });

  it("passes on the lower cursors of a restarted unit over NDJSON, and resumes after them", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full");
    const factory = clientOf(fake);
    fake.failNext("rawStream", 1, ndjson([10, 100], [11, 101]));
    fake.failNext("rawStream", 1, ndjson([12, 6], [13, 7], [13, 7])); // restarted: below 101, and a repeat
    fake.failNext("rawStream", 1, ndjson([14, 8]));
    const items = await take(factory.streams.rawPackets({ format: "ndjson", after: 99 }), 5);
    expect(gs(items)).toEqual(["10@100", "11@101", "12@6", "13@7", "14@8"]);
    const reqs = fake.requests.filter((r) => r.operationId === "rawStream");
    expect(reqs.map((r) => r.query.get("after"))).toEqual(["99", "101", "7"]);
    expect(reqs.every((r) => r.headers.get("last-event-id") === null && r.query.get("format") === "ndjson")).toBe(true);
    // a new connection that starts above the newest is the same boot going on
    fake.failNext("rawStream", 1, ndjson([30, 50]));
    fake.failNext("rawStream", 1, ndjson([31, 51], [30, 50]));
    expect(gs(await take(factory.streams.rawPackets({ format: "ndjson" }), 2))).toEqual(["30@50", "31@51"]);
  });

  it("follows the unit through a restart of the fake (SSE): the old connection breaks, the new boot's packets follow", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full");
    const factory = clientOf(fake);
    const seen: RawItem[] = [];
    for await (const item of factory.streams.rawPackets()) {
      seen.push(item);
      const packets = seen.filter((i) => i.kind === "packet").length;
      if (item.kind === "packet" && packets === 3) fake.injectReset("boot2"); // the unit restarts mid-stream
      if (packets === 8) break;
    }
    const after = seen.slice(seen.findIndex((i) => i.kind === "reset"));
    expect(after[0]).toEqual({ kind: "reset", boot: "boot2", cursor: 51 }); // 51 packets, numbered from 1 again
    const ids = seen.flatMap((i) => (i.kind === "packet" ? [i.id] : []));
    expect(ids).toEqual([
      "fakeboot01-1533", "fakeboot01-1534", "fakeboot01-1535", "boot2-1", "boot2-2", "boot2-3", "boot2-4", "boot2-5",
    ]); // prettier-ignore
    const reqs = fake.requests.filter((r) => r.operationId === "rawStream");
    expect(reqs.map((r) => r.headers.get("last-event-id"))).toEqual([null, "fakeboot01-1535"]);
    await settle();
    expect(fake.streams).toBe(0);
  });
});

describe("PacketCursors", () => {
  it("keys repeats on the boot and the cursor", () => {
    const c = new PacketCursors();
    expect(c.newest).toBe(-1);
    expect([c.pass("a-5", 5), c.pass("a-5", 5), c.pass("a-4", 4), c.pass("a-6", 6)]).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(c.pass(null, null)).toBe(true); // no cursor: passed on, the count unchanged
    expect(c.newest).toBe(6);
    c.reset("b");
    expect([c.newest, c.pass("b-1", 1), c.pass("bad", 1)]).toEqual([-1, true, false]); // an id without a boot
    c.connected();
    expect([c.pass(null, 1), c.newest]).toEqual([true, 1]); // NDJSON: a new connection at or below the newest
    expect(c.pass(null, 1)).toBe(false); // within a connection, a repeat
  });
});
