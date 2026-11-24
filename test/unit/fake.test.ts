import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Frame, Overlay2D, Scene3D, State, VideoEntry } from "pdigger-factory-sdk";
import {
  CONNECT_S,
  FakeFactory,
  InstantClock,
  KEEP_PICTURES,
  LIVE_CAMERA,
  LIVE_LAG_S,
  ManualClock,
  TINY_PNG,
  settle,
  type FakeReply,
} from "pdigger-factory-sdk/testing";
import { fixtureFake, until } from "../helpers/fake.js";
import { FIXTURES, readJson, recordingPath } from "../helpers/fixtures.js";
import { mkFrame, stone } from "../helpers/frames.js";

const BASE = "http://fake.factory";
type Json = Record<string, unknown>;

function entry(id: string, extra: Partial<VideoEntry> = {}): VideoEntry {
  return {
    id,
    title: id,
    subtitle: "",
    duration: 60,
    fps: 10,
    frames: 600,
    grid_step: 2,
    default_start: 0,
    proxy: `/api/v2/videos/${id}/media`,
    proxy_wh: [960, 540],
    native_wh: [1280, 720],
    held_out: [],
    ...extra,
  };
}

const header = { recording: "pfr1", video: "dry1", source: entry("dry1") };

const get = (fake: FakeFactory, path: string, init?: RequestInit): Promise<Response> =>
  fake.fetch(`${BASE}${path}`, init);

function send(
  fake: FakeFactory,
  method: string,
  path: string,
  body?: unknown,
  type = "application/json",
): Promise<Response> {
  const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return fake.fetch(`${BASE}${path}`, {
    method,
    body: text,
    headers: text === undefined ? {} : { "Content-Type": type },
  });
}

/** Status, code and field of an error reply. */
async function fault(res: Promise<Response>): Promise<[number, unknown, unknown]> {
  const r = await res;
  const b = (await r.json()) as Json;
  return [r.status, b.code, b.field];
}

/** The status and the whole body of an error reply. */
async function refusal(res: Promise<Response>): Promise<Json> {
  const r = await res;
  return { status: r.status, ...((await r.json()) as Json) };
}

async function body(res: Promise<Response>): Promise<Json> {
  const r = await res;
  expect(r.status).toBe(200);
  return (await r.json()) as Json;
}

/** Reads up to `n` chunks of a streamed reply, then cancels it. */
async function chunks(res: Response, n = Number.POSITIVE_INFINITY): Promise<string[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const out: string[] = [];
  const dec = new TextDecoder();
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(dec.decode(value));
  }
  await reader.cancel();
  return out;
}

const frameIds = (texts: readonly string[]): number[] =>
  texts.filter((x) => x.includes("event: frame")).map((x) => Number(/^id: \w+-(\d+)/.exec(x)?.[1]));

describe("FakeFactory: loading", () => {
  it("reads recordings from text lines, objects, files and directories", async () => {
    const worker = { state: "idle", reason: "nobody is watching", fps: 0, session: 1, g: 2, errors: 0 };
    const fake = new FakeFactory([
      JSON.stringify(header),
      "",
      "not json",
      JSON.stringify(mkFrame(1)),
      mkFrame(2),
      JSON.stringify({ sse: "worker", data: worker, recv: 1 }),
    ]);
    expect(fake.header?.video).toBe("dry1");
    expect(fake.state).toMatchObject({ session: 1, video: "dry1", duration: 60, focus: null });
    const status = await body(get(fake, "/api/v2/status"));
    expect(status.worker).toEqual(worker);
    expect(status.retained).toEqual({ session: 1, g0: 1, g1: 2, t0: 0.2, t1: 0.4, n: 2 });
    expect((await body(get(fake, "/api/v2/session"))).worker).toEqual(worker);
    expect((await body(get(fake, "/api/v2/health"))).worker).toBe("running"); // as the unit's, whatever the worker does

    const fromArray = await FakeFactory.create({ recording: [header, mkFrame(3)] });
    expect((await body(get(fromArray, "/api/v2/session/world"))).g).toBe(3);

    const fixtures = await FakeFactory.fromFixtures(FIXTURES.slice(0, -1), "joined-mid-move");
    expect(fixtures.header?.name).toBe("joined-mid-move");

    const index = readJson<Json>("api/INDEX.json");
    const bySlash = await FakeFactory.loadReplies(`${FIXTURES}api/`);
    const byUrl = await FakeFactory.loadReplies(pathToFileURL(`${FIXTURES}api`));
    expect(Object.keys(bySlash).sort()).toEqual(Object.keys(index).sort());
    expect(byUrl.getSession?.body).toEqual(bySlash.getSession?.body);
    expect(byUrl.getSession?.headers).not.toHaveProperty("Content-Length");

    const dir = mkdtempSync(join(tmpdir(), "pdigger-factory-sdk-ts-"));
    writeFileSync(
      join(dir, "INDEX.json"),
      JSON.stringify({ getHealth: { file: "h.json", status: 200, content_type: null } }),
    );
    writeFileSync(join(dir, "h.json"), '{"ok":true,"worker":"idle","viewers":0}');
    const bare = await FakeFactory.loadReplies(dir);
    expect(bare.getHealth).toMatchObject({ status: 200, headers: {}, contentType: undefined });
    const res = await get(new FakeFactory([], { replies: bare }), "/api/v2/health");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.json()).toEqual({ ok: true, worker: "idle", viewers: 0 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts from the recorded session, the clock lines or its own defaults", async () => {
    const recorded = readJson<{ state: State; server_now: number }>("api/getSession.json");
    const getSession = { body: JSON.stringify(recorded) };
    const fromReply = new FakeFactory([], { replies: { getSession } });
    expect(fromReply.state.session).toBe(recorded.state.session);
    expect(fromReply.state.video).toBe(recorded.state.video);
    // its own clock starts at the recording's first clock time, else the recorded session's, else its epoch
    expect(fromReply.now).toBe(recorded.server_now);
    const line = (at?: number): object => ({ sse: "clock", data: { ...recorded.state, server_now: at } });
    expect(new FakeFactory([header, line(1_794_958_000.5), mkFrame(1)], { replies: { getSession } }).now).toBe(
      1_794_958_000.5,
    );
    expect(new FakeFactory([header, line(), mkFrame(1)], { replies: { getSession } }).now).toBe(1_794_950_000);
    // a clock of yours is the fake's wall clock
    const given = new ManualClock(5_000);
    const timed = new FakeFactory([header, line(1_794_958_000.5), mkFrame(1)], { clock: given });
    expect(timed.now).toBe(5);
    await given.advance(1_000);
    expect(timed.now).toBe(6);

    const bare = new FakeFactory();
    expect(bare.header).toBeNull();
    expect(bare.state).toMatchObject({ session: 1, video: "fake", duration: null, playing: true, rate: 0.8 });
    expect(bare.now).toBe(1_794_950_000);
    const reply = await body(get(bare, "/api/v2/session"));
    expect(reply.server_now).toBe(1_794_950_000);
    // without a recorded worker: running, on the current session
    expect(reply.worker).toEqual({ state: "running", reason: "", session: 1, video: "fake" });
    expect((await body(get(bare, "/api/v2/status"))).worker).toEqual(reply.worker);
    expect((await body(get(bare, "/api/v2/status"))).retained).toEqual({
      session: 1,
      g0: null,
      g1: null,
      t0: null,
      t1: null,
      n: 0,
    });

    const live = new FakeFactory([], { live: true, endOfData: "close" });
    expect(live.state).toMatchObject({ session: 1, revision: 3, video: LIVE_CAMERA, rate: 1, duration: null });
    expect(live.state.live).toMatchObject({ phase: "live", warmup: 3, lag: LIVE_LAG_S });
    const catalog = await body(get(live, "/api/v2/videos"));
    expect(catalog.default_video).toBe(LIVE_CAMERA); // nothing else to show
    const events = await chunks(await get(live, "/api/v2/session/frames/stream"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^event: clock\n/);

    const listed = new FakeFactory([header], {
      replies: { listVideos: { body: { schema: "stone-interpreter-catalog-v1", title: "t", videos: [entry("cam")] } } },
    });
    const listing = await body(get(listed, "/api/v2/videos"));
    expect((listing.videos as VideoEntry[]).map((v) => v.id)).toEqual(["cam", "dry1"]);
    expect(listing.default_video).toBe("dry1"); // the recording, as on the unit
  });

  it("takes appended frames, side events and revisions", async () => {
    const fake = new FakeFactory([header, mkFrame(1)], { endOfData: "close" });
    expect(() => fake.failNext("getWorld", 1, "no-such-reply")).toThrow("no recorded reply no-such-reply");
    const bare = mkFrame(2);
    delete (bare as Partial<Frame>).cursor;
    const late = mkFrame(4, { cursor: 100 });
    const revisions = [
      mkFrame(3, { world: false }),
      mkFrame(3, { rev: 2, stones: [stone(9)] }),
      mkFrame(3, { rev: 1 }),
      mkFrame(3, { world: false }),
    ];
    fake.appendFrames([bare, ...revisions, late]);
    const world3 = await body(get(fake, "/api/v2/session/frames/3?layers=world"));
    expect((world3.world as Json).rev).toBe(2);
    const ids = frameIds(await chunks(await get(fake, "/api/v2/session/frames/stream")));
    expect(ids).toEqual([2, 3, 4, 5, 6, 7, 100]);

    const state = { ...fake.state, revision: 9, playing: false };
    fake.appendSide("clock", { ...state, server_now: 1 });
    expect(fake.state.revision).toBe(9);
    expect(fake.state.playing).toBe(false);
    fake.appendSide("clock", "not an object");
    fake.appendSide("gap", { gap: 2 });
    expect(fake.state.revision).toBe(9);
  });
});

describe("FakeFactory: routes", () => {
  it("answers 404 and 405 like the server and records the operation", async () => {
    const fake = new FakeFactory();
    expect(await fault(get(fake, "/api/v2/health", { method: "POST" }))).toEqual([
      405,
      "method_not_allowed",
      undefined,
    ]);
    expect(fake.requests.at(-1)?.operationId).toBe("getHealth");
    expect(await fault(get(fake, "/api/v2/nothing-here"))).toEqual([404, "not_found", undefined]);
    expect(fake.requests.at(-1)?.operationId).toBe("unknown");
  });

  it("synthesises the meta operations without recorded replies", async () => {
    const fake = await FakeFactory.create({ recording: recordingPath("dry1-0296-0306-full") });
    const spec = await get(fake, "/api/v2/openapi.yaml");
    expect(spec.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await spec.text()).toBe("openapi: 3.1.0\n");
    expect(await (await get(fake, "/metrics")).text()).toBe("interp_viewers 0\n");
    expect((await body(get(fake, "/api/v2/model"))).checkpoint).toBe("fake");
    expect((await body(get(fake, "/api/v2/topology"))).bones).toBeDefined();
    expect((await body(get(fake, "/api/v2/ready"))).ready).toBe(true);
    expect((await body(get(fake, "/api/v2/health"))).ok).toBe(true);
    const status = await body(get(fake, "/api/v2/status"));
    expect(status.build).toBe("fake-sdk-ts");
    expect((status.retained as Json).n).toBeGreaterThan(0);
    expect(await fault(get(fake, "/api/v2/raw/tensors/1"))).toEqual([404, "debug_disabled", undefined]);
  });

  it("serves media without a recorded range", async () => {
    const fake = new FakeFactory([header]);
    const whole = await get(fake, "/api/v2/videos/dry1/media");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("etag")).toBe('"fake-media"');
    expect((await whole.arrayBuffer()).byteLength).toBe(65536);
    const part = await get(fake, "/api/v2/videos/dry1/media", { headers: { Range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-9/65536");
    expect(
      (await get(fake, "/api/v2/videos/dry1/media", { headers: { "If-None-Match": '"fake-media"' } })).status,
    ).toBe(304);
  });

  it("resolves the focus only while the stone has a track", async () => {
    const fake = new FakeFactory([header, mkFrame(1, { stones: [stone(4)] })]);
    const focus = { n: 1, session: 1, video: "dry1", id: 77, g: 1, t: 0.2, x: 0, y: 0, z: 0, L: 0.2, W: 0.1, yaw: 0 };
    fake.appendSide("clock", { ...fake.state, focus });
    expect(await body(get(fake, "/api/v2/session/focus"))).toEqual({ focus, resolved: null });
  });

  it("validates control bodies", async () => {
    const listVideos = {
      body: { schema: "stone-interpreter-catalog-v1", title: "t", videos: [entry("cam", { duration: null })] },
    };
    const fake = new FakeFactory([header, mkFrame(1, { stones: [stone(4)] })], { replies: { listVideos } });
    const select = "/api/v2/session/select";
    expect(await fault(send(fake, "POST", select))).toEqual([400, "invalid_json", undefined]);
    expect(await fault(send(fake, "POST", select, "x".repeat(600)))).toEqual([413, "body_too_large", undefined]);
    expect(await fault(send(fake, "POST", select, { video: "dry1" }, "text/plain"))).toEqual([
      415,
      "json_only",
      undefined,
    ]);
    expect(await fault(get(fake, select, { method: "POST", body: '{"video":"dry1"}' }))).toEqual([
      415,
      "json_only",
      undefined,
    ]);
    expect(await fault(send(fake, "POST", select, "{"))).toEqual([400, "invalid_json", undefined]);
    expect(await fault(send(fake, "POST", select, [1]))).toEqual([400, "not_an_object", undefined]);
    // the video in the unit's words (Python's repr of what was sent), field `video`
    const video = (status: number, code: string, error: string): Json => ({ status, code, error, field: "video" });
    expect(await refusal(send(fake, "POST", select, {}))).toEqual(video(400, "missing_field", "Unknown video None"));
    expect(await refusal(send(fake, "POST", select, { video: null }))).toEqual(
      video(400, "invalid_type", "Unknown video None"),
    );
    expect(await refusal(send(fake, "POST", select, { video: 5 }))).toEqual(
      video(400, "invalid_type", "Unknown video 5"),
    );
    expect(await refusal(send(fake, "POST", select, { video: true }))).toEqual(
      video(400, "invalid_type", "Unknown video True"),
    );
    expect(await refusal(send(fake, "POST", select, { video: false }))).toEqual(
      video(400, "invalid_type", "Unknown video False"),
    );
    expect(await refusal(send(fake, "POST", select, { video: [1] }))).toEqual(
      video(400, "invalid_type", "Unknown video [1]"),
    );
    expect(await refusal(send(fake, "POST", select, { video: "nope" }))).toEqual(
      video(400, "unknown_video", "Unknown video 'nope'"),
    );
    // the time: its type (`null` too), then the source's range, field `time`
    const time = (code: string, error = "time must be within 0..60.000 s"): Json => ({
      status: 400,
      code,
      error,
      field: "time",
    });
    expect(await refusal(send(fake, "POST", select, { video: "dry1", time: "x" }))).toEqual(time("invalid_type"));
    expect(await refusal(send(fake, "POST", select, { video: "dry1", time: null }))).toEqual(time("invalid_type"));
    expect(await refusal(send(fake, "POST", select, { video: "dry1", time: 61 }))).toEqual(time("time_out_of_range"));
    expect(await refusal(send(fake, "POST", select, { video: "dry1", time: -1 }))).toEqual(time("time_out_of_range"));
    expect(await refusal(send(fake, "POST", select, '{"video":"dry1","time":1e400}'))).toEqual(time("invalid_type"));
    expect(await refusal(send(fake, "POST", "/api/v2/session/seek", {}))).toEqual(time("missing_field"));

    const focus = "/api/v2/session/focus";
    expect(await fault(send(fake, "PUT", focus, {}))).toEqual([400, "missing_field", "stone_id"]);
    expect(await fault(send(fake, "PUT", focus, { stone_id: "4" }))).toEqual([400, "invalid_type", "stone_id"]);
    expect(await fault(send(fake, "PUT", focus, { stone_id: 1.5 }))).toEqual([400, "invalid_type", "stone_id"]);
    expect(await fault(send(fake, "PUT", focus, { stone_id: -1 }))).toEqual([400, "invalid_param", "stone_id"]);
    expect(await fault(send(fake, "PUT", focus, { stone_id: 4, session: 999 }))).toEqual([
      409,
      "stale_session",
      "session",
    ]);
    expect(await fault(send(fake, "PUT", focus, { stone_id: 77 }))).toEqual([404, "unknown_stone", "stone_id"]);
    expect((await body(send(fake, "PUT", focus, { stone_id: 4, session: 1 }))).state).toMatchObject({
      focus: { id: 4 },
    });

    expect((await body(send(fake, "POST", "/api/v2/session/pause"))).state).toMatchObject({ playing: false });
    expect((await body(send(fake, "POST", select, { video: "cam" }))).state).toMatchObject({
      video: "cam",
      duration: null,
    });
    // no duration (and not a camera): any time from 0
    expect(await refusal(send(fake, "POST", "/api/v2/session/seek", { time: -1 }))).toEqual(
      time("time_out_of_range", "time must be at least 0 s"),
    );
    expect((await body(send(fake, "POST", "/api/v2/session/seek", { time: 5 }))).state).toMatchObject({
      video: "cam",
      anchor_media: 5,
    });
    // no frame of `cam` has a world: the unit's Stable sim is not running
    expect(await refusal(send(fake, "PUT", focus, { stone_id: 4 }))).toEqual({
      status: 503,
      code: "world_unavailable",
      error: "the Stable sim is not running",
      retry_ms: 1000,
    });

    const live = new FakeFactory([header, mkFrame(1)], { live: true });
    // a select of a camera with any time, of any type, `null` too
    for (const t of [1, "1", null]) {
      expect(await refusal(send(live, "POST", select, { video: LIVE_CAMERA, time: t }))).toEqual({
        status: 400,
        code: "not_seekable",
        error: `${LIVE_CAMERA} is a live camera: leave time out`,
        field: "time",
      });
    }
    expect(await refusal(send(live, "POST", "/api/v2/session/seek", { time: 1 }))).toEqual({
      status: 409,
      code: "not_seekable",
      error: `${LIVE_CAMERA} is a live camera and cannot seek`,
      field: "video",
    });
    expect(((await body(send(live, "POST", select, { video: "dry1" }))).state as State).live).toBeUndefined();
    const elsewhere = { time: 1, video: LIVE_CAMERA }; // from a recording, a seek into the camera
    expect(await fault(send(live, "POST", "/api/v2/session/seek", elsewhere))).toEqual([409, "not_seekable", "video"]);
  });

  it("validates frame, world, event, stone and raster parameters", async () => {
    const noEvents = mkFrame(2, { stones: [stone(4)] });
    delete (noEvents.world as Partial<NonNullable<Frame["world"]>>).events;
    const fake = new FakeFactory([
      header,
      mkFrame(1, { stones: [stone(4)], events: [{ type: "new", id: 4 }] }),
      noEvents,
    ]);
    expect(await fault(get(fake, "/api/v2/session/frames/1?layers=world,bogus"))).toEqual([
      400,
      "unknown_layer",
      "layers",
    ]);
    for (const g of ["abc", "12345678901", "-1"]) {
      expect(await refusal(get(fake, `/api/v2/session/frames/${g}`))).toEqual({
        status: 400,
        code: "invalid_param",
        error: "g must be an integer or latest",
        field: "g",
      });
    }
    // ?session: an integer (empty: not given), the current one's, else gone
    expect(await refusal(get(fake, "/api/v2/session/frames/1?session=abc"))).toEqual({
      status: 400,
      code: "invalid_param",
      error: "session must be an integer",
      field: "session",
    });
    expect((await body(get(fake, "/api/v2/session/frames/1?session="))).g).toBe(1);
    expect((await body(get(fake, "/api/v2/session/frames/1?session=%2B1"))).g).toBe(1);
    expect(await refusal(get(fake, "/api/v2/session/frames/9?session=0"))).toEqual({
      status: 410,
      code: "session_gone",
      error: "session 0 has ended",
      field: "session",
    });
    const retained = { session: 1, g0: 1, g1: 2, t0: 0.2, t1: 0.4, n: 2 };
    expect(await refusal(get(fake, "/api/v2/session/frames/9"))).toEqual({
      status: 404,
      code: "not_retained",
      error: "frame 9 is not retained",
      field: "g",
      retained,
    });
    expect(await fault(get(fake, "/api/v2/session/frames/1/bogus.png"))).toEqual([404, "not_found", "raster"]);
    expect(await fault(get(fake, "/api/v2/session/frames/1/mask.png?scale=9"))).toEqual([
      400,
      "invalid_param",
      "scale",
    ]);
    const png = await get(fake, "/api/v2/session/frames/1/depth.png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(TINY_PNG);
    expect(await fault(get(fake, "/api/v2/session/world/events?after=x"))).toEqual([400, "invalid_param", "after"]);
    expect(await fault(get(fake, "/api/v2/session/world/events?type=new,bogus"))).toEqual([
      400,
      "invalid_param",
      "type",
    ]);
    const log = await body(get(fake, "/api/v2/session/world/events"));
    expect(log).toMatchObject({ next_after: 2, oldest_g: 1 });
    expect(log.events).toEqual([{ g: 1, t: 0.2, type: "new", id: 4 }]);
    expect(await fault(get(fake, "/api/v2/session/world/stones/x"))).toEqual([400, "invalid_param", "id"]);
    expect(await fault(get(fake, "/api/v2/raw/packets/1"))).toEqual([404, "not_retained", "g"]);

    const empty = new FakeFactory();
    expect(await refusal(get(empty, "/api/v2/session/world"))).toEqual({
      status: 503,
      code: "world_unavailable",
      error: "the Stable sim is not running",
      retry_ms: 1000,
    });
    // no frame retained: no oldest_g
    expect(await body(get(empty, "/api/v2/session/world/events"))).toEqual({
      session: 1,
      video: "fake",
      events: [],
      next_after: -1,
    });
    expect(await refusal(get(empty, "/api/v2/session/frames/latest"))).toEqual({
      status: 404,
      code: "not_retained",
      error: "no frame is retained yet",
      field: "g",
      retained: { session: 1, g0: null, g1: null, t0: null, t1: null, n: 0 },
    });
    // the oldest retained frame, with a world or not
    const worldless = new FakeFactory([
      header,
      mkFrame(1, { world: false }),
      mkFrame(2, { events: [{ type: "new" }] }),
    ]);
    expect(await body(get(worldless, "/api/v2/session/world/events"))).toMatchObject({ next_after: 2, oldest_g: 1 });
  });

  it("answers data operations of an empty session from recorded replies", async () => {
    const replies = await FakeFactory.loadReplies(`${FIXTURES}api`);
    const fake = new FakeFactory([], { replies });
    const text = (name: string): Json =>
      JSON.parse(new TextDecoder().decode(replies[name]?.body as Uint8Array)) as Json;
    expect(await body(get(fake, "/api/v2/session/frames/latest"))).toEqual(text("getFrame-latest"));
    expect(await body(get(fake, "/api/v2/session/focus"))).toEqual(text("getFocus"));
    expect(await body(get(fake, "/api/v2/session/world"))).toEqual(text("getWorld"));
    expect(await body(get(fake, "/api/v2/session/world/events"))).toEqual(text("getWorldEvents"));
    expect(await body(get(fake, "/api/v2/session/world/stones/5"))).toEqual(text("getStone"));
    expect(await fault(get(fake, "/api/v2/session/frames/1/regions.png"))).toEqual([404, "not_retained", "g"]);
  });

  it("renders overlays and scenes from frames when nothing is recorded", async () => {
    const full = await FakeFactory.create({ recording: recordingPath("dry1-0296-0306-full") });
    const g = (await body(get(full, "/api/v2/session/frames/latest?layers=world"))).g as number;
    const o = (await body(get(full, `/api/v2/session/render/overlay2d?g=${g}`))) as unknown as Overlay2D;
    expect(o).toMatchObject({ schema: "r2d1", g, mode: "stable", native_wh: [1920, 1080] });
    const s = (await body(get(full, `/api/v2/session/render/scene3d?t=10000&mode=raw`))) as unknown as Scene3D;
    expect(s).toMatchObject({ schema: "r3d1", g, mode: "raw", surface: null });
    expect(Object.keys(s.plane)).toContain("n");
    expect(s.skeleton.joints).toHaveLength(70);

    const plain = readJson<Frame>("frames/dry1-plain-full.json");
    delete plain.scene?.rings;
    const held = stone(1, [0, 0, 0.05], { side: "left" });
    const placed = stone(3, [0, 0, 0.05], { detected: false, mode: "placed" });
    const kept = stone(4, [0, 0, 0.05], { detected: false });
    const board = { cx: 1, cy: 2, theta: 0, hw: 3, hh: 4 };
    const fake = new FakeFactory([
      header,
      mkFrame(1, { stones: [held, stone(2), placed, kept], board }),
      mkFrame(2, { video: "elsewhere" }),
      mkFrame(3, { world: false }),
      { ...plain, session: 1, g: 4, cursor: 10 },
    ]);
    const o1 = (await body(get(fake, "/api/v2/session/render/overlay2d?g=1&draw=primitives"))) as unknown as Overlay2D;
    expect(o1.stones?.map((x) => x.style)).toEqual(["held", "detected", "placed", "kept"]);
    expect(o1.native_wh).toEqual([1280, 720]);
    expect(((await body(get(fake, "/api/v2/session/render/overlay2d?g=2"))) as unknown as Overlay2D).native_wh).toEqual(
      [1920, 1080],
    );
    const s1 = (await body(get(fake, "/api/v2/session/render/scene3d?g=1&surface=none"))) as unknown as Scene3D;
    expect(s1).toMatchObject({ board, plane: {}, skeleton: { joints: [], rings: [] } });
    expect(s1.stones).toHaveLength(4);
    const s3 = (await body(get(fake, "/api/v2/session/render/scene3d?g=3"))) as unknown as Scene3D;
    expect(s3).toMatchObject({ board: null, stones: [] });
    expect(((await body(get(fake, "/api/v2/session/render/overlay2d?g=3"))) as unknown as Overlay2D).stones).toEqual(
      [],
    );
    const s4 = (await body(get(fake, "/api/v2/session/render/scene3d?g=4"))) as unknown as Scene3D;
    expect(s4.skeleton.rings).toEqual([]);

    const r2 = "/api/v2/session/render/overlay2d";
    expect(await fault(get(fake, `${r2}?g=1&t=1`))).toEqual([400, "invalid_param", "t"]);
    expect(await fault(get(fake, r2))).toEqual([400, "invalid_param", "t"]);
    expect(await fault(get(fake, `${r2}?g=1&mode=fancy`))).toEqual([400, "invalid_param", "mode"]);
    expect(await fault(get(fake, `${r2}?g=1&draw=fancy`))).toEqual([400, "invalid_param", "draw"]);
    expect((await get(fake, `${r2}?g=1&surface=fancy`)).status).toBe(200);
    expect(await fault(get(fake, `/api/v2/session/render/scene3d?g=1&surface=fancy`))).toEqual([
      400,
      "invalid_param",
      "surface",
    ]);
    expect(await fault(get(fake, `${r2}?t=0.1`))).toEqual([404, "not_retained", "t"]);
    expect(await fault(get(fake, `${r2}?t=abc`))).toEqual([404, "not_retained", "t"]);
    expect(await fault(get(fake, `${r2}?t=Infinity`))).toEqual([404, "not_retained", "t"]);
  });
});

describe("FakeFactory: fetch", () => {
  it("takes Request objects, byte bodies, aborts and a delay hook", async () => {
    const seen: string[] = [];
    const ctl = new AbortController();
    const fake = new FakeFactory([header, mkFrame(1)], {
      delay: (r) => {
        seen.push(r.path);
        if (r.path.endsWith("/ready")) ctl.abort(new Error("stopped in the delay"));
      },
    });
    expect((await fake.fetch(new Request(`${BASE}/api/v2/health`))).status).toBe(200);
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", body: null });
    const json = { "Content-Type": "application/json" };
    const viaRequest = new Request(`${BASE}/api/v2/session/play`, { method: "POST", body: "{}", headers: json });
    expect((await fake.fetch(viaRequest)).status).toBe(200);
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", body: "{}", operationId: "sessionPlay" });
    const bytes = new TextEncoder().encode('{"time": 1}');
    expect(
      (await fake.fetch(`${BASE}/api/v2/session/seek`, { method: "POST", body: bytes, headers: json })).status,
    ).toBe(200);
    expect(fake.requests.at(-1)?.body).toBe('{"time": 1}');
    const done = new AbortController();
    done.abort(new Error("aborted before"));
    await expect(fake.fetch(`${BASE}/api/v2/health`, { signal: done.signal })).rejects.toThrow("aborted before");
    await expect(fake.fetch(`${BASE}/api/v2/ready`, { signal: ctl.signal })).rejects.toThrow("stopped in the delay");
    expect(seen).toEqual(["/api/v2/health", "/api/v2/session/play", "/api/v2/session/seek", "/api/v2/ready"]);
  });
});

describe("FakeFactory: streams", () => {
  it("picks the format from the query or Accept, and skips what NDJSON cannot carry", async () => {
    const fake = new FakeFactory([header, mkFrame(1), { sse: "clock", data: { session: 1 } }, mkFrame(2)], {
      endOfData: "close",
    });
    const stream = "/api/v2/session/frames/stream";
    expect(await fault(get(fake, `${stream}?format=xml`))).toEqual([400, "invalid_param", "format"]);
    const key = (l: string): unknown => (JSON.parse(l) as Json).gap ?? (JSON.parse(l) as Json).g;
    fake.injectReset(); // NDJSON cannot carry a reset: the next connection skips it
    const nd = await get(fake, stream, {
      headers: { Accept: "application/x-ndjson", "Last-Event-ID": "fakeboot01-2" },
    });
    expect(nd.headers.get("content-type")).toBe("application/x-ndjson");
    expect((await chunks(nd)).map(key)).toEqual([1, 2]);
    fake.injectGap(3);
    const lines = await chunks(
      await get(fake, `${stream}?format=ndjson`, { headers: { "Last-Event-ID": "otherboot1-1" } }),
    );
    expect(lines.map(key)).toEqual([3, 1, 2]);
    const sse = await chunks(await get(fake, `${stream}?format=sse`, { headers: { "Last-Event-ID": "otherboot1-1" } }));
    expect(frameIds(sse)).toEqual([2]);
  });

  it("restarts on injectReset: a new boot, cursors from 1 again, open streams break, one reset next", async () => {
    const frames = [mkFrame(10, { cursor: 500 }), mkFrame(11, { cursor: 501 }), mkFrame(12, { cursor: 502 })];
    const fake = new FakeFactory([header, ...frames]);
    const stream = "/api/v2/session/frames/stream";
    const open = await get(fake, stream);
    const reader = (open.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const first: string[] = [];
    for (let i = 0; i < 3; i++) first.push(dec.decode((await reader.read()).value));
    expect(frameIds(first)).toEqual([500, 501, 502]);
    expect(fake.boot).toBe("fakeboot01");
    const waiting = reader.read(); // the end of the data: the stream waits for more
    await settle();
    fake.injectReset("boot2");
    expect(fake.boot).toBe("boot2");
    await expect(waiting).rejects.toThrow("the unit restarted");
    expect(fake.streams).toBe(0);
    // a resume with an id of the old boot: one reset (its newest cursor), then the frames numbered anew
    const resumed = await chunks(await get(fake, stream, { headers: { "Last-Event-ID": "fakeboot01-502" } }), 4);
    expect(resumed.filter((x) => x.startsWith("event: reset"))).toEqual([
      'event: reset\ndata: {"boot":"boot2","cursor":3}\n\n',
    ]);
    expect(frameIds(resumed)).toEqual([1, 2, 3]);
    expect(resumed.find((x) => x.includes("event: frame"))).toMatch(/^id: boot2-1\n/);
    expect(((await (await get(fake, "/api/v2")).json()) as { boot: string }).boot).toBe("boot2");
    expect(((await (await get(fake, "/api/v2/status")).json()) as { boot: string }).boot).toBe("boot2");
    // the new boot resumes by its own ids, without a reset
    const same = await chunks(await get(fake, stream, { headers: { "Last-Event-ID": "boot2-2" } }), 1);
    expect(frameIds(same)).toEqual([3]);
    fake.close();
  });

  it("skips frames without a raw packet on the raw stream, and ends at max_s", async () => {
    const withRaw = (g: number): Frame => ({ ...mkFrame(g), raw: { schema: "sip1", g } as unknown as Frame["raw"] });
    const fake = new FakeFactory([header, withRaw(1), mkFrame(2), withRaw(3)], { endOfData: "close" });
    const raw = await chunks(await get(fake, "/api/v2/raw/stream"));
    expect(frameIds(raw)).toEqual([2, 4]);
    const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((g) => mkFrame(g));
    const paced = new FakeFactory([header, ...frames], { endOfData: "close" });
    expect(frameIds(await chunks(await get(paced, "/api/v2/session/frames/stream?max_s=1")))).toEqual([1, 2, 3, 4, 5]);
    expect(await fault(get(paced, "/api/v2/session/frames?cid=bad"))).toEqual([400, "invalid_param", "cid"]);
  });

  it("paces frames at media time on its clock", async () => {
    const frames = [0, 1, 2].map((g) => mkFrame(g));
    const clock = new InstantClock(5000);
    const fake = new FakeFactory([header, ...frames], { endOfData: "close", realtime: true, clock });
    expect(frameIds(await chunks(await get(fake, "/api/v2/session/frames/stream")))).toEqual([1, 2, 3]);
    expect(clock.now()).toBe(5400);

    const manual = new ManualClock(0);
    const held = new FakeFactory([header, ...frames], { realtime: true, clock: manual });
    const res = await get(held, "/api/v2/session/frames/stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^id: fakeboot01-1\n/);
    const next = reader.read();
    await settle();
    expect(manual.pending).toBe(1);
    await reader.cancel();
    expect((await next).done).toBe(true);
    expect(held.streams).toBe(0);
  });

  it("ends held streams when closed", async () => {
    const fake = new FakeFactory([header, mkFrame(1)]);
    const res = await get(fake, "/api/v2/session/frames/stream?layers=world");
    const read = chunks(res);
    await settle();
    expect(fake.streams).toBe(1);
    fake.close();
    expect(frameIds(await read)).toEqual([2]);
    expect(fake.streams).toBe(0);
  });

  it("takes the recording's later clock lines as playback passes them, a long-poll reply by reply", async () => {
    const fake = await fixtureFake("dry1-0000-0130", { endOfData: "close" });
    const revision = async (): Promise<unknown> => ((await body(get(fake, "/api/v2/session"))).state as Json).revision;
    expect(await revision()).toBe(398); // the first clock line
    const poll = (cursor: number): Promise<Json> =>
      body(get(fake, `/api/v2/session/frames?cursor=${cursor}&limit=16&wait=0`));
    const gs = (reply: Json): number[] => (reply.frames as Frame[]).map((f) => f.g);
    // a reply ends before a clock line not yet taken: its state is that of all its frames; the next one takes it
    const first = await poll(0);
    expect([(first.state as Json).revision, gs(first), first.cursor]).toEqual([398, [0, 20, 21, 22], 75]);
    const second = await poll(75);
    expect([(second.state as Json).revision, gs(second)[0], gs(second).length]).toEqual([399, 23, 16]);
    expect(await revision()).toBe(399);
    // a stream takes them as it passes them, the raw stream too (NDJSON sends none)
    await chunks(await get(fake, "/api/v2/raw/stream?format=ndjson"));
    expect(await revision()).toBe(400);
    // a control ends it, at a revision above the recording's clock lines, which are then only sent
    const again = await fixtureFake("dry1-0000-0130", { endOfData: "close" });
    const paused = (await body(send(again, "POST", "/api/v2/session/pause"))).state as State;
    expect(paused).toMatchObject({ revision: 401, playing: false, anchor_media: 0 });
    const sent = await chunks(await get(again, "/api/v2/session/frames/stream?layers=world"));
    const clocks = sent
      .filter((x) => x.startsWith("event: clock"))
      .map((x) => (JSON.parse(x.slice(x.indexOf("{"))) as State).revision);
    expect(clocks).toEqual([398, 399, 400, 401]); // the recording's, then the pause's
    expect(again.state).toMatchObject({ revision: 401, playing: false });
  });
});

describe("FakeFactory: the 20.20 unit's ways", () => {
  const stream = "/api/v2/session/frames/stream";
  const worker = { sse: "worker", data: { state: "running", reason: "", fps: 5, session: 1, g: 4, errors: 0 } };

  it("starts a stream or a first poll at the newest frame of the session (connect: newest)", async () => {
    const frames = [0, 1, 2, 3, 4].map((g) => mkFrame(g));
    const fake = new FakeFactory([header, ...frames, worker], { connect: "newest", endOfData: "close" });
    const first = await chunks(await get(fake, stream));
    expect(frameIds(first)).toEqual([5]); // the newest frame, then the side events after it; no clock event
    expect(first.some((c) => c.includes("event: clock"))).toBe(false);
    expect(first.some((c) => c.includes("event: worker"))).toBe(true);
    expect(frameIds(await chunks(await get(fake, `${stream}?after=2`)))).toEqual([3, 4, 5]);
    const poll = await body(get(fake, "/api/v2/session/frames?limit=3"));
    expect((poll.frames as Json[]).map((f) => f.g)).toEqual([2, 3, 4]);
    expect(poll.cursor).toBe(5);
    const replay = new FakeFactory([header, ...frames], { endOfData: "close" });
    expect(frameIds(await chunks(await get(replay, stream)))).toEqual([1, 2, 3, 4, 5]); // the default: from the start

    const listVideos = {
      body: { schema: "stone-interpreter-catalog-v1", title: "t", videos: [entry("dry1"), entry("b")] },
    };
    const empty = new FakeFactory([header, ...frames], {
      connect: "newest",
      endOfData: "close",
      replies: { listVideos },
    });
    expect((await body(send(empty, "POST", "/api/v2/session/select", { video: "b" }))).state).toMatchObject({
      video: "b",
    });
    expect(frameIds(await chunks(await get(empty, stream)))).toEqual([]); // a session without frames: nothing yet
    expect((await body(get(empty, "/api/v2/session/frames?wait=0"))).frames).toEqual([]);
  });

  it("answers a long-poll at the end of a recording at once on its own clock; on a given one it waits", async () => {
    const poll = (fake: FakeFactory, init?: RequestInit): Promise<Response> =>
      get(fake, `/api/v2/session/frames?cursor=99999&rev=${fake.state.revision}&wait=1000`, init);
    const own = new FakeFactory([header, mkFrame(0), mkFrame(1)]);
    const now = own.now;
    let answered = false;
    const reply = body(poll(own));
    void reply.then(() => (answered = true));
    await until(() => answered, 20); // the unit answers within the wait; the fake's own clock moves only with the test
    expect([(await reply).frames, own.now]).toEqual([[], now]);
    const given = new FakeFactory([header, mkFrame(0), mkFrame(1)], { clock: new ManualClock(1_794_958_239_000) });
    const c = new AbortController();
    const waiting = poll(given, { signal: c.signal });
    await settle();
    c.abort(new Error("bye"));
    await expect(waiting).rejects.toThrow("bye"); // a waiting long-poll ends on an abort
  });

  it("holds a stream that reached limit or max_s open until the client closes it (atLimit: hold)", async () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((g) => mkFrame(g));
    const fake = new FakeFactory([header, ...frames], { atLimit: "hold", endOfData: "close" });
    for (const query of ["limit=3", "max_s=1"]) {
      const res = await get(fake, `${stream}?${query}`);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const texts: string[] = [];
      for (let i = 0; i < (query === "limit=3" ? 3 : 5); i++)
        texts.push(new TextDecoder().decode((await reader.read()).value));
      const next = reader.read();
      await settle();
      await settle();
      expect(fake.streams).toBe(1); // finished, still open, sending nothing
      await reader.cancel();
      expect((await next).done).toBe(true);
      expect(fake.streams).toBe(0);
      expect(frameIds(texts)).toEqual(query === "limit=3" ? [1, 2, 3] : [1, 2, 3, 4, 5]);
    }
    const closing = new FakeFactory([header, ...frames], { endOfData: "close" });
    expect(frameIds(await chunks(await get(closing, `${stream}?limit=3`)))).toEqual([1, 2, 3]); // the default: closed
  });

  it("refuses cross-origin controls and a dry_run other than 0 or 1, as the server does", async () => {
    const fake = new FakeFactory([header, mkFrame(1)]);
    const pause = (init: RequestInit = {}, query = ""): Promise<Response> =>
      fake.fetch(`${BASE}/api/v2/session/pause${query}`, { method: "POST", ...init });
    expect(await fault(pause({ headers: { Origin: "https://elsewhere.example" } }))).toEqual([
      403,
      "cross_origin",
      undefined,
    ]);
    expect(await fault(pause({}, "?dry_run=2"))).toEqual([400, "invalid_param", "dry_run"]);
    expect(await fault(pause({}, "?dry_run=true"))).toEqual([400, "invalid_param", "dry_run"]);
    expect((await body(pause({}, "?dry_run=1"))).state).toMatchObject({ playing: false });
    expect(fake.state.playing).toBe(true); // a dry run moves nothing
    expect((await body(pause({ headers: { Origin: BASE } }, "?dry_run=0"))).state).toMatchObject({ playing: false });
    expect(fake.state.playing).toBe(false);
  });

  it("runs a camera session on its clock: nothing released before live, a stream waits for each phase", async () => {
    const clock = new ManualClock(1_794_958_239_000);
    const frames = Array.from({ length: 30 }, (_x, k) => mkFrame(k)); // t = g / 5: 6 s
    const live = new FakeFactory([header, ...frames], { live: true, clock });
    const select = "/api/v2/session/select";
    const before = live.state;
    const selected = (await body(send(live, "POST", select, { video: LIVE_CAMERA }))).state as State;
    const since = clock.now() / 1000;
    expect(selected).toEqual({
      session: before.session + 1,
      revision: before.revision + 1,
      video: LIVE_CAMERA,
      playing: true,
      rate: 1,
      anchor_media: 0,
      anchor_wall: since,
      hold_until: since + 3600,
      duration: null,
      changed_by: "viewer",
      focus: null,
      media_time: 0,
      live: { phase: "connecting", warmup: 3, since, lag: 0 },
    });
    const nothing = {
      status: 404,
      code: "not_retained",
      error: "no frame is retained yet",
      field: "g",
      retained: { session: selected.session, g0: null, g1: null, t0: null, t1: null, n: 0 },
    };
    expect(await refusal(get(live, "/api/v2/session/frames/latest"))).toEqual(nothing);
    expect(await refusal(get(live, "/api/v2/session/frames/latest/image.jpg"))).toEqual(nothing);
    expect((await body(get(live, "/api/v2/status"))).retained).toEqual(nothing.retained);
    expect(await fault(get(live, "/api/v2/session/world"))).toEqual([503, "world_unavailable", undefined]);
    const stream = await get(live, "/api/v2/session/frames/stream?layers=world");
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const next = async (): Promise<string> => dec.decode((await reader.read()).value);
    expect(await next()).toContain('"phase":"connecting"');
    let pending = next(); // waits for the warming phase, on the fake's clock
    await settle();
    await clock.advance(CONNECT_S * 1000);
    expect(await pending).toContain('"phase":"warming"');
    expect(((await body(get(live, "/api/v2/session"))).state as State).live?.phase).toBe("warming");
    pending = next();
    await clock.advance(3_000);
    await settle();
    // the first frame after the warm-up arrives at 3.5 s (t = 0.5 + g / 5, g 15): live 0.25 s later
    expect(live.state.live?.phase).toBe("warming");
    await clock.advance((0.1 + LIVE_LAG_S) * 1000);
    const went = await pending;
    expect(went).toContain('"phase":"live"');
    const first = await next();
    expect(first).toMatch(/^id: fakeboot01-\d+\nevent: frame\n/);
    const frame = JSON.parse(first.split("data: ")[1] as string) as Frame;
    expect([frame.video, frame.g, frame.t]).toEqual([LIVE_CAMERA, 15, 3.5]);
    await reader.cancel();
    const pictured = await get(live, `/api/v2/session/frames/${frame.g}/image.jpg`);
    expect([pictured.status, pictured.headers.get("content-type"), pictured.headers.get("x-interp-g")]).toEqual([
      200,
      "image/jpeg",
      "15",
    ]);
    expect(pictured.headers.get("cache-control")).toBe("no-store");
    const jpeg = new Uint8Array(await pictured.arrayBuffer());
    expect(pictured.headers.get("content-length")).toBe(String(jpeg.length));
    expect([...jpeg.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xfe]); // the frame's note in a comment segment first
    for (const g of ["x", "12345678901"]) {
      expect(await refusal(get(live, `/api/v2/session/frames/${g}/image.jpg`))).toEqual({
        status: 400,
        code: "invalid_param",
        error: "g must be an integer or latest",
        field: "g",
      });
    }
  });

  it("holds a paused camera's phases, connects again on a play, and lets a waiting stream be cancelled", async () => {
    const clock = new ManualClock(1_794_958_239_000);
    const frames = Array.from({ length: 30 }, (_x, k) => mkFrame(k));
    const live = new FakeFactory([header, ...frames], { live: true, clock });
    const select = "/api/v2/session/select";
    const open = async (): Promise<() => Promise<ReadableStreamReadResult<Uint8Array>>> => {
      const res = await get(live, "/api/v2/session/frames/stream?layers=world");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      return () => reader.read();
    };
    const dec = new TextDecoder();
    const clockOf = (text: string): State & { server_now: number } =>
      JSON.parse(text.split("data: ")[1] as string) as State & { server_now: number };
    await body(send(live, "POST", "/api/v2/session/pause"));
    const selected = (await body(send(live, "POST", select, { video: LIVE_CAMERA }))).state as State; // paused
    const read = await open();
    expect(clockOf(dec.decode((await read()).value)).live?.phase).toBe("connecting");
    const pending = read();
    await settle();
    await clock.advance(10_000);
    expect(live.state.live?.phase).toBe("connecting"); // nothing runs while it is paused
    const played = (await body(send(live, "POST", "/api/v2/session/play"))).state as State;
    expect(played).toMatchObject({ playing: true, media_time: 0, anchor_media: 0, revision: selected.revision + 1 });
    expect(played.live?.phase).toBe("connecting"); // a play connects again: the phases come after it
    const play = clockOf(dec.decode((await pending).value));
    expect([play.revision, play.playing, play.live?.phase]).toEqual([played.revision, true, "connecting"]);
    const warming = read();
    await settle();
    expect(live.state.live?.phase).toBe("connecting");
    await clock.advance(CONNECT_S * 1000);
    const warm = clockOf(dec.decode((await warming).value));
    expect([warm.revision, warm.live?.phase]).toEqual([played.revision + 1, "warming"]);
    const going = read();
    await settle();
    await clock.advance(3_500);
    const onAir = clockOf(dec.decode((await going).value));
    expect([onAir.revision, onAir.playing, onAir.live?.phase]).toEqual([played.revision + 2, true, "live"]);
    expect(onAir.anchor_wall).toBeGreaterThan(played.anchor_wall + 3);
    // each phase's event at its own time, after the play that planned it
    expect([warm.server_now - play.server_now, onAir.server_now - warm.server_now]).toEqual([
      CONNECT_S,
      3 + LIVE_LAG_S,
    ]);
    expect(dec.decode((await read()).value)).toMatch(/^id: \S+\nevent: frame\n/);
    // a camera paused while warming connects again on a play too
    await body(send(live, "POST", select, { video: LIVE_CAMERA }));
    await live.advance(CONNECT_S);
    expect(live.livePhase).toBe("warming");
    await body(send(live, "POST", "/api/v2/session/pause"));
    const again = (await body(send(live, "POST", "/api/v2/session/play"))).state as State;
    expect([again.live?.phase, again.live?.lag]).toEqual(["connecting", 0]);
    // a stream cancelled while it waits for a phase stops waiting
    await body(send(live, "POST", select, { video: LIVE_CAMERA }));
    const res = await get(live, "/api/v2/session/frames/stream?layers=world");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect(dec.decode((await reader.read()).value)).toContain('"phase":"connecting"');
    const waiting = reader.read();
    await settle();
    expect(clock.pending).toBeGreaterThan(0);
    await reader.cancel();
    expect((await waiting).done).toBe(true);
    await settle();
    expect(live.streams).toBe(1); // the first stream only
  });

  it("answers a long-poll on a camera when its next phase comes, or after its wait while paused", async () => {
    const clock = new ManualClock(1_794_958_239_000);
    const frames = Array.from({ length: 30 }, (_x, k) => mkFrame(k));
    const live = new FakeFactory([header, ...frames], { live: true, clock, endOfData: "close" });
    const selected = (await body(send(live, "POST", "/api/v2/session/select", { video: LIVE_CAMERA }))).state as State;
    const poll = (rev: number): Promise<Json> =>
      body(get(live, `/api/v2/session/frames?cursor=0&rev=${rev}&wait=1000&layers=world`));
    let reply = poll(selected.revision); // waits for the warming phase (0.5 s), not the whole second
    await settle();
    await clock.advance(CONNECT_S * 1000);
    let answer = await reply;
    expect([(answer.state as State).live?.phase, answer.frames]).toEqual(["warming", []]);
    const paused = (await body(send(live, "POST", "/api/v2/session/pause"))).state as State;
    reply = poll(paused.revision);
    await settle();
    await clock.advance(999);
    await settle();
    expect(clock.pending).toBeGreaterThan(0); // still waiting: no phase comes while paused
    await clock.advance(1);
    answer = await reply;
    expect([(answer.state as State).live?.phase, answer.frames]).toEqual(["warming", []]);
  });

  it("warms a camera of a recorded catalog up for 3 s when its entry has no hold", async () => {
    const camera: VideoEntry = {
      id: "CAM9",
      kind: "camera",
      live: true,
      seekable: false,
      duration: null,
      frames: null,
      fps: 5,
      grid_step: 1,
      proxy: "",
      proxy_wh: [960, 540],
      native_wh: [1920, 1080],
    };
    const fake = new FakeFactory([header, mkFrame(1)], {
      replies: { listVideos: { body: { schema: "stone-interpreter-catalog-v1", videos: [entry("dry1"), camera] } } },
    });
    const state = (await body(send(fake, "POST", "/api/v2/session/select", { video: "CAM9" }))).state as State;
    expect(state.live).toMatchObject({ phase: "connecting", warmup: 3 });
    expect(await fault(get(fake, "/api/v2/videos/CAM9/media"))).toEqual([404, "not_found", "id"]);
  });

  it("lists its camera as the unit lists its plant cameras", async () => {
    type Spec = {
      paths: Record<string, { get: { responses: Record<string, { content: Record<string, { examples: Json }> }> } }>;
    };
    const spec = readJson<Spec>("../spec/openapi.json");
    const examples = spec.paths["/api/v2/videos"]!.get.responses["200"]!.content["application/json"]!.examples;
    const unit = (examples.ok_catalog_with_cameras as { value: { videos: VideoEntry[]; default_video: string } }).value;
    const plant = unit.videos.find((v) => v.kind === "camera") as VideoEntry;
    const live = new FakeFactory([header, mkFrame(1)], { live: true });
    const catalog = await body(get(live, "/api/v2/videos"));
    const videos = catalog.videos as VideoEntry[];
    const camera = videos.at(-1) as VideoEntry; // after the recordings, as on the unit
    expect(camera.id).toBe(LIVE_CAMERA);
    for (const key of Object.keys(camera)) expect(plant).toHaveProperty(key);
    for (const key of ["kind", "live", "seekable", "duration", "frames", "default_start", "grid_step", "hold", "proxy"])
      expect(camera[key as keyof VideoEntry]).toEqual(plant[key as keyof VideoEntry]);
    expect(catalog.default_video).toBe(videos[0]?.id); // a recording, as the unit's `aug28`
    expect(unit.default_video).toBe(unit.videos[0]?.id);
  });
});

describe("FakeFactory: the camera of the unit's build live3", () => {
  const select = "/api/v2/session/select";
  const seek = "/api/v2/session/seek";
  const pause = "/api/v2/session/pause";
  const play = "/api/v2/session/play";
  const focus = "/api/v2/session/focus";
  const stream = "/api/v2/session/frames/stream";
  const stateOf = async (res: Promise<Response>): Promise<State> => (await body(res)).state as State;
  /** The clock events and the frames' `g` of a read stream, in order. */
  const eventsOf = (texts: readonly string[]): (State & { server_now: number })[] =>
    texts
      .filter((x) => x.startsWith("event: clock"))
      .map((x) => JSON.parse(x.split("data: ")[1] as string) as State & { server_now: number });
  const framesOf = (texts: readonly string[]): Frame[] =>
    texts.filter((x) => x.includes("event: frame")).map((x) => JSON.parse(x.split("data: ")[1] as string) as Frame);
  const thirty = (): Frame[] => Array.from({ length: 30 }, (_x, k) => mkFrame(k)); // t = g / 5: 6 s

  it("plans a play right after live after the frames already sent", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    await stateOf(send(fake, "POST", pause));
    await stateOf(send(fake, "POST", play)); // now - since, 3.9411, is before the run's end, 4.688311 + 0.2
    await fake.advance(30);
    expect((await body(get(fake, "/api/v2/session/frames/42"))).t).toBe(8.579411); // 4.888311 + CONNECT_S + 3.1911
    expect(fake.state.anchor_media).toBe(8.579411);
  });

  it("plays a camera paused before it released anything from g 0, connecting at the play", async () => {
    const fake = new FakeFactory([header, ...thirty()], { live: true });
    await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA }));
    await stateOf(send(fake, "POST", pause)); // still connecting: nothing released
    await fake.advance(1);
    await stateOf(send(fake, "POST", play));
    await fake.advance(10);
    const latest = await body(get(fake, "/api/v2/session/frames/latest"));
    const f15 = await body(get(fake, "/api/v2/session/frames/15"));
    expect([latest.g, f15.t]).toEqual([29, 4.5]); // 1 s after the select + CONNECT_S + the frame's 3 s
  });

  it("checks a select and a seek in the unit's order, also while the session shows the camera", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    expect(fake.livePhase).toBe("live");
    const range = "time must be within 0..1807.158 s";
    const selects: [Json, string][] = [
      [{}, "missing_field"],
      [{ video: null }, "invalid_type"],
      [{ video: 5 }, "invalid_type"],
      [{ video: "nope" }, "unknown_video"],
      [{ video: LIVE_CAMERA, time: 3 }, "not_seekable"],
      [{ video: LIVE_CAMERA, time: null }, "not_seekable"],
      [{ video: "dry1", time: "x" }, "invalid_type"],
      [{ video: "dry1", time: null }, "invalid_type"],
      [{ video: "dry1", time: 99999 }, "time_out_of_range"],
    ];
    for (const [b, code] of selects)
      expect((await refusal(send(fake, "POST", `${select}?dry_run=1`, b))).code).toBe(code);
    expect((await refusal(send(fake, "POST", select, { video: "dry1", time: -1 }))).error).toBe(range);
    // a seek: its video (the one it names, else the one shown), a camera, then the time
    const camera = {
      status: 409,
      code: "not_seekable",
      error: `${LIVE_CAMERA} is a live camera and cannot seek`,
      field: "video",
    };
    const unknown = { status: 400, code: "unknown_video", error: "Unknown video 'nope'", field: "video" };
    const time = (code: string): Json => ({ status: 400, code, error: range, field: "time" });
    const seeks: [string, Json][] = [
      ['{"video":"nope"}', unknown],
      ['{"video":"nope","time":1}', unknown],
      ['{"video":null,"time":1}', { status: 400, code: "invalid_type", error: "Unknown video None", field: "video" }],
      ["{}", camera],
      ['{"time":true}', camera],
      ['{"time":3}', camera],
      [`{"video":"${LIVE_CAMERA}","time":1}`, camera],
      ['{"video":"dry1"}', time("missing_field")],
      ['{"video":"dry1","time":true}', time("invalid_type")],
      ['{"video":"dry1","time":null}', time("invalid_type")],
      ['{"video":"dry1","time":1e400}', time("invalid_type")],
      ['{"video":"dry1","time":-1}', time("time_out_of_range")],
    ];
    for (const [b, want] of seeks) expect(await refusal(send(fake, "POST", `${seek}?dry_run=1`, b))).toEqual(want);
    // a dry run answers the new state and moves nothing
    const before = fake.state;
    const dry = await body(send(fake, "POST", `${select}?dry_run=1`, { video: "dry1" }));
    const recording = dry.state as State;
    expect([dry.dry_run, recording.anchor_media, recording.session, recording.rate]).toEqual([
      true,
      139, // its default_start
      before.session + 1,
      0.8,
    ]);
    expect(recording.hold_until - recording.anchor_wall).toBeCloseTo(2.2, 6);
    expect("live" in recording).toBe(false);
    const cam = await stateOf(send(fake, "POST", `${select}?dry_run=1`, { video: LIVE_CAMERA }));
    expect([cam.live?.phase, cam.session]).toEqual(["connecting", before.session + 1]);
    expect(fake.state).toMatchObject({ session: before.session, revision: before.revision, video: LIVE_CAMERA });
    expect(fake.livePhase).toBe("live");
    // while a recording is shown, a seek naming the camera is refused too
    await body(send(fake, "POST", select, { video: "dry1" }));
    expect(await refusal(send(fake, "POST", seek, { video: LIVE_CAMERA, time: 1 }))).toEqual(camera);

    // a source without a duration, a default_start or a hold
    const plain = new FakeFactory([{ recording: "pfr1", source: { id: "v" } }, mkFrame(1, { video: "v" })]);
    expect(await refusal(send(plain, "POST", seek, { time: -1 }))).toEqual({
      status: 400,
      code: "time_out_of_range",
      error: "time must be at least 0 s",
      field: "time",
    });
    const v = await stateOf(send(plain, "POST", select, { video: "v" }));
    expect([v.session, v.anchor_media]).toEqual([2, 0]);
    expect(v.hold_until - v.anchor_wall).toBeCloseTo(1.4, 6);
    // no source at all: the session shows no video of the catalog
    const none = new FakeFactory();
    expect(await refusal(send(none, "POST", seek, { time: 1 }))).toEqual({
      status: 409,
      code: "not_seekable",
      error: "the session shows no video",
      field: "video",
    });
    expect((await refusal(send(none, "POST", select, { video: "v" }))).code).toBe("unknown_video");
  });

  it("counts as a camera what the unit does: an entry with live, or the design's old id live", async () => {
    const videos = [entry("live", { duration: null }), entry("k", { kind: "camera" })];
    const fake = new FakeFactory([header, mkFrame(1)], {
      replies: { listVideos: { body: { schema: "stone-interpreter-catalog-v1", videos } } },
    });
    expect(await refusal(send(fake, "POST", seek, { video: "live", time: 1 }))).toMatchObject({
      status: 409,
      error: "live is a live camera and cannot seek",
    });
    expect((await refusal(send(fake, "POST", select, { video: "live", time: 1 }))).code).toBe("not_seekable");
    // a kind without live is a recording: a time, a seek, its media
    const k = await stateOf(send(fake, "POST", select, { video: "k", time: 2 }));
    expect([k.video, k.anchor_media, "live" in k]).toEqual(["k", 2, false]);
    expect(await stateOf(send(fake, "POST", seek, { time: 3 }))).toMatchObject({ video: "k", anchor_media: 3 });
    expect((await get(fake, "/api/v2/videos/k/media")).status).toBe(200);
  });

  it("goes live on its own clock; a pause holds it, a play connects again and warms up after a break", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const start = await body(get(fake, "/api/v2/session"));
    const shown = start.state as State;
    expect(shown).toMatchObject({ revision: 3, changed_by: "start", video: LIVE_CAMERA });
    expect(shown.live).toEqual({ phase: "live", warmup: 3, since: expect.any(Number), lag: LIVE_LAG_S });
    expect(shown.media_time).toBeCloseTo((start.server_now as number) - (shown.live?.since as number) - LIVE_LAG_S, 6);
    const t0 = fake.now;
    const selected = await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA }));
    expect(selected).toMatchObject({ session: shown.session + 1, revision: 4, changed_by: "viewer", media_time: 0 });
    expect(selected.live).toEqual({ phase: "connecting", warmup: 3, since: t0, lag: 0 });
    expect((await refusal(send(fake, "POST", seek, { time: 3 }))).status).toBe(409);
    await fake.advance(CONNECT_S);
    expect(fake.livePhase).toBe("warming"); // taken without a request
    expect(fake.state).toMatchObject({ revision: 5, live: { phase: "warming", lag: 0 } }); // no lag before it is live
    await fake.advance(4);
    expect(fake.now).toBeCloseTo(t0 + 4.5, 6);
    expect(fake.state).toMatchObject({ revision: 6, anchor_media: 3.6911, live: { phase: "live", lag: LIVE_LAG_S } });
    const last = await body(get(fake, "/api/v2/session/frames/latest"));
    expect([last.g, last.t]).toEqual([21, 4.688311]);
    // a pause stops at the live edge, now - since - lag, and keeps the phase; a second pause changes nothing
    const paused = await stateOf(send(fake, "POST", pause));
    expect(paused).toMatchObject({ playing: false, revision: 7, changed_by: "viewer", live: { phase: "live" } });
    expect(paused.anchor_media).toBeCloseTo(4.25, 6);
    await fake.advance(2);
    const again = await body(send(fake, "POST", pause));
    expect(again.state).toEqual(paused);
    expect([fake.livePhase, fake.state.media_time]).toEqual(["live", paused.anchor_media]);
    // a dry-run play answers the connecting state and plans nothing
    const dry = await body(send(fake, "POST", `${play}?dry_run=1`));
    expect([dry.dry_run, (dry.state as State).live?.phase]).toEqual([true, "connecting"]);
    expect((dry.state as State).anchor_media).toBeCloseTo(6.25, 6);
    await fake.advance(5);
    expect([fake.livePhase, fake.state.revision]).toEqual(["live", 7]);
    // a play goes on at the live edge and connects again (its fields are ignored); its lag stays the live one
    const played = await body(send(fake, "POST", play, { video: "dry1", time: 5 }));
    const p = played.state as State;
    expect([played.dry_run, p.video, p.playing, p.revision, p.changed_by]).toEqual([
      false,
      LIVE_CAMERA,
      true,
      8,
      "viewer",
    ]);
    expect(p.live).toEqual({ phase: "connecting", warmup: 3, since: t0, lag: LIVE_LAG_S });
    expect([p.anchor_media, p.media_time].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([11.25, 11.25]);
    expect(fake.livePhase).toBe("connecting");
    await fake.advance(CONNECT_S);
    expect(fake.state).toMatchObject({ revision: 9, live: { phase: "warming", lag: LIVE_LAG_S } });
    await fake.advance(30);
    const onAir = fake.state;
    expect([onAir.revision, onAir.live?.phase]).toEqual([10, "live"]);
    // the run after the break: numbered from the last g + 1 + 4, its warm-up (16 frames) never released
    const g0 = 21 + 1 + 4;
    for (const g of [22, g0, g0 + 15])
      expect((await refusal(get(fake, `/api/v2/session/frames/${g}`))).status).toBe(404);
    const first = await body(get(fake, `/api/v2/session/frames/${g0 + 16}`));
    expect(first.t).toBeGreaterThan(4.688311);
    expect(onAir.anchor_media).toBe(first.t);
    expect(onAir.anchor_wall).toBeCloseTo(t0 + (first.t as number) + LIVE_LAG_S, 6);
    expect((await get(fake, "/api/v2/session/frames/21/image.jpg")).status).toBe(200); // the frames before the break
    // every change a clock event at its own time, in order: select, warming, live, pause, play, warming, live
    const texts = await chunks(await get(fake, `${stream}?layers=world`), 19);
    const events = eventsOf(texts);
    expect(events.map((e) => e.revision)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(events.map((e) => e.live?.phase)).toEqual([
      "connecting",
      "warming",
      "live",
      "live",
      "connecting",
      "warming",
      "live",
    ]);
    expect(events.map((e) => Math.round((e.server_now - t0) * 1e4) / 1e4)).toEqual([
      0,
      0.5,
      3.9411,
      4.5,
      11.5,
      12,
      Math.round(((first.t as number) + LIVE_LAG_S) * 1e4) / 1e4,
    ]);
    expect(framesOf(texts).map((f) => f.g)).toEqual([16, 17, 18, 19, 20, 21, 42, 43, 44, 45, 46, 47]);
  });

  it("gives every clock event the media time of its own moment", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const [start] = eventsOf(await chunks(await get(fake, `${stream}?layers=world`), 1));
    expect(start?.media_time).toBe(3.6911); // the camera the fake starts on, live
    await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA }));
    await fake.advance(4.5);
    await stateOf(send(fake, "POST", pause));
    await fake.advance(7);
    await stateOf(send(fake, "POST", play));
    await fake.advance(30);
    const first = (await body(get(fake, "/api/v2/session/frames/42"))).t as number;
    const events = eventsOf(await chunks(await get(fake, `${stream}?layers=world`), 19));
    expect(events.map((e) => Math.round(e.media_time * 1e4) / 1e4)).toEqual([0, 0, 3.6911, 4.25, 11.25, 11.75, first]);
  });

  it("marks a play, a pause, a focus and an unfocus as a viewer's change", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const set = {
      n: 1,
      session: fake.state.session,
      video: LIVE_CAMERA,
      id: 84,
      g: 21,
      t: 4.7,
      x: 0,
      y: 0,
      z: 0,
      L: 0,
      W: 0,
      yaw: 0,
    };
    const controls: [string, string, object | undefined, Partial<State>][] = [
      ["POST", pause, undefined, {}],
      ["POST", play, undefined, { playing: false }],
      ["PUT", focus, { stone_id: 84 }, {}],
      ["DELETE", focus, undefined, { focus: set }],
    ];
    for (const [method, path, payload, extra] of controls) {
      fake.appendSide("clock", { ...fake.state, changed_by: "start", ...extra }); // as at the start
      const before = fake.state.revision;
      const after = await stateOf(send(fake, method, path, payload));
      expect([after.changed_by, after.revision]).toEqual(["viewer", before + 1]);
    }
  });

  it("answers a play while playing with the state as it is", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    await fake.advance(1);
    const before = fake.state;
    expect(await stateOf(send(fake, "POST", play))).toEqual(before);
  });

  it("plans a paused camera's phases from the play and keeps a focus through them; a select clears it", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    expect((await stateOf(send(fake, "PUT", focus, { stone_id: 84 }))).focus?.id).toBe(84); // a stone of its newest world
    await body(send(fake, "POST", pause));
    await fake.advance(10);
    expect(fake.livePhase).toBe("live");
    const played = await stateOf(send(fake, "POST", play));
    await fake.advance(CONNECT_S);
    expect(fake.livePhase).toBe("warming");
    await fake.advance(3.5);
    expect(fake.state).toMatchObject({ revision: played.revision + 2, playing: true, focus: { id: 84 } });
    expect(fake.state.anchor_wall).toBeGreaterThan(played.anchor_wall + 3);
    // a select of the camera: a new session without a focus, and no world until a frame is released
    const selected = await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA }));
    expect(selected.focus).toBeNull();
    const unavailable = {
      status: 503,
      code: "world_unavailable",
      error: "the Stable sim is not running",
      retry_ms: 1000,
    };
    expect(await refusal(send(fake, "PUT", focus, { stone_id: 84 }))).toEqual(unavailable);
    expect(await refusal(get(fake, "/api/v2/session/world"))).toEqual(unavailable);
    expect(await body(get(fake, "/api/v2/session/world/events"))).toEqual({
      session: selected.session,
      video: LIVE_CAMERA,
      events: [],
      next_after: -1,
    });
  });

  it("logs the camera's world events once its frames are released, from its oldest retained frame", async () => {
    const frames = thirty().map((f) =>
      mkFrame(f.g, { events: f.g === 20 ? [{ type: "new", id: 4 }] : [], stones: [stone(4)] }),
    );
    const fake = new FakeFactory([header, ...frames], { live: true });
    const selected = await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA }));
    // the worker runs on the camera's session (the recording has no worker line)
    expect((await body(get(fake, "/api/v2/status"))).worker).toEqual({
      state: "running",
      reason: "",
      session: selected.session,
      video: LIVE_CAMERA,
    });
    await fake.advance(5);
    const log = await body(get(fake, "/api/v2/session/world/events"));
    expect(log).toMatchObject({ oldest_g: 15, next_after: 29, events: [{ g: 20, t: 4.5, type: "new", id: 4 }] });
    expect((await stateOf(send(fake, "PUT", focus, { stone_id: 4 }))).focus).toMatchObject({ id: 4, g: 29 });
  });

  it("moves its own clock on to each phase for a stream waiting for one; a stream follows a new program", async () => {
    const fake = new FakeFactory([header, ...thirty()], { live: true });
    const res = await get(fake, `${stream}?layers=world`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const next = async (): Promise<string> => dec.decode((await reader.read()).value);
    expect(await next()).toMatch(/^event: clock\n/); // the camera shown at the start: g 15..29 released
    expect(framesOf([await next()]).map((f) => f.g)).toEqual([15]);
    // a select while the stream has frames still to send: it goes on with the new program
    const since = (await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA }))).live?.since as number;
    const texts = [await next(), await next(), await next(), await next()];
    expect(eventsOf(texts).map((e) => e.live?.phase)).toEqual(["connecting", "warming", "live"]);
    const frame = framesOf(texts)[0] as Frame;
    expect([frame.g, frame.i, frame.t, frame.video]).toEqual([15, 15, 3.5, LIVE_CAMERA]);
    expect(fake.now).toBeCloseTo(since + 3.5 + LIVE_LAG_S, 6);
    await reader.cancel();
    // NDJSON carries no clock event: after a select its first line is the frame after the warm-up
    await body(send(fake, "POST", select, { video: LIVE_CAMERA }));
    const lines = await chunks(await get(fake, `${stream}?format=ndjson&layers=world&limit=1`));
    expect(lines.map((l) => (JSON.parse(l) as Frame).g)).toEqual([15]);
    // paused with phases to come, a stream waits (its clock is not moved): a play wakes it
    await body(send(fake, "POST", pause));
    await body(send(fake, "POST", select, { video: LIVE_CAMERA }));
    const held = await get(fake, `${stream}?layers=world`);
    const r2 = (held.body as ReadableStream<Uint8Array>).getReader();
    expect(dec.decode((await r2.read()).value)).toContain('"phase":"connecting"');
    const waiting = r2.read();
    await settle();
    const now = fake.now;
    await body(send(fake, "POST", play));
    expect(dec.decode((await waiting).value)).toContain('"playing":true');
    expect(dec.decode((await r2.read()).value)).toContain('"phase":"warming"');
    expect(fake.now).toBeCloseTo(now + CONNECT_S, 6);
    await r2.cancel();
  });

  it("answers a long-poll on its own clock with the phases due within its wait", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const old = (await body(get(fake, "/api/v2/session/frames/16"))).cursor as number; // of the start camera
    const since = (await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA }))).live?.since as number;
    expect(await refusal(get(fake, "/api/v2/session/frames?wait=5000"))).toEqual({
      status: 400,
      code: "invalid_param",
      error: "wait must be within 0..1000 ms",
      field: "wait",
    });
    expect(fake.livePhase).toBe("connecting"); // a refused poll takes nothing
    const phase = (reply: Json): unknown => (reply.state as State).live?.phase;
    let poll = await body(get(fake, "/api/v2/session/frames?cursor=0&layers=world&wait=0"));
    expect([phase(poll), poll.frames]).toEqual(["connecting", []]);
    poll = await body(get(fake, "/api/v2/session/frames?cursor=0&layers=world"));
    expect([phase(poll), poll.frames]).toEqual(["warming", []]); // within the default second
    expect(fake.now).toBeCloseTo(since + CONNECT_S, 6);
    await fake.advance(3);
    // a cursor of the program before: the new one's frames only
    poll = await body(get(fake, `/api/v2/session/frames?cursor=${old}&layers=world`));
    expect(phase(poll)).toBe("live");
    expect((poll.frames as Frame[]).map((f) => f.g)).toEqual([16, 17, 18, 19, 20, 21]);
    // a live camera with nothing new answers at once
    expect((await body(get(fake, `/api/v2/session/frames?cursor=${poll.cursor as number}`))).frames).toEqual([]);
  });

  it("numbers a camera's frames as the unit does: g from 0, i the same, cursors after the recording's", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const session = fake.state.session;
    const latest = await body(get(fake, "/api/v2/session/frames/latest?layers=world"));
    expect(latest).toMatchObject({ session, video: LIVE_CAMERA, g: 21, i: 21, t: 4.688311, cursor: 479 });
    expect(latest.world).toMatchObject({ session, video: LIVE_CAMERA, g: 21, t: 4.688311 });
    const first = await body(get(fake, "/api/v2/session/frames/16"));
    expect([first.t, first.cursor]).toEqual([3.6911, 474]); // after the recording's last cursor, 473
    expect(await refusal(get(fake, "/api/v2/session/frames/15"))).toEqual({
      status: 404,
      code: "not_retained",
      error: "frame 15 is not retained",
      field: "g",
      retained: { session, g0: 16, g1: 21, t0: 3.6911, t1: 4.688311, n: 6 },
    });
    // after a restart, the camera's next frames are numbered after the new boot's
    fake.injectReset("boot2");
    await body(send(fake, "POST", select, { video: LIVE_CAMERA }));
    await fake.advance(5);
    expect((await body(get(fake, "/api/v2/session/frames/16"))).cursor).toBe(7);
    // a camera's recording of several sessions: end to end, g and t go on
    const cam9 = { id: "cam9", kind: "camera", live: true, seekable: false, duration: null };
    const nine = new FakeFactory([
      { recording: "pfr1", source: cam9 },
      mkFrame(7, { session: 5, video: "cam9", t: 0 }),
      mkFrame(8, { session: 5, video: "cam9", t: 3.2 }),
      mkFrame(0, { session: 6, video: "cam9", t: 0.4 }),
    ]);
    await body(send(nine, "POST", select, { video: "cam9" }));
    const lines = await chunks(await get(nine, `${stream}?format=ndjson&layers=world&limit=2`));
    const got = lines.map((l) => JSON.parse(l) as Frame).map((f) => [f.video, f.g, f.i, f.t]);
    expect(got).toEqual([
      ["cam9", 1, 1, 3.7],
      ["cam9", 2, 2, 3.9],
    ]);
  });

  it("numbers a camera frame's raw packet and overlay as the frame", async () => {
    const fake = await FakeFactory.create({ recording: recordingPath("dry1-0296-0306-full"), live: true });
    const f = await body(get(fake, "/api/v2/session/frames/latest?layers=raw,overlay,world"));
    const raw = f.raw as Json;
    expect([f.i, raw.g, raw.i, raw.t, raw.cursor, raw.video, raw.session]).toEqual([
      f.g,
      f.g,
      f.g,
      f.t,
      f.cursor,
      LIVE_CAMERA,
      f.session,
    ]);
    expect((f.overlay as Json).prev_g).toBe((f.g as number) - 1);
    for (const at of [String(f.g), "latest"]) {
      const p = await body(get(fake, `/api/v2/raw/packets/${at}`));
      expect([p.g, p.i, p.t, p.cursor, p.video, p.session]).toEqual([f.g, f.g, f.t, f.cursor, LIVE_CAMERA, f.session]);
    }
    const [line] = await chunks(await get(fake, "/api/v2/raw/stream?format=ndjson&limit=1"));
    const p0 = JSON.parse(line as string) as Json;
    expect([p0.video, p0.session, p0.i]).toEqual([LIVE_CAMERA, f.session, p0.g]);
  });

  it("keeps the pictures of the newest 64 frames only, as the unit's worker does", async () => {
    const fake = new FakeFactory([header, ...Array.from({ length: 100 }, (_x, k) => mkFrame(k))], { live: true });
    const gs = Array.from({ length: 85 }, (_x, k) => 15 + k); // released: g 15..99
    const kept = gs[gs.length - KEEP_PICTURES] as number;
    const gone = kept - 1;
    expect((await get(fake, `/api/v2/session/frames/${kept}/image.jpg`)).headers.get("x-interp-g")).toBe(String(kept));
    expect(await refusal(get(fake, `/api/v2/session/frames/${gone}/image.jpg`))).toEqual({
      status: 404,
      code: "not_retained",
      error: `the picture of frame ${gone} is no longer kept: only the newest 64 pictures are`,
      field: "g",
    });
    expect((await body(get(fake, `/api/v2/session/frames/${gone}`))).g).toBe(gone); // the frame itself is retained
  });

  it("checks a picture in the unit's order: g, a session that has ended, a recording, the frame", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const session = fake.state.session;
    expect((await refusal(get(fake, "/api/v2/session/frames/x/image.jpg?session=1"))).field).toBe("g");
    expect(await refusal(get(fake, "/api/v2/session/frames/16/image.jpg?session=abc"))).toEqual({
      status: 400,
      code: "invalid_param",
      error: "session must be an integer",
      field: "session",
    });
    expect((await get(fake, "/api/v2/session/frames/16/image.jpg?session=")).headers.get("x-interp-g")).toBe("16");
    expect(await refusal(get(fake, "/api/v2/session/frames/15/image.jpg?session=1"))).toEqual({
      status: 410,
      code: "session_gone",
      error: "session 1 has ended",
      field: "session",
    });
    expect(await refusal(get(fake, "/api/v2/session/frames/15/image.jpg"))).toMatchObject({
      status: 404,
      code: "not_retained",
      retained: { session, g0: 16, g1: 21, n: 6 },
    });
    expect(await fault(get(fake, "/api/v2/session/frames/latest/image.jpg", { method: "POST" }))).toEqual([
      405,
      "method_not_allowed",
      undefined,
    ]);
    // a stale session is gone whatever the session shows, before a recording's 404
    await body(send(fake, "POST", select, { video: "dry1" }));
    expect((await refusal(get(fake, `/api/v2/session/frames/latest/image.jpg?session=${session}`))).status).toBe(410);
    expect(await refusal(get(fake, "/api/v2/session/frames/latest/image.jpg"))).toEqual({
      status: 404,
      code: "not_found",
      error: "dry1 is a recording: its picture is the proxy video",
      field: "g",
    });
  });

  it("leaves the camera for a recording a seek names: held for its hold, at the rate recordings play at", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const selected = await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA })); // connecting
    const s = await stateOf(send(fake, "POST", seek, { video: "dry1", time: 82 }));
    expect(s).toMatchObject({
      session: selected.session + 1,
      revision: selected.revision + 1,
      video: "dry1",
      playing: true,
      rate: 0.8,
      anchor_media: 82,
      duration: 1807.157567,
      changed_by: "viewer",
      focus: null,
      media_time: 82,
    });
    expect("live" in s).toBe(false);
    expect(s.hold_until - s.anchor_wall).toBeCloseTo(2.2, 6);
    expect(fake.livePhase).toBe("");
    await fake.advance(1);
    expect(fake.state.media_time).toBe(82); // held
    await fake.advance(2);
    expect(fake.state.media_time).toBeCloseTo(82 + 0.8 * 0.8, 6);
    await fake.advance(5); // nothing of the camera is left to come
    expect([fake.state.video, fake.livePhase]).toEqual(["dry1", ""]);
    expect((await refusal(get(fake, "/api/v2/session/frames/latest/image.jpg"))).code).toBe("not_found");
    expect((await get(fake, "/api/v2/videos/dry1/media")).status).toBe(200);
    // recordings play at the last clock line's rate (0.8 when the fake starts on a camera), after a camera too
    const camera: VideoEntry = { ...entry("CAM9", { duration: null, frames: null }), kind: "camera", live: true };
    const started = {
      sse: "clock",
      data: { ...fake.state, session: 1, video: "dry1", rate: 1, duration: 60, server_now: 100 },
    };
    const rated = new FakeFactory([header, started, mkFrame(1)], {
      replies: { listVideos: { body: { schema: "stone-interpreter-catalog-v1", videos: [entry("dry1"), camera] } } },
    });
    await body(send(rated, "POST", select, { video: "CAM9" }));
    expect((await stateOf(send(rated, "POST", select, { video: "dry1" }))).rate).toBe(1);
  });

  it("sizes its camera like the recording: the grid's fps (5.0 without one) and the picture sizes", async () => {
    const cameraOf = async (fake: FakeFactory): Promise<VideoEntry> =>
      ((await body(get(fake, "/api/v2/videos"))).videos as VideoEntry[]).at(-1) as VideoEntry;
    const fromHeader = new FakeFactory([header, mkFrame(1)], { live: true });
    const camera = await cameraOf(fromHeader);
    expect(camera).toEqual({
      id: LIVE_CAMERA,
      title: "Live camera",
      subtitle: "The recording, replayed as a live camera",
      kind: "camera",
      live: true,
      seekable: false,
      duration: null,
      frames: null,
      default_start: null,
      fps: 5, // 10 over a grid step of 2
      grid_step: 1,
      hold: 3,
      proxy: "",
      proxy_wh: [960, 540],
      native_wh: [1280, 720],
      held_out: [],
      station: "FakeFactory",
    });
    expect(await body(get(fromHeader, `/api/v2/videos/${LIVE_CAMERA}`))).toEqual(camera);
    const listing = (videos: object[]): FakeFactory =>
      new FakeFactory([], {
        live: true,
        replies: { listVideos: { body: { schema: "stone-interpreter-catalog-v1", videos } } },
      });
    expect((await cameraOf(listing([{ ...entry("a"), grid_step: undefined }]))).fps).toBe(10);
    expect((await cameraOf(listing([entry("a", { fps: 0 })]))).fps).toBe(5);
    expect(await cameraOf(new FakeFactory([], { live: true }))).toMatchObject({
      fps: 5,
      proxy_wh: [960, 540],
      native_wh: [1920, 1080],
    });
  });

  it("keeps the recording as the catalog's default, whatever the session shows", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true });
    const first = await get(fake, "/api/v2/videos");
    const etag = first.headers.get("etag") as string;
    expect(((await first.json()) as Json).default_video).toBe("dry1");
    await body(send(fake, "POST", select, { video: LIVE_CAMERA }));
    await body(send(fake, "POST", select, { video: "aug28" }));
    expect((await get(fake, "/api/v2/videos", { headers: { "If-None-Match": etag } })).status).toBe(304);
    // without a recording: the recorded default, else the first entry
    const listVideos = (defaultVideo?: string): FakeReply => ({
      body: { schema: "stone-interpreter-catalog-v1", videos: [entry("a"), entry("b")], default_video: defaultVideo },
    });
    const defaultOf = async (reply: FakeReply): Promise<unknown> =>
      (await body(get(new FakeFactory([], { replies: { listVideos: reply } }), "/api/v2/videos"))).default_video;
    expect(await defaultOf(listVideos("b"))).toBe("b");
    expect(await defaultOf(listVideos())).toBe("a");
  });

  it("drops a camera's phases still to come when another viewer's clock event leaves its session", async () => {
    const fake = new FakeFactory([header, ...thirty()], { live: true });
    await body(send(fake, "POST", select, { video: LIVE_CAMERA }));
    // the same camera session (another viewer's focus, say): its phases stay
    fake.appendSide("clock", { ...fake.state, changed_by: "viewer" });
    await fake.advance(CONNECT_S);
    expect(fake.livePhase).toBe("warming");
    // a recording: nothing of the camera is left to come
    const { live: _live, ...recording } = fake.state;
    fake.appendSide("clock", { ...recording, video: "dry1", rate: 0.8, duration: 60 });
    await fake.advance(10);
    expect([fake.state.video, fake.livePhase]).toEqual(["dry1", ""]);
    expect((await refusal(get(fake, "/api/v2/session/frames/latest"))).code).toBe("not_retained");
    // another camera session too
    await body(send(fake, "POST", select, { video: LIVE_CAMERA }));
    fake.appendSide("clock", { ...fake.state, session: fake.state.session + 1 });
    await fake.advance(10);
    expect(fake.livePhase).toBe("connecting");
  });

  it("counts every open stream in its status, observers too, and no long-polls", async () => {
    const fake = new FakeFactory([header, mkFrame(1)]);
    const res = await get(fake, `${stream}?observe=1`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const status = await body(get(fake, "/api/v2/status"));
    expect([status.viewers, status.streams, status.long_polls]).toEqual([0, 1, 0]);
    await reader.cancel();
    expect((await body(get(fake, "/api/v2/status"))).streams).toBe(0);
  });

  it("lists a recording without a header source as the unit shapes its recordings, and seeks in it", async () => {
    const fake = new FakeFactory([mkFrame(1, { video: "v" }), mkFrame(2, { video: "v" })]);
    expect(await body(get(fake, "/api/v2/videos"))).toEqual({
      schema: "stone-interpreter-catalog-v1",
      title: "Stone-work interpreter",
      default_video: "v",
      videos: [
        {
          id: "v",
          title: "v",
          duration: null,
          fps: 10,
          frames: null,
          grid_step: 2,
          default_start: 0,
          hold: 2.2,
          proxy: "/api/v2/videos/v/media",
          proxy_wh: [960, 540],
          native_wh: [1920, 1080],
        },
      ],
    });
    expect(await stateOf(send(fake, "POST", seek, { time: 5 }))).toMatchObject({ video: "v", anchor_media: 5 });
    const live = new FakeFactory([mkFrame(1, { video: "v" })], { live: true });
    const camera = ((await body(get(live, "/api/v2/videos"))).videos as VideoEntry[]).at(-1);
    expect([camera?.fps, camera?.proxy_wh]).toEqual([5, [960, 540]]);
  });

  it("answers a camera session from its own frames, never from recorded replies", async () => {
    const fake = await fixtureFake("joined-mid-move", { live: true }); // with the fixtures' replies directory
    await body(send(fake, "POST", select, { video: LIVE_CAMERA }));
    expect((await refusal(get(fake, "/api/v2/session/frames/latest"))).error).toBe("no frame is retained yet");
    expect((await refusal(get(fake, "/api/v2/session/world"))).status).toBe(503);
    expect((await body(get(fake, "/api/v2/session/world/events"))).events).toEqual([]);
    expect(await body(get(fake, "/api/v2/session/focus"))).toEqual({ focus: null, resolved: null });
    expect((await refusal(get(fake, "/api/v2/raw/packets/latest"))).code).toBe("not_retained");
    expect((await refusal(get(fake, "/api/v2/session/world/stones/5"))).code).toBe("unknown_stone");
    // a fake of the camera alone: live from the start, without a frame
    const only = new FakeFactory([], { live: true });
    expect(only.livePhase).toBe("live");
    expect(await refusal(get(only, "/api/v2/session/frames/latest/image.jpg"))).toMatchObject({
      status: 404,
      code: "not_retained",
      error: "no frame is retained yet",
    });
  });

  it("moves its clock with advance(): its own, or a ManualClock you gave it", async () => {
    await expect(new FakeFactory([], { clock: new InstantClock() }).advance(1)).rejects.toThrow(
      "advance() moves a ManualClock: this fake follows the clock it was given",
    );
    const manual = new ManualClock(1_000);
    const fake = new FakeFactory([header, ...thirty()], { live: true, clock: manual });
    await body(send(fake, "POST", select, { video: LIVE_CAMERA }));
    await fake.advance(CONNECT_S);
    expect([manual.now(), fake.now, fake.livePhase]).toEqual([1_500, 1.5, "warming"]);
  });

  it("takes the due phases in fake.state and fake.livePhase, with no request in between", async () => {
    const manual = new ManualClock(1_000);
    const fake = new FakeFactory([header, ...thirty()], { live: true, clock: manual });
    await stateOf(send(fake, "POST", select, { video: LIVE_CAMERA }));
    await manual.advance(CONNECT_S * 1000); // the clock alone: no request, no stream, no fake.advance()
    expect(fake.state.live?.phase).toBe("warming");
    await manual.advance(3_500);
    expect(fake.livePhase).toBe("live");
  });
});
