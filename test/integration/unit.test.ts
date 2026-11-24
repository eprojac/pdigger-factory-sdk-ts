/**
 * Opt-in, read-only checks against a unit: PDIGGER_FACTORY_URL=http://<unit>:8120 npm run test:integration.
 * Streams are `observe` streams (they do not count as viewers) and every control is a `dryRun` (validated, not applied):
 * nothing here moves the shared session.
 */
import { describe, expect, it } from "vitest";
import {
  FactoryClient,
  codec,
  isFactoryError,
  type FetchLike,
  type FrameItem,
  type StreamItem,
} from "pdigger-factory-sdk";

const url = process.env.PDIGGER_FACTORY_URL?.trim() || undefined;
/** How long a stream check waits for its frames: an idle unit (nobody is watching; these checks never count as viewers)
 * sends none. */
const IDLE_MS = 20_000;
/** What a unit with no frame to give answers (an idle worker): no retained frame, no world. */
const NO_FRAMES = ["not_retained", "not_ready", "world_unavailable"] as const;

/** The checks' fetch: it refuses any request that could change the unit, a method other than GET or HEAD without
 * `dry_run=1` (as Python's ReadOnly transport does), so a slip in these checks cannot move the shared session. */
const readOnly: FetchLike = (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const target = input instanceof Request ? input.url : String(input);
  if (method !== "GET" && method !== "HEAD" && new URL(target).searchParams.get("dry_run") !== "1") {
    return Promise.reject(new Error(`read-only checks: refused ${method} ${target} without dry_run=1`));
  }
  return fetch(input, init);
};

async function take<T>(it: AsyncIterable<T>, n: number, keep: (x: T) => boolean = () => true): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    if (keep(x)) out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

/** The first `n` items that `open` gives within IDLE_MS, or null when they do not all come (the worker is idle). */
async function within<T>(
  open: (signal: AbortSignal) => AsyncIterable<T>,
  n: number,
  keep?: (x: T) => boolean,
): Promise<T[] | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), IDLE_MS);
  try {
    const got = await take(open(stop.signal), n, keep);
    return got.length >= n ? got : null;
  } catch (err) {
    if (stop.signal.aborted) return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The result of `call`, or null when the unit has no frame or world to give (an idle worker). */
async function unlessIdle<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (err) {
    if (NO_FRAMES.some((code) => isFactoryError(err, code))) return null;
    throw err;
  }
}

describe.skipIf(!url)(`the unit at ${url ?? "(PDIGGER_FACTORY_URL not set)"}, read-only`, () => {
  const factory = new FactoryClient(url ?? "http://unset.invalid", { observe: true, fetch: readOnly });

  it("answers the meta operations", async () => {
    const root = await factory.api.getApiRoot();
    expect(root.api).toMatch(/^2\./);
    expect((await factory.api.getOpenApi()).startsWith("openapi:")).toBe(true);
    expect(typeof (await factory.api.getModel()).checkpoint).toBe("string");
    const topology = await factory.api.getTopology();
    expect(codec.bonesOf(topology).length).toBeGreaterThan(0);
    expect(typeof (await factory.api.getHealth()).ok).toBe("boolean");
    expect(typeof (await factory.api.getReady()).ready).toBe("boolean");
    expect((await factory.api.getStatus()).boot).toBeTruthy();
    expect((await factory.api.getMetrics()).samples.length).toBeGreaterThan(0);
  });

  it("lists the sources, with the live camera when the unit has one", async () => {
    const sources = await factory.sources();
    expect(sources.length).toBeGreaterThan(0);
    try {
      const live = await factory.live();
      expect(live.isLive).toBe(true);
      expect(live.duration).toBeNull();
    } catch (err) {
      expect(isFactoryError(err, "live_unavailable")).toBe(true);
    }
    const first = sources[0]!;
    expect((await factory.source(first.id)).id).toBe(first.id);
    const head = await factory.api.headVideoMedia(first.id);
    expect(head.status).toBe(200);
  });

  it("reads the session and its clock", async () => {
    const clock = await factory.session.clock({ samples: 3 });
    expect(clock.state.session).toBeGreaterThan(0);
    expect(Number.isFinite(clock.mediaTimeNow())).toBe(true);
  });

  it("streams frames as an observer, and interprets them", async (ctx) => {
    const items = await within(
      (signal) => factory.streams.frames({ layers: ["world", "cards"], observe: true, signal }),
      5,
      (i: StreamItem) => i.kind === "frame",
    );
    if (items === null) return ctx.skip(); // no frames: nobody is watching, so the worker is idle
    const frames = (items as FrameItem[]).map((i) => i.frame);
    expect(frames.every((f, k) => k === 0 || f.cursor > frames[k - 1]!.cursor)).toBe(true);
    const interpreter = factory.interpreter({ observe: true });
    const updates = await within((signal) => interpreter.updates({ signal }), 5);
    interpreter.close();
    if (updates === null) return ctx.skip();
    expect(updates.every((u) => u.state.session !== null)).toBe(true);
  });

  it("long-polls, and reads frames, the world, events, stones and renders", async () => {
    const reply = await factory.api.pollFrames({ layers: ["world"], limit: 4, wait: 1000 });
    expect(reply.cursor).toBeGreaterThanOrEqual(0);
    const world = await unlessIdle(factory.api.getWorld());
    if (world !== null) {
      expect(Array.isArray((await factory.api.getWorldEvents({ limit: 8 })).events)).toBe(true);
      if (world.stones[0]) expect((await factory.api.getStone(world.stones[0].id)).id).toBe(world.stones[0].id);
    }
    const frame = await unlessIdle(factory.api.getFrame("latest", { layers: ["world", "overlay"] }));
    if (frame === null) return; // no retained frame: the unit's worker is idle
    if (world !== null) expect(world.session).toBe(frame.session);
    // each read below may come after the frame left the retained window
    const overlay = await unlessIdle(factory.api.renderOverlay2d({ g: frame.g, draw: "primitives" }));
    if (overlay !== null) expect(overlay.g).toBe(frame.g);
    const scene = await unlessIdle(factory.api.renderScene3d({ g: frame.g, surface: "compact" }));
    if (scene !== null) expect(scene.g).toBe(frame.g);
    const png = await unlessIdle(factory.api.getFrameRaster(frame.g, "regions", { scale: 2 }));
    if (png !== null) expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  });

  it("validates controls without applying them (dry_run=1)", async () => {
    const before = await factory.session.state();
    const paused = await factory.session.pause({ dryRun: true });
    expect(paused.playing).toBe(false);
    const watched = await factory.session.watch(before.video, { dryRun: true });
    expect(watched.video).toBe(before.video);
    const world = await unlessIdle(factory.api.getWorld()); // an idle unit has no world, so no stone to focus
    if (world?.stones[0]) {
      const focused = await factory.api.putFocus(world.stones[0].id, { dryRun: true });
      expect(focused.dry_run).toBe(true);
    }
    expect((await factory.api.deleteFocus({ dryRun: true })).dry_run).toBe(true);
    const after = await factory.session.state();
    if (after.session !== before.session || after.playing !== before.playing) {
      // only dry runs were sent: another viewer, or the unit's own end of a recording, moved the shared session
      console.warn(`another client moved the session: ${before.session} -> ${after.session} (${after.changed_by})`);
    }
  });

  it("dry-runs watching a camera, and serves pictures only while the session shows one", async (ctx) => {
    const cameras = await factory.cameras();
    if (cameras.length === 0) return ctx.skip(); // a unit without cameras
    const camera = cameras[0]!;
    expect(camera).toMatchObject({ kind: "camera", isLive: true, seekable: false, duration: null });
    const would = await factory.session.watch(camera, { dryRun: true });
    expect(would).toMatchObject({ video: camera.id, rate: 1, duration: null, media_time: 0 });
    expect(would.live?.phase).toBe("connecting");
    const timed = await factory.session.watch(camera, { at: 1, dryRun: true }).catch((err: unknown) => err);
    expect(isFactoryError(timed, "not_seekable")).toBe(true);
    const state = await factory.session.state();
    if (state.live) {
      const picture = await unlessIdle(factory.session.picture("latest", { session: state.session }));
      if (picture !== null) expect([...picture.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    } else {
      const err = await factory.session.picture().catch((e: unknown) => e);
      expect(isFactoryError(err, "not_found")).toBe(true); // a recording's picture is its proxy video
    }
    const now = await factory.session.state();
    if (now.session !== state.session) {
      console.warn(`another client moved the session: ${state.session} -> ${now.session} (${now.changed_by})`);
    }
  });
});
