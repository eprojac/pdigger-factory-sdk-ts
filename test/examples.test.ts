/**
 * Runs every example of examples/ against the fake (no network: the global fetch is the fake's), and checks what it
 * prints. The README and docs show these files' regions (see docs.test.ts), so every code sample there runs here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Replay, systemClock, type Clock, type TrayReport, type VideoList } from "pdigger-factory-sdk";
import type { FakeFactory } from "pdigger-factory-sdk/testing";
import { fixtureFake } from "./helpers/fake.js";
import { readJson, readText, recordingPath } from "./helpers/fixtures.js";

const lines = (rel: string): string[] =>
  readText(rel)
    .split("\n")
    .filter((l) => l !== "");

class Enough extends Error {}

/** Captures console.log; after `max` lines it throws, which ends an endless loop of an example. */
function capture(max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
    if (out.length >= max) throw new Enough(`printed ${max} lines`);
  });
  return out;
}

/** The real clock, `speed` times faster: a fake camera connects and warms up in a few real milliseconds. */
function fastClock(speed: number): Clock {
  const t0 = Date.now();
  return { now: () => t0 + (Date.now() - t0) * speed, sleep: (ms, signal) => systemClock.sleep(ms / speed, signal) };
}

function useFake(fake: FakeFactory): void {
  vi.stubGlobal("fetch", fake.fetch);
  vi.stubEnv("PDIGGER_FACTORY_URL", "http://fake.factory");
}

function noNetwork(): void {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in unit tests")));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("examples", () => {
  it("quickstart follows the shared session and prints its events", async () => {
    const fake = await fixtureFake("dry1-0000-0130");
    useFake(fake);
    const out = capture(13);
    await expect(import("../examples/quickstart.js")).rejects.toThrow(Enough);
    expect(out[0]).toBe("following dry1, session 1795314878");
    expect(out.slice(1)).toEqual(lines("golden/dry1-0000-0130.events.txt").slice(0, 12));
    await vi.waitFor(() => expect(fake.streams).toBe(0));
    fake.close();
  });

  it("replay prints the events, activities and summary of a recording", async () => {
    noNetwork();
    const argv = process.argv;
    process.argv = [argv[0] as string, "examples/replay.ts", recordingPath("dry1-0000-0130")];
    const out = capture();
    try {
      await import("../examples/replay.js");
    } finally {
      process.argv = argv;
    }
    expect(out[0]).toBe("dry1-0000-0130: 632 frames of dry1");
    const body = out.slice(1, -1);
    expect(body.filter((l) => !l.startsWith("  -> "))).toEqual(lines("golden/dry1-0000-0130.events.txt"));
    expect(body.filter((l) => l.startsWith("  -> ")).map((l) => l.slice(5))).toEqual(
      lines("golden/dry1-0000-0130.activities.txt"),
    );
    expect(out.at(-1)).toBe(readText("golden/dry1-0000-0130.summary.txt"));
  });

  it("tutorial-high-level replays a recording: activities, moves, tray facts, trays, the summary, a path", async () => {
    noNetwork();
    const argv = process.argv;
    process.argv = [argv[0] as string, "examples/tutorial-high-level.ts", recordingPath("dry1-0018-0153")];
    const out = capture();
    try {
      await import("../examples/tutorial-high-level.js");
    } finally {
      process.argv = argv;
    }
    const moves = [
      "0:36.3 stone 117: right hand, placed, 0.2 s",
      "0:50.5 stone 128: left hand, dropped, 0.2 s",
      "1:09.2 stone 102: right hand, placed, 6.0 s",
      "1:18.8 stone 95: right hand, placed, 1.0 s",
      "1:19.2 stone 155: left hand, carried_away, 1.0 s",
      "1:25.6 stone 106: right hand, carried_away, 2.6 s",
      "1:30.3 stone 94: right hand, placed, 0.2 s",
      "2:01.3 stone 250: left hand, dropped, 1.6 s",
      "2:07.8 stone 102: right hand, placed, 0.2 s",
    ];
    expect(out).toEqual([
      ...lines("golden/dry1-0018-0153.activities.txt"),
      ...moves,
      ...lines("golden/dry1-0018-0153.trays.txt"),
      "tray 1: 0:22.5 to 2:24.0, 6 stones removed for certain",
      readText("golden/dry1-0018-0153.summary.txt"), // describe() ends with its line break
      "stone 155: 5 points from 1:15.6 to 1:19.8",
    ]);
  });

  it("quickstart-reports prints one report per tray of a recording, and follows a unit with --follow", async () => {
    noNetwork();
    const argv = process.argv;
    process.argv = [argv[0] as string, "examples/quickstart-reports.ts", recordingPath("dry1-0018-0153")];
    const out = capture();
    try {
      await import("../examples/quickstart-reports.js");
    } finally {
      process.argv = argv;
    }
    expect(out.map((r) => `${r}\n`).join("")).toBe(readText("golden/dry1-0018-0153.reports.txt"));

    vi.resetModules();
    const fake = await fixtureFake("dry1-0000-0130");
    useFake(fake);
    process.argv = [argv[0] as string, "examples/quickstart-reports.ts", "--follow"];
    const live = capture(1); // tray 1 leaves when tray 2 arrives
    try {
      await expect(import("../examples/quickstart-reports.js")).rejects.toThrow(Enough);
    } finally {
      process.argv = argv;
    }
    expect(`${live[0]}\n`).toBe(readText("golden/dry1-0000-0130.reports.txt").split(/\n(?=tray )/)[0] + "\n");
    await vi.waitFor(() => expect(fake.streams).toBe(0));
    fake.close();
  });

  it("tutorial-reports replays a recording: its reports, the same as rows, the facts behind one not complete", async () => {
    noNetwork();
    const argv = process.argv;
    process.argv = [argv[0] as string, "examples/tutorial-reports.ts", recordingPath("dry1-0018-0153")];
    const out = capture();
    try {
      await import("../examples/tutorial-reports.js");
    } finally {
      process.argv = argv;
    }
    // what the other languages' tutorial programs print: the golden report, its row as JSON (the changes at least 0.9
    // likely to be right, and every move) and, since the report is not complete, the tray's golden facts
    const reports = readText("golden/dry1-0018-0153.reports.txt");
    expect(`${out[0]}\n`).toBe(reports);
    expect(out.slice(2)).toEqual(lines("golden/dry1-0018-0153.trays.txt"));
    const [report, ...more] = await (await Replay.open(recordingPath("dry1-0018-0153"))).trayReports();
    const { arrived, left } = report as TrayReport;
    expect([more.length, typeof arrived.wall, typeof left.wall]).toEqual([0, "number", "number"]);
    expect(arrived.wall).toBeCloseTo(1795315127.04, 1);
    const arrival = (...ns: number[]): string[] => ns.map((n) => `20261122T023847.0Z-1-${n}`);
    expect(JSON.parse(out[1] as string)).toEqual({
      tray: 1,
      arrived: arrived.wall,
      left: left.wall,
      removed: arrival(117, 127, 126, 105, 112, 125), // 0.98 each
      added: [
        // 0.96 each; 151, 246, 249 and 278 are 0.52
        "20261122T024104.0Z-1-177",
        "20261122T024018.8Z-1-193",
        "20261122T024029.7Z-1-201",
        "20261122T024031.0Z-1-203",
        "20261122T024118.1Z-1-279",
        "20261122T024121.3Z-1-280",
        "20261122T024121.3Z-1-281",
        "20261122T024124.2Z-1-282",
        "20261122T024126.9Z-1-284",
      ],
      moved: arrival(85, 86, 88, 89, 90, 104, 118, 120), // 0.87 each, every move kept
      unclear: 18,
      complete: false,
    });
  });

  it("tray-points lists the trays of a recording and seeks to one tray's points as dry runs", async () => {
    const fake = await fixtureFake("dry1-0018-0153");
    useFake(fake);
    const before = (await fake.client().session.state()).session;
    const argv = process.argv;
    process.argv = [argv[0] as string, "examples/tray-points.ts", recordingPath("dry1-0018-0153"), "1"];
    const out = capture();
    try {
      await import("../examples/tray-points.js");
    } finally {
      process.argv = argv;
    }
    const removed = [105, 112, 117, 125, 126, 127].map((id) => `  removed: 20261122T023847.0Z-1-${id}`);
    expect(out).toEqual([
      "tray 1: arrived 0:22.5, leaving 2:24.0", // the excerpt's one tray
      ...removed,
      "seek to 0:22.5 would show dry1 from 0:22.5",
      "seek to 2:24.0 would show dry1 from 2:24.0",
    ]);
    expect((await fake.client().session.state()).session).toBe(before); // dry runs: the session did not change
    fake.close();
  });

  it("levels reads the high, mid and low levels", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full");
    useFake(fake);
    const out = capture();
    await import("../examples/levels.js");
    expect(out).toMatchInlineSnapshot(`
      [
        "high: 5:01.6 Right hand lifts stone 643",
        "high: left hand touch, right hand carry, 42 stones",
        "mid: frame 1480: 41 stones, 40 detections",
        "low: frame 1530: tray covers 891 of 2560 cells",
        "low: scene 3079: 42 stones, surface of 4914 triangles",
      ]
    `);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
    await vi.waitFor(() => expect(fake.streams).toBe(0));
    fake.close();
  });

  it("tutorial-low-level makes one call per operation, reading and sending a dry run only", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full");
    useFake(fake);
    const argv = process.argv;
    process.argv = [argv[0] as string, "examples/tutorial-low-level.ts", "1510"];
    const out = capture();
    try {
      await import("../examples/tutorial-low-level.js");
    } finally {
      process.argv = argv;
    }
    expect(out).toEqual([
      // the unit's recorded status: its worker was idle (nobody was watching) when the replies were recorded
      "ready true, worker idle: 3.8 frames a second, 241.6 ms each",
      "checkpoint 8d09531c915f on trt: 6 engines",
      "70 joints, 62 bones, 11 colours",
      "stone 627: 51 points, g 1480 to 1530",
      "focus on stone 627: dry run true",
      "frame g 1510 at 5:01.2: 42 stones, rect",
      "maps of g 1510: 40 x 64 cells, 920 of the tray, 1169 of stones",
      // the fake does not draw: the draw lists are the unit's recorded ones, of dry2's frame 3079
      "overlay of g 3079: 44 polygons, 7 segments, 8 circles at 1920 x 1080 px",
      "scene of g 3079: 42 stones, 7 bones",
      "g 1510: 42 outlines, 168 points",
      "g 1510: 50 of 62 bones",
      "left hand: Hand on a stone, wrist at 1528, 595 px",
      "right hand: Holding a stone, wrist at 1270, 415 px",
      // the PNG is the unit's recorded one too (of dry2's frame 3079)
      "regions of g 1510: a 1106-byte PNG",
      "picture: /api/v2/videos/dry1/media at 5:01.2, 960 x 540",
    ]);
    const changes = fake.requests.filter((r) => r.method !== "GET");
    expect(changes.map((r) => [r.method, r.path, r.query.get("dry_run")])).toEqual([
      ["PUT", "/api/v2/session/focus", "1"],
    ]);
    fake.close();
  });

  it("errors shows the error codes, on a unit that lists cameras and on one that lists recordings only", async () => {
    const fake = await fixtureFake("dry2-0582-0600");
    useFake(fake);
    const out = capture();
    await import("../examples/errors.js");
    expect(out).toMatchInlineSnapshot(`
      [
        "frame 0 is gone: the unit keeps frames 2918 to 3009",
        "live camera: Plant A · camera 1",
        "404 unknown_video (field id): Unknown video 'no-such-video'; retryable: false",
      ]
    `);

    // the catalog's recordings without its cameras: live() rejects with live_unavailable
    vi.resetModules();
    const catalog = readJson<VideoList>("api/listVideos.json");
    fake.failNext("listVideos", 1, { body: { ...catalog, videos: catalog.videos.filter((v) => v.kind !== "camera") } });
    const none = capture();
    await import("../examples/errors.js");
    expect(none).toMatchInlineSnapshot(`
      [
        "frame 0 is gone: the unit keeps frames 2918 to 3009",
        "this unit lists no camera: the shared session plays recordings",
        "404 unknown_video (field id): Unknown video 'no-such-video'; retryable: false",
      ]
    `);
    expect(fake.requests.filter((r) => r.operationId === "listVideos")).toHaveLength(2);
  });

  it("sources lists the sources, the live camera and the session clock", async () => {
    const fake = await fixtureFake("dry1-0000-0130", { live: true });
    useFake(fake);
    const out = capture();
    await import("../examples/sources.js");
    // the unit's catalog: its four recordings, then its six plant cameras; the fake's own camera after them
    expect(out.slice(0, 12)).toMatchInlineSnapshot(`
      [
        "aug28: Line A · 28 Aug (recording, 3712 s, seekable: true)",
        "jul30: Line A · 30 Jul (recording, 4718 s, seekable: true)",
        "dry1: Dry side · 1 (recording, 1807 s, seekable: true)",
        "dry2: Dry side · 2 (recording, 1792 s, seekable: true)",
        "CAM00000001: Plant A · camera 1 (camera, live, seekable: false)",
        "CAM00000002: Plant A · camera 2 (camera, live, seekable: false)",
        "CAM00000003: Plant B · camera 1 (camera, live, seekable: false)",
        "CAM00000004: Plant B · camera 2 (camera, live, seekable: false)",
        "CAM00000005: Plant C · camera 1 (camera, live, seekable: false)",
        "CAM00000006: Plant C · camera 2 (camera, live, seekable: false)",
        "cam-live: Live camera (camera, live, seekable: false)",
        "live camera: Plant A · camera 1 (Plant A)",
      ]
    `);
    expect(out[12]).toMatch(/^the session plays cam-live, now at \d+\.\d s of media \(live: true\)$/);
    expect(out[13]).toMatch(/^that moment on this machine's clock: \d{4}-\d\d-\d\dT/);
    expect(out[14]).toMatch(/^watching CAM00000001 would start session \d+ at 0\.0 s$/);
    expect(out).toHaveLength(15);
    const controls = fake.requests.filter((r) => r.method !== "GET");
    expect(controls.map((r) => [r.operationId, r.query.get("dry_run")])).toEqual([["sessionSelect", "1"]]);
  });

  it("live-camera watches a camera: through its warm-up to live, its picture, then its events", async () => {
    const fake = await fixtureFake("dry1-0000-0130", { live: true, clock: fastClock(40) });
    useFake(fake);
    const argv = process.argv;
    process.argv = [argv[0] as string, "examples/live-camera.ts"];
    const out = capture(6);
    try {
      await expect(import("../examples/live-camera.js")).rejects.toThrow(Enough);
    } finally {
      process.argv = argv;
    }
    const session = fake.state.session;
    // the first camera of the unit's catalog, which the fake runs as a camera too
    expect(out[0]).toBe(`CAM00000001 (Plant A · camera 1) is live: session ${session}, 0.25 s behind the camera`);
    expect(out[1]).toMatch(/^frame g \d+: a \d+-byte JPEG$/);
    for (const line of out.slice(2)) expect(line).toMatch(/^\d\d:\d\d:\d\d UTC {2}\d+:\d\d\.\d \S/);
    expect(fake.requests.filter((r) => r.operationId === "sessionSelect")).toHaveLength(1);
    await vi.waitFor(() => expect(fake.streams).toBe(0));
    fake.close();
  });

  it("interpreter prints activities, hands and the summary, then waits for events", async () => {
    const fake = await fixtureFake("dry1-0000-0130");
    useFake(fake);
    const out = capture();
    await import("../examples/interpreter.js");
    const golden = lines("golden/dry1-0000-0130.activities.txt");
    const acts = out.filter((l) => /^\d+:\d\d\.\d /.test(l));
    expect(acts.slice(0, -2)).toEqual(golden.slice(0, acts.length - 2));
    expect(out.filter((l) => !/^\d+:\d\d\.\d /.test(l) && !l.startsWith("  stone"))).toMatchInlineSnapshot(`
      [
        "hands now: left touch (Hand on a stone), right grasp (Holding a stone)",
        "frames: 600 (with world 600, without 0, revisions 0)
      media: 2:03.3, sessions 1, gaps 1
      stones: last 38, max 49, confirmed 38
      moves: 8 (placed 4, dropped 2, carried away 2, removed 0, interrupted 0, partial 0, carried 6), mean 1.6 s, 0.22 units
      push bursts: 47 (left 23, right 14, both 10), pushes 386
      events: new 270, confirm 116, freeze 96, push 506, lift 8, hinge 3, carry 6, place 4, drop 2, gone 2, delete 75, split 2, other 0
      trays: 2 (arrived 2), stones at arrival 83, added 0 (+1 unclear), removed 6 (+0 unclear), not sure 18
      left hand: free 0:51.0, touch 0:49.4, grasp 0:16.8, hinge 0:00.4, carry 0:02.4
      right hand: free 1:05.0, touch 0:08.2, grasp 0:36.8, hinge 0:00.4, carry 0:09.6
      ",
      ]
    `);
    expect(out.slice(-2)).toMatchInlineSnapshot(`
      [
        "0:36.3 Right hand lifts stone 117 (stone 117, 2026-11-22T02:39:05.402Z)",
        "0:36.5 Right hand places stone 117",
      ]
    `);
  });

  it("streams reads frames, the long-poll and raw packets", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full");
    useFake(fake);
    const out = capture();
    await import("../examples/streams.js");
    expect(out).toMatchInlineSnapshot(`
      [
        "clock: dry1 session 1795314878, rate 0.75",
        "frame 1480 [fakeboot01-1533]: 0 events",
        "frame 1481 [fakeboot01-1534]: 0 events",
        "frame 1482 [fakeboot01-1535]: 1 events",
        "polled frame 1480, cursor 1533",
        "polled frame 1481, cursor 1534",
        "polled frame 1482, cursor 1535",
        "packet of frame 1480: 40 stone detections",
      ]
    `);
    await vi.waitFor(() => expect(fake.streams).toBe(0));
  });

  it("replay-sync iterates in memory and paces in real time (on fake timers)", async () => {
    noNetwork();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const out = capture();
    const run = import("../examples/replay-sync.js");
    let done = false;
    void run.finally(() => (done = true)).catch(() => undefined);
    // the pacing sleeps on the faked setTimeout: move fake time on until the example has printed everything
    while (!done) await vi.advanceTimersByTimeAsync(50);
    await run;
    vi.useRealTimers();
    expect(out.slice(0, 5)).toEqual(lines("golden/joined-mid-move.activities.txt"));
    expect(out.slice(5)).toMatchInlineSnapshot(`
      [
        "{"total":2,"placed":1,"dropped":0,"carried_away":1,"removed":0,"interrupted":0,"partial":2,"carried":0,"mean_duration":null,"mean_distance":null}",
        "22 frames with a world in 2.1 s",
      ]
    `);
  });

  it("viz-node follows a unit with a SceneView in Node", async () => {
    const fake = await fixtureFake("dry1-0000-0130");
    useFake(fake);
    const out = capture();
    await import("../examples/viz-node.js");
    expect(out.slice(0, -1)).toEqual(lines("golden/dry1-0000-0130.activities.txt").slice(0, out.length - 1));
    expect(out.at(-1)).toBe("37 stones in the scene graph after 250 frames");
    await vi.waitFor(() => expect(fake.streams).toBe(0));
  });

  it("testing runs an Interpreter on the fake", async () => {
    noNetwork();
    const out = capture();
    await import("../examples/testing.js");
    expect(out).toEqual([
      lines("golden/dry1-0000-0130.events.txt").find((l) => l.includes("lifts")),
      expect.stringMatching(/^world at frame 650 after 2 requests$/),
      "cam-live is live, 0.25 s behind the camera",
      expect.stringMatching(/^frame \d+ has a \d+-byte picture$/),
    ]);
  });
});
