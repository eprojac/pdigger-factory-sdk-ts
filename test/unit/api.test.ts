import { describe, expect, it } from "vitest";
import {
  Api,
  FactoryClient,
  FactoryError,
  OPERATIONS,
  Source,
  layersQuery,
  parseContentRange,
  type Frame,
  type VideoList,
} from "pdigger-factory-sdk";
import { CONNECT_S, InstantClock, LIVE_CAMERA, LIVE_LAG_S, type FakeFactory } from "pdigger-factory-sdk/testing";
import { all, clientOf, fixtureFake, rejection } from "../helpers/fake.js";
import { readJson } from "../helpers/fixtures.js";

const last = (fake: FakeFactory) => fake.requests[fake.requests.length - 1]!;
/** The six plant cameras the unit lists after its recordings (fixtures/api/listVideos.json), in its order. */
const PLANT_CAMERAS = ["CAM00000001", "CAM00000002", "CAM00000003", "CAM00000004", "CAM00000005", "CAM00000006"];

describe("the low level covers the contract", () => {
  it("has one method per operationId of the spec (32)", () => {
    const spec = readJson<{ paths: Record<string, Record<string, { operationId?: string }>> }>("../spec/openapi.json");
    const ids = Object.values(spec.paths).flatMap((p) =>
      Object.values(p)
        .map((o) => o.operationId)
        .filter(Boolean),
    );
    expect(ids).toHaveLength(32);
    expect([...OPERATIONS].sort()).toEqual([...ids].sort());
    for (const op of OPERATIONS)
      expect(typeof (Api.prototype as unknown as Record<string, unknown>)[op]).toBe("function");
  });
  it("formats layers and parses Content-Range", () => {
    expect(layersQuery(undefined)).toBeUndefined();
    expect(layersQuery("world")).toBe("world");
    expect(layersQuery(["world", "cards"])).toBe("world,cards");
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange("bytes 0-99/1000")).toEqual({ start: 0, end: 99, size: 1000 });
    expect(parseContentRange("bytes */1000")).toEqual({ start: null, end: null, size: 1000 });
    expect(parseContentRange("bytes 5-9/*")).toEqual({ start: 5, end: 9, size: null });
    expect(parseContentRange("items 1-2/3")).toBeNull();
  });
});

describe("operations against the fake (dry1 recording, 20.20 replies)", async () => {
  const fake = await fixtureFake("dry1-0000-0130");
  const api = clientOf(fake).api;

  it("Interpreter: world, events, stones, focus", async () => {
    const world = await api.getWorld({ precision: "full" });
    expect(world.schema).toBe("stw1");
    expect(world.g).toBe(650);
    expect(last(fake).query.get("precision")).toBe("full");
    const log = await api.getWorldEvents({ after: 100, limit: 5, type: ["lift", "place"] });
    expect(log.events.every((e) => e.type === "lift" || e.type === "place")).toBe(true);
    expect(log.events.every((e) => e.g > 100)).toBe(true);
    expect(last(fake).query.get("type")).toBe("lift,place");
    const one = await api.getWorldEvents({ type: "new", limit: 1 });
    expect(one.events[0]?.type).toBe("new");
    expect((await api.getWorldEvents()).session).toBe(world.session);
    const id = world.stones[0]!.id;
    const track = await api.getStone(id);
    expect(track).toMatchObject({ schema: "sts1", id });
    expect(track.path3d.length).toBeGreaterThan(0);
    expect(((await rejection(api.getStone(999_999))) as FactoryError).code).toBe("unknown_stone");
    expect(await api.getFocus()).toEqual({ focus: null, resolved: null });
    const dry = await api.putFocus(id, { g: 650, session: world.session, dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.state.focus?.id).toBe(id);
    expect(last(fake).body).toBe(JSON.stringify({ stone_id: id, g: 650, session: world.session }));
    expect(last(fake).query.get("dry_run")).toBe("1");
    expect((await api.getFocus()).focus).toBeNull();
    const set = await api.putFocus(id);
    expect(set.dry_run).toBe(false); // the unit always says whether it was a dry run
    const focus = await api.getFocus();
    expect(focus.focus?.id).toBe(id);
    expect(focus.resolved?.path3d.length).toBeGreaterThan(0);
    expect((await api.deleteFocus({ dryRun: true })).state.focus).toBeNull();
    expect((await api.getFocus()).focus?.id).toBe(id);
    await api.deleteFocus();
    expect((await api.getFocus()).focus).toBeNull();
  });

  it("Sources: catalog with ETag, entries, media ranges", async () => {
    const list = await api.listVideos();
    expect(list.videos.map((v) => v.id)).toEqual(["aug28", "jul30", "dry1", "dry2", ...PLANT_CAMERAS]);
    expect(list.etag).toMatch(/^"/);
    expect(Object.keys(list)).not.toContain("etag");
    expect(await api.listVideos({ ifNoneMatch: list.etag! })).toBeNull();
    expect(last(fake).headers.get("if-none-match")).toBe(list.etag);
    expect((await api.listVideos({ ifNoneMatch: '"other"' }))?.videos).toHaveLength(10);
    // Source objects (as the Python SDK's), serialising to the entries the server sent
    expect(list.videos.every((x) => x instanceof Source)).toBe(true);
    const raw = readJson<VideoList>("api/listVideos.json");
    expect(JSON.parse(JSON.stringify(list.videos))).toEqual(raw.videos);
    expect(list.videos[2]).toMatchObject({ id: "dry1", kind: "recording", live: false, seekable: true });
    const v = await api.getVideo("dry1");
    expect(v).toBeInstanceOf(Source);
    expect(v.nativeWh).toEqual([1920, 1080]);
    expect(v.entry.native_wh).toEqual([1920, 1080]);
    expect(((await rejection(api.getVideo("nope"))) as FactoryError).code).toBe("unknown_video");
    const part = await api.getVideoMedia("dry1", { range: [0, 99] });
    expect(part.status).toBe(206);
    expect(part.bytes.length).toBe(100);
    expect(part.contentRange?.start).toBe(0);
    expect(part.size).toBe(part.contentRange?.size);
    expect(part.contentType).toBe("video/mp4");
    expect(last(fake).headers.get("range")).toBe("bytes=0-99");
    const tail = await api.getVideoMedia("dry1", { range: { suffix: 10 }, ifRange: part.etag! });
    expect(tail.bytes.length).toBe(10);
    expect(last(fake).headers.get("if-range")).toBe(part.etag);
    const open = await api.getVideoMedia("dry1", { range: [part.size! - 5] });
    expect(open.bytes.length).toBe(5);
    const whole = await api.getVideoMedia("dry1");
    expect(whole.status).toBe(200);
    expect(whole.size).toBe(part.size);
    const same = await api.getVideoMedia("dry1", { ifNoneMatch: part.etag! });
    expect(same.status).toBe(304);
    expect(same.size).toBeNull();
    const bad = (await rejection(api.getVideoMedia("dry1", { range: [part.size! + 10] }))) as FactoryError;
    expect(bad).toMatchObject({ code: "invalid_param", field: "range", status: 416 });
    // the size the 416 gives is kept: in the message and in the reply's headers
    expect(bad.message).toContain(`${part.size} bytes`);
    expect(parseContentRange(bad.headers?.get("content-range") ?? null)?.size).toBe(part.size);
    expect(fake.requests.filter((r) => r.headers.get("range") === `bytes=${part.size! + 10}-`)).toHaveLength(1); // not retried
    expect(((await rejection(api.getVideoMedia("nope"))) as FactoryError).code).toBe("unknown_video");
    const head = await api.headVideoMedia("dry1");
    expect(head).toMatchObject({ status: 200, acceptRanges: "bytes", size: part.size });
  });

  it("Session: state and dry-run controls", async () => {
    const s = await api.getSession();
    expect(s.state.video).toBe("dry1");
    expect(s.worker.state).toBeDefined();
    const sel = await api.sessionSelect({ video: "dry2" }, { dryRun: true });
    expect(sel.state.video).toBe("dry2");
    expect(sel.dry_run).toBe(true);
    const seek = await api.sessionSeek({ time: 12.5 }, { dryRun: true });
    expect(seek.state.media_time).toBe(12.5);
    expect((await api.sessionPause({ dryRun: true })).state.playing).toBe(false);
    expect((await api.sessionPlay({ dryRun: true })).state.playing).toBe(true);
    expect((await api.getSession()).state.video).toBe("dry1");
    const err = (await rejection(api.sessionSeek({ time: -1 }))) as FactoryError;
    expect(err).toMatchObject({ code: "time_out_of_range", field: "time", status: 400 });
  });

  it("Streams: one SSE or NDJSON connection, the long-poll, raw packets", async () => {
    const c = (await all(await api.streamFrames({ format: "ndjson", limit: 24, layers: "world" }))).map(
      (e) => e.json<Frame>().cursor,
    );
    expect(c).toHaveLength(24);
    const s = await api.streamFrames({
      layers: ["world"],
      limit: 3,
      observe: true,
      precision: "rounded",
      maxS: 60,
      after: c[9],
    });
    const evs = await all(s);
    expect(evs.filter((e) => e.event === "frame")).toHaveLength(3);
    expect(evs.find((e) => e.event === "frame")?.json<Frame>().cursor).toBe(c[10]);
    const q = last(fake).query;
    expect(Object.fromEntries(q)).toEqual({
      layers: "world",
      format: "sse",
      after: String(c[9]),
      limit: "3",
      max_s: "60",
      observe: "1",
      precision: "rounded",
    });
    expect(last(fake).headers.get("accept")).toBe("text/event-stream");
    const nd = await api.streamFrames({ format: "ndjson", limit: 2, lastEventId: `fakeboot01-${c[19]}` });
    expect(nd.format).toBe("ndjson");
    expect((await all(nd)).map((e) => e.json<Frame>().cursor)).toEqual([c[0], c[1]]);
    expect(last(fake).headers.get("last-event-id")).toBe(`fakeboot01-${c[19]}`);
    expect(last(fake).headers.get("accept")).toBe("application/x-ndjson");
    const resumed = await api.streamFrames({ limit: 1, lastEventId: `fakeboot01-${c[19]}` });
    expect((await all(resumed)).find((e) => e.event === "frame")?.json<Frame>().cursor).toBe(c[20]);
    const poll = await api.pollFrames({
      cursor: c[4],
      rev: 0,
      cid: "sdk-test-0001",
      layers: "world",
      limit: 2,
      wait: 0,
      precision: "full",
    });
    expect(poll.frames.map((f) => f.cursor)).toEqual([c[5], c[6]]);
    expect(poll.cursor).toBe(c[6]);
    const raw = await api.rawStream({ limit: 1, observe: false });
    expect(last(fake).query.get("observe")).toBeNull();
    expect(fake.streams).toBe(1);
    raw.close();
    expect(fake.streams).toBe(0);
    const rawNd = await api.rawStream({ format: "ndjson", limit: 1, after: 3, maxS: 5 });
    expect(rawNd.format).toBe("ndjson");
    rawNd.close();
  });

  it("Render-ready, frames and codec", async () => {
    const o = await api.renderOverlay2d({ g: 600, mode: "stable", draw: "primitives" });
    expect(o.schema).toBe("r2d1");
    expect(o.primitives?.polygons?.length).toBeGreaterThan(0);
    expect((await api.renderOverlay2d({ t: 100 })).stones?.length).toBeGreaterThan(0);
    expect(() => api.renderOverlay2d({} as never)).toThrow(FactoryError);
    expect(() => api.renderScene3d({ g: 1, t: 2 } as never)).toThrow(FactoryError);
    const sc = await api.renderScene3d({ g: 600, surface: "vertices", session: undefined });
    expect(sc.surface?.form).toBe("vertices");
    expect((await api.renderScene3d({ g: 600, surface: "compact" })).surface?.form).toBe("compact");
    expect((await api.renderScene3d({ g: 600, surface: "none", mode: "raw", draw: "shapes" })).schema).toBe("r3d1");
    const f = await api.getFrame(600, { layers: ["world"], precision: "full" });
    expect(f.g).toBe(600);
    expect(f.world?.g).toBe(600);
    expect(f.cards).toBeUndefined();
    expect((await api.getFrame("latest")).g).toBe(650);
    const gone = (await rejection(api.getFrame(600, { session: 12345 }))) as FactoryError;
    expect(gone.isSessionGone()).toBe(true);
    const nr = (await rejection(api.getFrame(99_999))) as FactoryError;
    expect(nr.isNotRetained()).toBe(true);
    expect(nr.retained?.g1).toBe(650);
    const png = await api.getFrameRaster(600, "regions", { scale: 2 });
    expect([...png.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
    expect(last(fake).query.get("scale")).toBe("2");
    expect((await api.rawPacket("latest")).schema).toBe("sip1");
    expect(((await rejection(api.rawPacket(600, { session: 1 }))) as FactoryError).code).toBe("session_gone");
    expect(((await rejection(api.rawTensors(600))) as FactoryError).code).toBe("debug_disabled");
  });

  it("decodes edge replies: a broken catalog, a HEAD with a range, tensors", async () => {
    fake.failNext("listVideos", 1, { body: "{not json", contentType: "application/json" });
    expect(((await rejection(api.listVideos())) as FactoryError).code).toBe("decode");
    fake.failNext("listVideos", 1, { body: { schema: "x" } });
    expect(((await rejection(api.listVideos())) as FactoryError).message).toContain("no videos list");
    fake.failNext("listVideos", 1, { body: { schema: "x", videos: [] } });
    expect((await api.listVideos()).etag).toBeUndefined();
    fake.failNext("getVideoMedia", 1, { status: 206, headers: { "Content-Range": "bytes 0-1/100" } });
    expect((await api.headVideoMedia("dry1")).size).toBe(100);
    fake.failNext("getVideoMedia", 1, { status: 200, headers: {} });
    expect((await api.headVideoMedia("dry1")).size).toBeNull();
    fake.failNext("getVideoMedia", 1, { status: 206, body: new Uint8Array([1, 2]), headers: {} });
    expect((await api.getVideoMedia("dry1", { range: [0, 1] })).size).toBeNull();
    // a 416 without a size, and with a body (a proxy's page)
    fake.failNext("getVideoMedia", 1, { status: 416, body: "no", headers: { "Content-Range": "bytes */*" } });
    const noSize = (await rejection(api.getVideoMedia("dry1", { range: [5] }))) as FactoryError;
    expect(noSize).toMatchObject({ code: "invalid_param", status: 416, message: "range not satisfiable for dry1" });
    fake.failNext("getVideoMedia", 1, { status: 416 });
    expect(((await rejection(api.getVideoMedia("dry1", { range: [5] }))) as FactoryError).status).toBe(416);
    fake.failNext("rawTensors", 1, { body: new Uint8Array([80, 75, 3, 4]) });
    expect([...(await api.rawTensors(600))]).toEqual([80, 75, 3, 4]);
  });

  it("Meta and ops", async () => {
    expect((await api.getApiRoot()).api).toMatch(/^2\./);
    expect(await api.getOpenApi()).toContain("openapi:");
    expect((await api.getModel()).backend).toBeDefined();
    const top = await api.getTopology();
    expect(top.joints).toBe(70);
    expect((await api.getHealth()).ok).toBe(true);
    expect((await api.getReady()).ready).toBe(true);
    expect((await api.getStatus()).build).toBeDefined();
    const m = await api.getMetrics();
    expect(m.text.length).toBeGreaterThan(0);
    expect(m.samples.length).toBeGreaterThan(0);
  });
});

describe("raw packets of a full recording", async () => {
  const fake = await fixtureFake("dry1-0296-0306-full");
  const api = clientOf(fake).api;
  it("streams and reads sip1 packets", async () => {
    const s = await api.rawStream({ limit: 2, observe: true });
    const packets = (await all(s))
      .filter((e) => e.event === "frame")
      .map((e) => e.json<{ schema: string; cursor: number }>());
    expect(packets.map((p) => p.schema)).toEqual(["sip1", "sip1"]);
    const p = await api.rawPacket(1500);
    expect(p.schema).toBe("sip1");
    expect((await api.rawPacket("latest")).g).toBe(1530);
  });
});

describe("a live camera", async () => {
  const fake = await fixtureFake("joined-mid-move", { live: true });
  const api = clientOf(fake).api;
  it("is listed after the recordings, has no media, refuses a seek and has a picture per frame", async () => {
    const list = await api.listVideos();
    expect(list.default_video).toBe("dry1"); // the catalog's default is the recording, as on the unit
    expect(list.videos.map((v) => v.id)).toEqual(["aug28", "jul30", "dry1", "dry2", ...PLANT_CAMERAS, LIVE_CAMERA]);
    expect(list.videos.at(-1)?.entry).toMatchObject({
      kind: "camera",
      live: true,
      seekable: false,
      duration: null,
      frames: null,
      default_start: null,
      grid_step: 1,
      hold: 3,
      proxy: "",
      station: "FakeFactory",
    });
    const media = (await rejection(api.getVideoMedia(LIVE_CAMERA))) as FactoryError;
    expect([media.status, media.code, media.field]).toEqual([404, "not_found", "id"]);
    expect(media.message).toContain("/api/v2/session/frames/{g}/image.jpg");
    const seek = (await rejection(api.sessionSeek({ time: 1 }))) as FactoryError;
    expect([seek.status, seek.code, seek.field]).toEqual([409, "not_seekable", "video"]);
    const timed = (await rejection(
      api.sessionSelect({ video: LIVE_CAMERA, time: 1 }, { dryRun: true }),
    )) as FactoryError;
    expect([timed.status, timed.code, timed.field]).toEqual([400, "not_seekable", "time"]);
    const { state } = await api.getSession();
    expect(state).toMatchObject({ video: LIVE_CAMERA, rate: 1, duration: null });
    expect(state.live).toMatchObject({ phase: "live", warmup: 3, lag: LIVE_LAG_S });
    const frame = await api.getFrame("latest");
    expect(frame).toMatchObject({ video: LIVE_CAMERA, session: state.session });
    expect(frame.t).toBeGreaterThanOrEqual(CONNECT_S + 3); // the warm-up's frames are never released
    const latest = await api.getFramePicture("latest");
    expect(latest.g).toBe(frame.g);
    expect([...latest.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...latest.jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(new TextDecoder().decode(latest.jpeg)).toContain(`FakeFactory ${LIVE_CAMERA} g ${frame.g}`);
    expect((await api.getFramePicture(frame.g, { session: state.session })).g).toBe(frame.g);
    const old = (await rejection(api.getFramePicture(frame.g + 10_000))) as FactoryError;
    expect([old.status, old.code, old.field]).toEqual([404, "not_retained", "g"]);
    const gone = (await rejection(api.getFramePicture("latest", { session: state.session - 1 }))) as FactoryError;
    expect([gone.status, gone.code, gone.field]).toEqual([410, "session_gone", "session"]);
    // a reply without the frame it shows is not a picture of a frame
    fake.failNext("getFramePicture", 1, { status: 200, body: latest.jpeg, contentType: "image/jpeg" });
    const bare = (await rejection(api.getFramePicture("latest"))) as FactoryError;
    expect([bare.code, bare.status, bare.message]).toEqual([
      "decode",
      200,
      "the picture reply has no X-Interp-G header",
    ]);
    // a recording's picture is its proxy video
    await api.sessionSelect({ video: "dry1" });
    const recording = (await rejection(api.getFramePicture("latest"))) as FactoryError;
    expect([recording.status, recording.code, recording.field]).toEqual([404, "not_found", "g"]);
    // a stale session is gone whatever the session shows now: 410 before the recording's 404
    const stale = (await rejection(api.getFramePicture("latest", { session: state.session }))) as FactoryError;
    expect([stale.status, stale.code]).toEqual([410, "session_gone"]);
  });

  it("refuses a whole-file reply with neither a length nor byte ranges at once, closing it, and does not retry", async () => {
    let pulled = 0;
    let cancelled = 0;
    let calls = 0;
    const endless = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: (c) => {
            pulled++;
            c.enqueue(new Uint8Array(1024));
          },
          cancel: () => {
            cancelled++;
          },
        }),
        { status: 200, headers: { "Content-Type": "video/mp4" } },
      );
    const factory = new FactoryClient("http://unit.test", {
      fetch: () => {
        calls++;
        return Promise.resolve(endless());
      },
      clock: new InstantClock(),
      timeoutMs: 60_000,
    });
    const err = (await rejection(factory.api.getVideoMedia("cam2"))) as FactoryError;
    expect(err).toMatchObject({ code: "not_seekable", field: "id", status: 200 });
    expect(err.message).toBe("the media of cam2 is a live stream that never ends: read it with openVideoMedia()");
    expect([calls, cancelled]).toEqual([1, 1]);
    expect(pulled).toBeLessThan(4); // what the stream queued before the cancel, not the endless body
    const handle = await factory.api.openVideoMedia("cam2"); // the way to read it
    const reader = handle.body.getReader();
    expect((await reader.read()).value?.length).toBe(1024);
    handle.close();
  });
});
