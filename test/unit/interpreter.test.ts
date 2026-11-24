import { afterEach, describe, expect, it, vi } from "vitest";
import type { Interpreter } from "pdigger-factory-sdk";
import {
  FactoryClient,
  FactoryError,
  LIVE_ID,
  describeSpeckleTxt,
  Session,
  SessionClock,
  Source,
  UNTIL_LIVE_POLL_MS,
  type FactoryEvent,
  type State,
  type Update,
  type VideoList,
} from "pdigger-factory-sdk";
import {
  CONNECT_S,
  FakeFactory,
  InstantClock,
  LIVE_CAMERA,
  LIVE_LAG_S,
  ManualClock,
  settle,
} from "pdigger-factory-sdk/testing";
import { mkFrame } from "../helpers/frames.js";
import { all, clientOf, fixtureFake, joinAtStart, rejection, take } from "../helpers/fake.js";
import { readJson, readText, recordingNames } from "../helpers/fixtures.js";

afterEach(() => vi.unstubAllEnvs());

/** The six plant cameras the unit lists after its recordings (fixtures/api/listVideos.json), in its order. */
const PLANT_CAMERAS = ["CAM00000001", "CAM00000002", "CAM00000003", "CAM00000004", "CAM00000005", "CAM00000006"];

describe("Interpreter", () => {
  it("prints the golden sentences of a recording, live", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const factory = clientOf(fake);
    const interp = factory.interpreter({ observe: true, maxReconnects: 0 });
    const lines: string[] = [];
    await rejection(
      (async () => {
        for await (const e of interp.events()) lines.push(e.describe());
      })(),
    );
    expect(`${lines.join("\n")}\n`).toBe(readText("golden/joined-mid-move.events.txt"));
    expect(fake.requests.find((r) => r.operationId === "streamFrames")?.query.get("layers")).toBe("world,cards");
    expect(interp.summary().frames).toBe(22);
    expect(interp.state.g).toBe(420);
    expect(interp.worker?.state).toBeDefined();
    expect(interp.sessionState?.video).toBe("dry1");
    expect(interp.lastEventId).toMatch(/^fakeboot01-/);
    expect(interp.finish().map((a) => a.describe())).toEqual([]);
  });

  it("shares one stream between consumers and closes it when the last leaves", async () => {
    const fake = await fixtureFake("dry1-0000-0130");
    const interp = clientOf(fake).interpreter();
    const a = interp.updates();
    const b = interp.updates();
    expect(interp.consumers).toBe(0); // an iteration joins at its first next()
    expect(fake.streams).toBe(0);
    const [ua, ub] = await Promise.all([a.next(), b.next()]);
    expect(interp.consumers).toBe(2);
    expect(ua.value).toBe(ub.value);
    expect(fake.requests.filter((r) => r.operationId === "streamFrames")).toHaveLength(1);
    expect(fake.streams).toBe(1);
    await a.return?.();
    expect(interp.consumers).toBe(1);
    await b.return?.();
    await settle();
    expect(interp.consumers).toBe(0);
    expect(fake.streams).toBe(0);
    const again = await take(interp.updates(), 1);
    expect(again).toHaveLength(1);
    expect(
      fake.requests
        .filter((r) => r.operationId === "streamFrames")
        .at(-1)
        ?.headers.get("last-event-id"),
    ).toMatch(/^fakeboot01-/);
  });

  it("filters events by type, lists activities, and waits for an event", async () => {
    const fake = await fixtureFake("dry1-0000-0130", { endOfData: "close" });
    const factory = clientOf(fake);
    const lifts = await take(factory.interpreter().events({ types: ["lift"] }), 2);
    expect(lifts.map((e) => e.type)).toEqual(["lift", "lift"]);
    const acts = await take(factory.interpreter().activities(), 3);
    expect(acts.map((a) => a.describe())).toEqual(
      readText("golden/dry1-0000-0130.activities.txt").split("\n").slice(0, 3),
    );
    const i = factory.interpreter();
    expect((await i.waitFor("drop")).type).toBe("drop");
    expect((await i.waitFor(["place", "gone"])).type).toMatch(/place|gone/);
    expect((await i.waitFor((e: FactoryEvent) => e.type === "split" || e.type === "delete")).type).toMatch(
      /split|delete/,
    );
    const none = factory.interpreter({ observe: true, maxReconnects: 0 });
    const err = (await rejection(none.waitFor("teleport"))) as FactoryError;
    expect(err.code).toBe("stream_closed");
  });

  it("goes on where the last loop stopped: the rest of its frame first, then the frames after it", async () => {
    const golden = readText("golden/dry1-0296-0306-full.events.txt")
      .split("\n")
      .filter((l) => l !== "");
    const i = clientOf(await fixtureFake("dry1-0296-0306-full", { endOfData: "close" })).interpreter({ resume: false });
    const lift = await i.waitFor("lift");
    expect(lift.describe()).toBe("5:01.6 Right hand lifts stone 643");
    const rest = (await all(i.events())).map((e) => e.describe());
    expect(rest).toEqual(golden.slice(golden.indexOf(lift.describe()) + 1));
    // an activities loop that stops inside a frame leaves the rest of it too
    const whole = (
      await all(
        clientOf(await fixtureFake("dry1-0296-0306-full", { endOfData: "close" }))
          .interpreter({ resume: false })
          .activities(),
      )
    ).map((a) => a.describe());
    const j = clientOf(await fixtureFake("dry1-0296-0306-full", { endOfData: "close" })).interpreter({ resume: false });
    const first = (await take(j.activities(), 1)).map((a) => a.describe());
    const later = (await all(j.activities())).map((a) => a.describe());
    expect([...first, ...later]).toEqual(whole);
  });

  it("times out waitFor on the client's clock, and honours abort", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const clock = new ManualClock();
    const factory = clientOf(fake, { clock });
    const interp = factory.interpreter();
    const p = rejection(interp.waitFor("teleport", { timeout: 2000 }));
    await clock.advance(2000);
    const err = (await p) as DOMException;
    expect(err.name).toBe("TimeoutError");
    const ok = await factory.interpreter().waitFor("push", { timeout: 5000 });
    expect(ok.type).toBe("push");
    const c = new AbortController();
    c.abort(new Error("no"));
    expect(String(await rejection(interp.waitFor("lift", { signal: c.signal })))).toContain("no");
    const c2 = new AbortController();
    const it = interp.updates({ signal: c2.signal });
    const pending = rejection(all(it));
    await settle();
    c2.abort(new Error("later"));
    expect(String(await pending)).toContain("later");
  });

  it("passes stream errors to every consumer, and refuses to iterate when closed", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake, { retries: 0 });
    fake.failNext("streamFrames", 1, { status: 400, body: { error: "no", code: "unknown_layer", field: "layers" } });
    const interp = factory.interpreter({ layers: ["world"] });
    const err = (await rejection(all(interp.updates()))) as FactoryError;
    expect(err.code).toBe("unknown_layer");
    const i2 = factory.interpreter();
    const consumer = all(i2.updates());
    await settle();
    factory.close();
    expect(Array.isArray(await consumer)).toBe(true);
    expect(() => i2.updates()).toThrow(FactoryError);
  });

  it("long-polls when asked, resumes from an event id, keeps backpressure and backfill flags", async () => {
    const fake = await fixtureFake("joined-mid-move", { late: { g: [401], layers: ["world"] } });
    const factory = clientOf(fake);
    const polled = await take(factory.interpreter({ transport: "poll", observe: true }).updates(), 22);
    expect(polled.map((u) => u.frame?.g)).toEqual([...Array(22).keys()].map((k) => 399 + k));
    expect(polled.find((u) => u.frame?.g === 401)?.isBackfill).toBe(true);
    const resumed = factory.interpreter({ lastEventId: "fakeboot01-463", highWaterMark: 1 });
    const ups: Update[] = await take(resumed.updates(), 3);
    expect(ups[0]?.frame?.cursor).toBe(464);
    const after = await take(factory.interpreter({ after: 468, backfill: false }).updates(), 1);
    expect(after[0]?.frame?.cursor).toBe(469);
    // back-pressure: the stream waits for a consumer that has more than highWaterMark updates waiting
    const slow = factory.interpreter({ highWaterMark: 2 });
    const fast = slow.updates();
    const lazy = slow.updates();
    const [f1, l1] = await Promise.all([fast.next(), lazy.next()]); // both join, then lazy stops reading
    expect(l1.value).toBe(f1.value);
    const more = [await fast.next(), await fast.next(), await fast.next()]; // lazy has 3 waiting: the stream waits
    let got5 = false;
    const p5 = fast.next().then(() => (got5 = true));
    await settle();
    expect(got5).toBe(false);
    expect((await lazy.next()).value).toBe(more[0]?.value); // lazy catches up, and the stream reads on
    await p5;
    expect(got5).toBe(true);
    await lazy.return?.();
    await fast.return?.();
    // an iteration made but never read joins nothing, opens nothing and holds nobody up
    const idle = factory.interpreter({ highWaterMark: 1 });
    const never = idle.updates();
    expect([idle.consumers, (await take(idle.updates(), 5)).length, idle.consumers]).toEqual([0, 5, 0]);
    expect(await never.return?.()).toEqual({ value: undefined, done: true });
    expect(await never.next()).toEqual({ value: undefined, done: true });
    const beforeClose = idle.updates();
    idle.close();
    expect(await beforeClose.next()).toEqual({ value: undefined, done: true }); // closed meanwhile: it ends
    expect(beforeClose[Symbol.asyncIterator]()).toBe(beforeClose);
  });

  // one test per recording: each streams it four times, which is the slow part of this file
  it.each(recordingNames())(
    "ends a stream that ended with a final update closing what is open (and the tray), as a replay does: %s",
    async (name) => {
      const fake = await fixtureFake(name, { endOfData: "close" });
      joinAtStart(fake, name, 5); // the five Interpreters below join at the recording's start, as a replay does
      const factory = clientOf(fake);
      const acts = await all(factory.interpreter({ resume: false }).activities());
      expect(acts.map((a) => `${a.describe()}\n`).join(""), name).toBe(readText(`golden/${name}.activities.txt`));
      const interp = factory.interpreter({ resume: false });
      const ups = await all(interp.updates());
      const answers = ups.flatMap((u) => u.speckle); // the unit's speckle answers (4.6.12)
      expect(describeSpeckleTxt(answers), name).toBe(readText(`golden/${name}.speckle.txt`));
      expect(interp.speckle()).toEqual(answers);
      const final = ups.at(-1) as Update;
      expect(final).toMatchObject({ frame: null, events: [], isFinal: true, isRevision: false, isBackfill: false });
      expect(final.state.openMoves.size).toBe(0);
      const evs = await all(factory.interpreter({ resume: false }).events());
      expect(evs.map((e) => `${e.describe()}\n`).join(""), name).toBe(readText(`golden/${name}.events.txt`));
      const facts = await all(factory.interpreter({ resume: false }).trayFacts()); // the last tray's leaving included
      expect(facts.map((f) => `${f.describe()}\n`).join(""), name).toBe(readText(`golden/${name}.trays.txt`));
      const reports = await all(factory.interpreter({ resume: false }).trayReports()); // one as each tray leaves
      expect(reports.map((r) => `${r.describe()}\n`).join(""), name).toBe(readText(`golden/${name}.reports.txt`));
      fake.close();
    },
  );

  it("goes on past an event that does not decode: the final update comes, and the next loop skips it again", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const frame = (g: number): string => `id: b-${g}\nevent: frame\ndata: ${JSON.stringify(mkFrame(g))}\n\n`;
    const bad = "id: b-2\nevent: frame\ndata: {nope\n\n";
    const errors: string[] = [];
    const interp = factory.interpreter({
      resume: false,
      backfill: false,
      onDecodeError: (e) => void errors.push(`${e.code}: ${e.message}`),
    });
    const loop = async (): Promise<(number | boolean | null)[][]> =>
      (await all(interp.updates())).map((u) => [u.frame?.g ?? null, u.isFinal]);
    fake.failNext("streamFrames", 1, { body: frame(1) + bad, contentType: "text/event-stream" });
    expect(await loop()).toEqual([
      [1, false],
      [null, true],
    ]);
    fake.failNext("streamFrames", 1, { body: bad + frame(3), contentType: "text/event-stream" });
    expect(await loop()).toEqual([
      [3, false],
      [null, true],
    ]);
    const streams = fake.requests.filter((r) => r.operationId === "streamFrames");
    expect(streams.at(-1)?.headers.get("last-event-id")).toBe("b-1"); // it resumed after the newest frame
    expect(errors).toEqual([
      "decode: stream event frame: data is not JSON",
      "decode: stream event frame: data is not JSON",
    ]);
  });

  it("sends no final update when the stream ends just as its last consumer leaves", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const frame = (g: number): string => `id: b-${g}\nevent: frame\ndata: ${JSON.stringify(mkFrame(g))}\n\n`;
    fake.failNext("streamFrames", 1, { body: frame(1) + frame(2), contentType: "text/event-stream" });
    const interp = factory.interpreter({ resume: false, highWaterMark: 0, backfill: false });
    const it = interp.updates();
    expect((await it.next()).value?.frame?.g).toBe(1);
    await settle(); // the second update waits for this consumer (highWaterMark 0)
    expect(await it.return?.()).toEqual({ value: undefined, done: true }); // it leaves; then the stream ends
    await settle();
    expect([interp.consumers, interp.state.g, interp.state.openMoves.size]).toEqual([0, 2, 0]);
    expect(interp.finish()).toEqual([]); // nothing was open; the core was not finished for nobody
  });

  it("stops events() and activities() at once when the signal aborts, also inside an update", async () => {
    const fake = await fixtureFake("dry1-0000-0130");
    const factory = clientOf(fake);
    const c = new AbortController();
    const got: string[] = [];
    const err = await rejection(
      (async () => {
        for await (const e of factory.interpreter().events({ signal: c.signal })) {
          got.push(e.type);
          if (got.length === 1) c.abort(new DOMException("enough", "AbortError")); // the first frame has more events
        }
      })(),
    );
    expect((err as DOMException).name).toBe("AbortError");
    expect(got).toHaveLength(1);
    const c2 = new AbortController();
    const acts: string[] = [];
    const err2 = await rejection(
      (async () => {
        for await (const a of factory.interpreter().activities({ signal: c2.signal })) {
          acts.push(a.describe());
          c2.abort(new DOMException("enough", "AbortError"));
        }
      })(),
    );
    expect((err2 as DOMException).name).toBe("AbortError");
    expect(acts).toHaveLength(1);
    await settle();
    expect(fake.streams).toBe(0);
  });

  it("ends iterations when the server ends the stream (resume false) or the interpreter closes", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const factory = clientOf(fake);
    const evs = await all(factory.interpreter({ resume: false }).events());
    expect(evs).toHaveLength(31);
    const golden = readText("golden/joined-mid-move.activities.txt");
    for (const a of await all(factory.interpreter({ resume: false }).activities()))
      expect(golden).toContain(a.describe());
    const err = (await rejection(factory.interpreter({ resume: false }).waitFor("teleport"))) as FactoryError;
    expect(err.message).toContain("ended before a matching event");
    fake.injectGap(3);
    fake.injectReset();
    const ended = await all(factory.interpreter({ resume: false }).updates());
    expect(ended.length).toBe(23); // 22 frames, then the final update
    expect(ended.at(-1)).toMatchObject({ frame: null, events: [], isFinal: true });
    expect(ended.slice(0, -1).every((u) => !u.isFinal && u.frame !== null)).toBe(true);
    const c = new AbortController();
    const held = clientOf(await fixtureFake("joined-mid-move")).interpreter();
    const iter = held.updates({ signal: c.signal });
    await iter.next();
    held.close();
    c.abort();
    expect((await iter.next()).done).toBe(true);
  });

  it("drops frames older than the newest it has (out of order)", async () => {
    const frames = [mkFrame(10, { session: 5 }), mkFrame(9, { session: 5 }), mkFrame(11, { session: 5 })];
    const fake = new FakeFactory([], { frames, endOfData: "close" });
    const ups = await all(clientOf(fake).interpreter({ resume: false }).updates());
    expect(ups.map((u) => u.frame?.g)).toEqual([10, 11, undefined]); // and the final update
  });

  it("keeps a stone's track from its frames, and reads the server's", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const interp = clientOf(fake).interpreter();
    expect(interp.track(130)).toEqual([]);
    await take(interp.updates(), 22);
    const local = interp.track(130);
    expect(local.length).toBeGreaterThan(0);
    expect(local).toEqual(interp.core.track(130));
    expect(local[0]).toMatchObject({ g: expect.any(Number), t: expect.any(Number), pos: expect.any(Array) });
    const server = await interp.serverTrack(130);
    expect([server.id, server.schema]).toEqual([130, "sts1"]);
  });

  it("reads the clock on connect (a unit sends none), so events have wall times from the first frame", async () => {
    const fake = await fixtureFake("joined-mid-move", { connect: "newest" });
    const factory = clientOf(fake);
    const interp = factory.interpreter();
    const it = interp.updates();
    const first = (await it.next()).value as Update;
    expect(first.frame?.g).toBe(420); // as on the unit: the stream starts at the newest frame, with no clock event
    expect(fake.requests.map((r) => r.operationId)).toEqual(["streamFrames", "getSession"]);
    const st = fake.state;
    const start = Math.max(st.anchor_wall, st.hold_until ?? st.anchor_wall); // the playhead starts after the hold
    const wallOf = (t: number): number => start + (t - st.anchor_media) / st.rate;
    expect(first.state.wall).toBeCloseTo(wallOf(first.frame!.t), 6);
    expect(interp.sessionState?.session).toBe(st.session);
    expect(factory.session.lastState?.session).toBe(st.session);
    fake.appendFrames([mkFrame(421, { session: st.session, t: 84.2, events: [{ type: "new", id: 7 }] })]);
    const next = (await it.next()).value as Update;
    expect(next.events[0]?.wall).toBeCloseTo(wallOf(84.2), 6);
    await it.return?.();
    await settle();
    expect(fake.streams).toBe(0);
  });

  it("goes on without wall times when the clock cannot be read, and stops when aborted while reading it", async () => {
    const fake = await fixtureFake("joined-mid-move", { connect: "newest" });
    const factory = clientOf(fake, { retries: 0 });
    fake.failNext("getSession", 1, { status: 500, body: { error: "x", code: "internal" } });
    const [u] = await take(factory.interpreter().updates(), 1);
    expect(u?.frame?.g).toBe(420);
    expect(u?.state.wall).toBeNull();
    const c = new AbortController();
    const slow = await fixtureFake("joined-mid-move", {
      connect: "newest",
      delay: async (r) => {
        if (r.operationId === "getSession") c.abort(new Error("stop while reading the clock"));
      },
    });
    const err = await rejection(take(clientOf(slow).interpreter().updates({ signal: c.signal }), 1));
    expect(String(err)).toContain("stop while reading the clock");
    const plain = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const items = await all(clientOf(plain).streams.frames({ resume: false }));
    expect(plain.requests.some((r) => r.operationId === "getSession")).toBe(false); // only when asked
    expect(items[0]?.kind).toBe("clock"); // the recording's own clock line
  });

  it("counts as a viewer by default; observe is the client's default unless the interpreter says", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const streams = (): (string | null)[] =>
      fake.requests.filter((r) => r.operationId === "streamFrames").map((r) => r.query.get("observe"));
    await take(clientOf(fake).interpreter().updates(), 1);
    await take(clientOf(fake).streams.frames(), 1);
    await take(clientOf(fake, { observe: true }).interpreter().updates(), 1);
    await take(clientOf(fake, { observe: true }).interpreter({ observe: false }).updates(), 1);
    await take(clientOf(fake).interpreter({ observe: true }).updates(), 1);
    expect(streams()).toEqual([null, null, "1", null, "1"]);
    const poll = fake.requests.filter((r) => r.operationId === "pollFrames");
    expect(poll).toHaveLength(0);
    await take(clientOf(fake).interpreter({ transport: "poll" }).updates(), 1);
    expect(
      fake.requests
        .filter((r) => r.operationId === "pollFrames")
        .at(-1)
        ?.query.get("cid"),
    ).toMatch(/^sdk-ts-/);
  });

  it("keeps only the Interpreters whose stream is open, so finished ones are garbage", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const active = (): number => (factory as unknown as { active: Set<unknown> }).active.size;
    for (let i = 0; i < 60; i++) expect((await factory.interpreter().waitFor("gone")).type).toBe("gone");
    expect(active()).toBe(0);
    const open = factory.interpreter();
    const it = open.updates();
    await it.next();
    expect(active()).toBe(1);
    await it.return?.();
    expect(active()).toBe(0);
    const again = open.updates(); // a new consumer opens it again
    await again.next();
    expect(active()).toBe(1);
    factory.close(); // stops what is open, and the client stays usable
    expect(active()).toBe(0);
    expect((await again.next()).done).toBe(true);
    expect((await factory.interpreter().waitFor("gone")).type).toBe("gone");
    const ended = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const f2 = clientOf(ended);
    await all(f2.interpreter({ resume: false }).updates()); // the server ended it
    expect((f2 as unknown as { active: Set<unknown> }).active.size).toBe(0);
  });

  it("closes with using and await using", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    let held: Interpreter;
    {
      using interp = factory.interpreter();
      held = interp;
      await take(interp.updates(), 1);
    }
    expect(() => held.updates()).toThrow(FactoryError);
    {
      await using interp = factory.interpreter();
      held = interp;
    }
    expect(() => held.updates()).toThrow(FactoryError);
    const it = (() => {
      using f = clientOf(fake);
      const i = f.interpreter().updates();
      void i.next();
      return i;
    })();
    expect((await it.next()).done).toBe(true);
    await (async () => {
      await using f = clientOf(fake);
      void f;
    })();
  });
});

describe("Session and SessionClock", () => {
  const state = (over: Partial<State> = {}): State => ({
    session: 1,
    revision: 1,
    video: "dry1",
    playing: true,
    rate: 0.5,
    anchor_media: 10,
    anchor_wall: 1000,
    hold_until: 0,
    duration: 100,
    changed_by: "viewer",
    focus: null,
    media_time: 10,
    ...over,
  });

  it("maps media and wall times", () => {
    const clock = new ManualClock(1_010_000);
    const c = new SessionClock(state(), 2, 0.01, clock);
    expect(c.isLive).toBe(false);
    expect(c.serverNow()).toBe(1012);
    expect(c.mediaTimeNow()).toBe(16);
    expect(c.mediaTimeAt(2000)).toBe(100);
    expect(c.mediaTimeAt(0)).toBe(10); // before the anchor the playhead stands at it
    expect(c.wallOf(20)).toBe(1020);
    expect(c.localWallOf(20)).toBe(1018);
    expect(c.progress()).toBe(0.16);
    expect(c.progress(500)).toBe(1);
    const paused = new SessionClock(state({ playing: false }), 0, 0, clock);
    expect(paused.mediaTimeNow()).toBe(10);
    const live = new SessionClock(state({ video: LIVE_ID, duration: null, rate: 1 }), 0, 0, clock);
    expect(live.isLive).toBe(true);
    expect(live.mediaTimeAt(1100)).toBe(110);
    expect(live.progress()).toBeNull();
    expect(new SessionClock(state({ duration: 0 }), 0, 0, clock).progress()).toBeNull();
    const zero = new SessionClock(state({ rate: 0 }), 1, 0, clock);
    expect([zero.wallOf(20), zero.localWallOf(20)]).toEqual([null, null]);
  });

  it("waits for the hold after a select: the playhead runs from max(anchor_wall, hold_until)", () => {
    const clock = new ManualClock(0);
    const held = new SessionClock(state({ hold_until: 1002.2 }), 0, 0, clock); // a select at 1000 with a 2.2 s hold
    expect(held.mediaTimeAt(1001)).toBe(10); // still holding
    expect(held.mediaTimeAt(1002.2)).toBe(10);
    expect(held.mediaTimeAt(1012.2)).toBe(15); // 10 s after the hold at 0.5x
    expect(held.wallOf(15)).toBeCloseTo(1012.2, 9);
    const paused = new SessionClock(state({ hold_until: 1002.2, playing: false }), 0, 0, clock);
    expect(paused.mediaTimeAt(5000)).toBe(10);
    expect(paused.wallOf(15)).toBe(1010); // mapped back from the pause
    const old = state();
    delete (old as Partial<State>).hold_until; // a server that sends no hold
    expect(new SessionClock(old, 0, 0, clock).mediaTimeAt(1012)).toBe(16);
  });

  it("samples the offset and keeps the shortest round trip", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const clock = new ManualClock(5_000_000);
    let n = 0;
    const delays = [300, 100, 200];
    const slowFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const d = delays[n++ % delays.length] as number;
      const res = fake.fetch(input, init);
      await clock.advance(d);
      return res;
    };
    const factory = new FactoryClient("http://fake.factory", { fetch: slowFetch, clock });
    const c = await factory.session.clock({ samples: 3 });
    expect(c.rtt).toBeCloseTo(0.1);
    expect(c.state.video).toBe("dry1");
    const one = await factory.session.clock();
    expect(one.rtt).toBeCloseTo(0.3);
    expect((await factory.session.state()).video).toBe("dry1");
  });

  it("watches, seeks, pauses, plays and focuses (dry runs and real)", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const s = clientOf(fake).session;
    const id = (await clientOf(fake).api.getWorld()).stones[0]!.id;
    expect((await s.focus(id)).focus?.id).toBe(id);
    expect((await s.clearFocus()).focus).toBeNull();
    await s.pause();
    expect(fake.state.playing).toBe(false);
    const watched = await s.watch("dry2", { at: 581, dryRun: true });
    expect(watched.video).toBe("dry2");
    expect(
      fake.requests
        .filter((r) => r.operationId === "sessionPlay")
        .at(-1)
        ?.query.get("dry_run"),
    ).toBe("1");
    expect(fake.state.video).toBe("dry1");
    const real = await s.watch("dry2");
    expect(real.video).toBe("dry2");
    expect(fake.state.playing).toBe(true);
    await s.watch("dry1");
    expect(fake.requests.filter((r) => r.operationId === "sessionPlay")).toHaveLength(2);
    expect((await s.seek(500)).media_time).toBe(500);
    expect((await s.seek(20, { video: "dry2", dryRun: true })).video).toBe("dry2");
    expect((await s.play()).playing).toBe(true);
    expect(((await rejection(s.watch(LIVE_ID, { at: 3 }))) as FactoryError).code).toBe("not_seekable");
    expect(((await rejection(s.seek(3, { video: LIVE_ID }))) as FactoryError).code).toBe("not_seekable");
  });

  it("follows a live camera: no seek, no time, rate 1", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const factory = clientOf(fake);
    const live = await factory.live(); // the first plant camera of the unit's catalog; the session shows the fake's
    expect(live).toMatchObject({
      id: "CAM00000001",
      isLive: true,
      seekable: false,
      duration: null,
      defaultStart: null,
      hold: 3,
      station: "Plant A",
    });
    expect((await factory.cameras()).map((c) => c.id)).toEqual([...PLANT_CAMERAS, LIVE_CAMERA]);
    let before = fake.requests.length;
    // no state known yet: the SDK reads it, and refuses the seek here without sending it
    const refused = (await rejection(factory.session.seek(5))) as FactoryError;
    expect([refused.status, refused.code, refused.field]).toEqual([null, "not_seekable", "video"]);
    expect(fake.requests.slice(before).map((r) => r.operationId)).toEqual(["getSession"]);
    expect(factory.session.lastState?.video).toBe(LIVE_CAMERA);
    before = fake.requests.length;
    const local = (await rejection(factory.session.seek(5, { dryRun: true }))) as FactoryError;
    expect([local.status, local.code]).toEqual([null, "not_seekable"]); // refused here, from fresh state
    expect(fake.requests.slice(before).map((r) => r.operationId)).toEqual(["getSession"]);
    expect((await factory.session.seek(5, { video: "dry1", dryRun: true })).video).toBe("dry1");
    // a camera named in `video` is sent (the SDK reads no catalog for a seek): the unit refuses it
    const named = (await rejection(factory.session.seek(5, { video: LIVE_CAMERA, dryRun: true }))) as FactoryError;
    expect([named.status, named.code, named.field]).toEqual([409, "not_seekable", "video"]);
    const c = await factory.session.clock();
    expect(c.isLive).toBe(true);
    expect(c.state.rate).toBe(1);
    expect(c.progress()).toBeNull();
    const updates = await take(factory.interpreter().updates(), 2);
    expect(updates.every((u) => u.frame?.video === LIVE_CAMERA)).toBe(true);
    const state = await factory.session.watch("dry1", { at: 40 });
    expect(state).toMatchObject({ video: "dry1", rate: 0.8 });
    expect(state.live).toBeUndefined();
    // `at` on a camera is refused here, without a select: a Source says it is one, an id is looked up in the catalog
    before = fake.requests.length;
    const timed = (await rejection(factory.session.watch(live, { at: 3 }))) as FactoryError;
    expect([timed.status, timed.code, timed.field]).toEqual([null, "not_seekable", "time"]);
    expect(fake.requests.length).toBe(before);
    const byId = (await rejection(factory.session.watch(LIVE_CAMERA, { at: 3 }))) as FactoryError;
    expect([byId.code, byId.field]).toEqual(["not_seekable", "time"]);
    expect(fake.requests.slice(before).map((r) => r.operationId)).toEqual(["listVideos"]);
    const watched = await factory.session.watch(live);
    expect(watched).toMatchObject({ video: live.id, rate: 1, duration: null, media_time: 0 });
    expect(watched.live).toMatchObject({ phase: "connecting", warmup: 3, lag: 0 });
    // a state seen before the session turned to the camera: the SDK reads the session again and refuses the seek
    const stale = new Session(factory.api, new InstantClock());
    stale.note({ ...(factory.session.lastState as State), video: "dry1", live: null });
    before = fake.requests.length;
    const fresh = (await rejection(stale.seek(1))) as FactoryError;
    expect([fresh.status, fresh.code, fresh.field]).toEqual([null, "not_seekable", "video"]);
    expect(fake.requests.slice(before).map((r) => r.operationId)).toEqual(["getSession"]);
    // and the other way round: a camera when this client last looked, a recording since another client switched it
    expect(factory.session.lastState?.video).toBe(live.id);
    await fake.client().session.watch("dry1", { at: 40 });
    before = fake.requests.length;
    expect((await factory.session.seek(5, { dryRun: true })).video).toBe("dry1");
    expect(fake.requests.slice(before).map((r) => r.operationId)).toEqual(["getSession", "sessionSeek"]);
  });

  it("waits until a camera is live: connecting, warming on its first 3 s, then live, on the fake's clock", async () => {
    const clock = new InstantClock(1_794_958_239_000);
    const fake = await fixtureFake("dry1-0000-0130", { live: true, clock });
    const factory = clientOf(fake, { clock });
    const camera = await factory.live();
    await factory.session.watch("dry1");
    expect((await factory.session.untilLive()).video).toBe("dry1"); // a recording: at once
    const t0 = clock.now() / 1000;
    const selected = await factory.session.watch(camera);
    expect(selected.live).toMatchObject({ phase: "connecting", since: t0 });
    expect(selected.hold_until - selected.anchor_wall).toBe(3600);
    // nothing is released while it connects and warms up
    expect(((await rejection(factory.api.getFrame("latest"))) as FactoryError).code).toBe("not_retained");
    expect(((await rejection(factory.session.picture())) as FactoryError).code).toBe("not_retained");
    expect((await factory.api.getSession()).state.media_time).toBe(0);
    const live = await factory.session.untilLive();
    expect(live.live).toMatchObject({ phase: "live", warmup: 3, lag: LIVE_LAG_S, since: t0 });
    expect(live.revision).toBe(selected.revision + 2);
    expect(live.anchor_media).toBeGreaterThanOrEqual(CONNECT_S + 3); // the first frame after the warm-up
    expect(live.anchor_wall).toBeCloseTo(t0 + live.anchor_media + LIVE_LAG_S, 6);
    expect(clock.now() / 1000).toBeGreaterThanOrEqual(live.anchor_wall);
    expect(clock.now() / 1000 - live.anchor_wall).toBeLessThan(UNTIL_LIVE_POLL_MS / 1000 + 1e-9);
    const frame = await factory.api.getFrame("latest");
    expect(frame).toMatchObject({ video: camera.id, session: live.session });
    const picture = await factory.session.picture(frame.g, { session: live.session });
    expect(picture.g).toBe(frame.g);
    expect(new TextDecoder().decode(picture.jpeg)).toContain(`FakeFactory ${camera.id} g ${frame.g}`);
    // a pause stops the camera's phases; play resumes at the live edge, now - since - lag, and connects again
    const paused = await factory.session.pause();
    const played = await factory.session.play();
    expect(played.anchor_media).toBeCloseTo(clock.now() / 1000 - t0 - LIVE_LAG_S, 6);
    expect([played.live?.phase, played.revision]).toEqual(["connecting", paused.revision + 1]);
  });

  it("waits until a camera is live again after a play: it connects again and warms up on its next frames", async () => {
    const clock = new InstantClock(1_794_958_239_000);
    const fake = await fixtureFake("joined-mid-move", { live: true, clock });
    const factory = clientOf(fake, { clock });
    const before = await factory.api.getFrame("latest");
    const paused = await factory.session.pause();
    const played = await factory.session.play();
    expect([played.live?.phase, played.revision]).toEqual(["connecting", paused.revision + 1]);
    const again = await factory.session.untilLive();
    expect([again.live?.phase, again.revision, again.session]).toEqual(["live", played.revision + 2, played.session]);
    expect(again.anchor_wall).toBeGreaterThan(played.anchor_wall + CONNECT_S + 3);
    // its next frames come after a break: g jumps by 5, t goes on
    const after = await factory.api.getFrame("latest");
    expect(after.g).toBeGreaterThan(before.g + 5);
    expect(after.t).toBeGreaterThan(before.t);
  });

  it("streams a camera's phases as clock items, then its frames after the warm-up", async () => {
    const clock = new InstantClock(1_794_958_239_000);
    const fake = await fixtureFake("dry1-0000-0130", { live: true, clock });
    const factory = clientOf(fake, { clock });
    await factory.session.watch("dry1");
    await factory.session.watch(await factory.live());
    const items = await take(factory.streams.frames({ layers: ["world"] }), 4);
    expect(items.map((i) => i.kind)).toEqual(["clock", "clock", "clock", "frame"]);
    const phases = items.slice(0, 3).map((i) => (i.kind === "clock" ? i.state.live?.phase : null));
    expect(phases).toEqual(["connecting", "warming", "live"]);
    const first = items[3];
    expect(first?.kind === "frame" ? first.frame.t : null).toBeGreaterThanOrEqual(CONNECT_S + 3);
    expect(fake.state.live?.phase).toBe("live");
    // a long-poll waits for the phases too and then answers with the frames
    await factory.session.watch(await factory.live());
    const polled = await take(factory.streams.poll({ layers: ["world"] }), 8);
    expect(polled.filter((i) => i.kind === "frame").length).toBeGreaterThan(0);
    expect(fake.state.live?.phase).toBe("live");
  });

  it("gives up waiting for a camera that does not go live: live_timeout with its phase", async () => {
    const clock = new InstantClock(1_794_958_239_000);
    const fake = await fixtureFake("joined-mid-move", { live: true, clock });
    const factory = clientOf(fake, { clock });
    await factory.session.pause();
    await factory.api.sessionSelect({ video: LIVE_CAMERA }); // paused: its phases do not come
    const err = (await rejection(factory.session.untilLive({ timeout: 2_000 }))) as FactoryError;
    expect([err.code, err.message]).toEqual(["live_timeout", `${LIVE_CAMERA} is still connecting after 2 s`]);
  });

  it("keeps the newest state seen: reads, controls (not dry runs) and the streams' clock items", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const s = factory.session;
    expect(s.lastState).toBeNull();
    await take(factory.streams.frames({ layers: ["world"] }), 1); // the recording's clock line
    expect(s.lastState?.video).toBe("dry1");
    const first = s.lastState!;
    await s.pause({ dryRun: true });
    expect(s.lastState).toBe(first);
    const paused = await s.pause();
    expect(s.lastState).toEqual(paused);
    s.note({ ...paused, revision: paused.revision - 1 }); // older: kept out
    expect(s.lastState).toEqual(paused);
    s.note({ ...paused, session: paused.session + 1, revision: 0 }); // another session: newer
    expect(s.lastState?.revision).toBe(0);
    await s.clock();
    expect(s.lastState?.session).toBe(paused.session);
    await s.focus((await factory.api.getWorld()).stones[0]!.id);
    expect(s.lastState?.focus).not.toBeNull();
    await s.clearFocus();
    expect(s.lastState?.focus).toBeNull();
    await s.watch("dry2", { at: 581 });
    expect(s.lastState?.video).toBe("dry2");
    await s.play();
    const polled = await take(factory.streams.poll({ wait: 0 }), 1);
    expect(polled[0]?.kind).toBe("clock");
    expect(s.lastState?.playing).toBe(true);
  });
});

describe("FactoryClient and sources", () => {
  it("lists sources with the shipping defaults", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const sources = await factory.sources();
    expect(sources.map((s) => s.id)).toEqual(["aug28", "jul30", "dry1", "dry2", ...PLANT_CAMERAS]);
    const dry1 = await factory.source("dry1");
    expect(dry1).toMatchObject({ kind: "recording", live: false, seekable: true, gridStep: 2 });
    expect(dry1.progress(dry1.duration! / 2)).toBe(0.5);
    expect(dry1.progress(-5)).toBe(0);
    expect(dry1.toJSON().id).toBe("dry1");
    expect(dry1.heldOut.length).toBeGreaterThan(0);
    expect((await factory.live()).id).toBe("CAM00000001"); // the first of its plant cameras
    // a catalog that lists no camera (a unit that plays recordings only): live() has none to give
    const catalog = readJson<VideoList>("api/listVideos.json");
    fake.failNext("listVideos", 1, { body: { ...catalog, videos: catalog.videos.filter((v) => v.kind !== "camera") } });
    expect(((await rejection(factory.live())) as FactoryError).code).toBe("live_unavailable");
    expect(factory.baseUrl).toBe("http://fake.factory");
    const cam = new Source({
      id: "cam2",
      duration: 5,
      fps: 10,
      frames: 50,
      grid_step: 2,
      proxy: "",
      proxy_wh: [],
      native_wh: [],
      kind: "camera",
    });
    expect(cam).toMatchObject({
      live: true,
      kind: "camera",
      seekable: false,
      duration: null,
      frames: null,
      title: null,
      camera: null,
    });
    expect(cam.progress(1)).toBeNull();
    const flagged = new Source({
      id: "c",
      duration: null,
      fps: 10,
      frames: null,
      grid_step: 2,
      proxy: "",
      proxy_wh: [],
      native_wh: [],
      live: true,
    });
    expect(flagged.kind).toBe("camera");
    const bare = new Source({
      id: "x",
      duration: null,
      fps: 1,
      frames: null,
      grid_step: 1,
      proxy: "",
      proxy_wh: [],
      native_wh: [],
    });
    expect(bare.progress(1)).toBeNull();
    expect(bare.heldOut).toEqual([]);
  });

  it("finds the live camera by id when the entry has no flags", async () => {
    const fake = await fixtureFake("joined-mid-move", {
      replies: {
        listVideos: {
          body: {
            schema: "c",
            videos: [
              {
                id: "live",
                duration: null,
                fps: 10,
                frames: null,
                grid_step: 2,
                proxy: "",
                proxy_wh: [],
                native_wh: [],
              },
            ],
          },
        },
      },
    });
    const live = await clientOf(fake).live();
    expect(live.id).toBe("live");
  });

  it("is made from the environment", () => {
    vi.stubEnv("PDIGGER_FACTORY_URL", "http://unit.example:8120");
    expect(FactoryClient.fromEnv().baseUrl).toBe("http://unit.example:8120");
    vi.stubEnv("PDIGGER_FACTORY_URL", "");
    expect(() => FactoryClient.fromEnv()).toThrow(TypeError);
    expect(FactoryClient.fromEnv({ fallback: "http://other.example" }).baseUrl).toBe("http://other.example");
    const proc = globalThis.process;
    vi.stubGlobal("process", undefined);
    try {
      expect(() => FactoryClient.fromEnv()).toThrow(TypeError);
    } finally {
      vi.stubGlobal("process", proc);
      vi.unstubAllGlobals();
    }
    expect(new FactoryClient("http://u.example", { observe: true }).observe).toBe(true);
  });
});
