// @vitest-environment happy-dom
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  Replay,
  codec,
  type Frame,
  type Overlay2D,
  type Scene3D,
  type Update,
  type VideoEntry,
} from "pdigger-factory-sdk";
import { TOPOLOGY, settle } from "pdigger-factory-sdk/testing";
import {
  DEFAULT_PALETTE,
  EventFeed,
  OverlayCanvas,
  SceneView,
  attachToClient,
  handColor,
  palette,
  skeletonColor,
  type Context2DLike,
} from "pdigger-factory-sdk/viz";
import { RecordingContext } from "../helpers/context2d.js";
import { all, clientOf, fixtureFake, rejection, take } from "../helpers/fake.js";
import { readJson, readText, recordingPath } from "../helpers/fixtures.js";
import { mkFrame, stone } from "../helpers/frames.js";

const scene3d = readJson<Scene3D>("api/renderScene3d.json");
const overlay = readJson<Overlay2D>("api/renderOverlay2d.json");
const primitives = readJson<Overlay2D>("api/renderOverlay2d-primitives.json");
const fullFrame = readJson<Frame>("frames/dry1-carry-full.json");
const video = readJson<VideoEntry>("api/getVideo.json");
const ctxOf = (c: RecordingContext): Context2DLike => c as unknown as Context2DLike;

describe("colours", () => {
  it("merges the topology palette and overrides", () => {
    expect(palette(TOPOLOGY).left).toBe(TOPOLOGY.colors.left);
    expect(palette({ colors: { left: "#000000", unknown: "#fff" } }, { right: "#111111" })).toMatchObject({
      left: "#000000",
      right: "#111111",
    });
    expect(palette(null)).toEqual(DEFAULT_PALETTE);
    expect([handColor("left"), handColor("right"), handColor("both"), handColor(null)]).toEqual([
      DEFAULT_PALETTE.left,
      DEFAULT_PALETTE.right,
      DEFAULT_PALETTE.both,
      DEFAULT_PALETTE.none,
    ]);
    expect([skeletonColor("left"), skeletonColor("right"), skeletonColor("body")]).toEqual([
      DEFAULT_PALETTE.skelLeft,
      DEFAULT_PALETTE.skelRight,
      DEFAULT_PALETTE.skelBody,
    ]);
  });
});

describe("SceneView", () => {
  it("builds the render-ready scene: stones, board, skeleton, surface, in three.js axes", () => {
    const view = new SceneView();
    view.update(scene3d);
    expect(view.g).toBe(scene3d.g);
    expect(view.stoneCount).toBe(scene3d.stones.length);
    const s0 = scene3d.stones[0]!;
    const mesh = view.stone(s0.id!)!;
    view.group.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    mesh.getWorldPosition(p);
    const want = codec.sceneToThree(s0.pos);
    expect(p.x).toBeCloseTo(want[0]);
    expect(p.y).toBeCloseTo(want[1]);
    expect(p.z).toBeCloseTo(want[2]);
    expect(mesh.scale.toArray()).toEqual(s0.dims.map((d) => d));
    expect(view.board.visible).toBe(true);
    expect(view.board.scale.x).toBeCloseTo(2 * scene3d.board!.hw);
    expect(view.skeleton.visible).toBe(true);
    expect(view.skeleton.geometry.getAttribute("position").count).toBe(2 * 7);
    expect(view.surface.visible).toBe(true);
    expect(view.surface.geometry.getIndex()!.count).toBe(codec.decodeSurfaceMesh(scene3d.surface)!.indices.length);
    view.update({ ...scene3d, stones: scene3d.stones.slice(0, 3), board: null, surface: null, skeleton: {} });
    expect(view.stoneCount).toBe(3);
    expect(view.board.visible).toBe(false);
    expect(view.surface.visible).toBe(false);
    expect(view.skeleton.visible).toBe(false);
  });

  it("builds from frames of a full recording, with rings, focus and held colours", async () => {
    const view = new SceneView({ colors: { stones: "#123456" } });
    view.update(fullFrame);
    expect(view.stoneCount).toBe(fullFrame.world!.stones.length);
    expect(view.rings.children.map((c) => c.name).sort()).toEqual(["ring-left", "ring-right"]);
    expect(view.skeleton.geometry.getAttribute("position").count).toBeGreaterThan(10);
    const held = fullFrame.world!.stones.find((s) => s.side !== null)!;
    const m = view.stone(held.id)!.material as THREE.MeshStandardMaterial;
    expect(`#${m.color.getHexString()}`).toBe(handColor(held.side));
    const free = fullFrame.world!.stones.find((s) => s.side === null && !s.uncertain)!;
    expect(`#${(view.stone(free.id)!.material as THREE.MeshStandardMaterial).color.getHexString()}`).toBe("#123456");
    view.update(fullFrame.world!);
    expect(view.rings.children).toHaveLength(0);
    view.update({ ...fullFrame, world: undefined });
    expect(view.stoneCount).toBe(fullFrame.world!.stones.length);
    const replay = await Replay.open(recordingPath("dry1-0296-0306-full"));
    for await (const f of replay.frames()) view.update(f);
    expect(view.g).toBe(1530);
  });

  it("switches families, keeps anonymous stones, and honours the options", () => {
    const view = new SceneView({ surface: false, skeleton: false, board: false, topology: TOPOLOGY });
    const f = mkFrame(1, {
      stones: [
        stone(1),
        stone(2, [1, 1, 0], { family: "dogbone", uncertain: true }),
        { ...stone(3), solid: undefined } as never,
      ],
      board: { cx: 0, cy: 0, theta: 0, hw: 1, hh: 1 },
    });
    f.scene = fullFrame.scene;
    view.update(f);
    expect(view.stoneCount).toBe(2);
    expect(view.stone(2)!.userData.family).toBe("dogbone");
    expect((view.stone(2)!.material as THREE.Material).opacity).toBeCloseTo(0.45);
    expect(view.board.visible).toBe(false);
    expect(view.skeleton.visible).toBe(false);
    expect(view.rings.children).toHaveLength(0);
    view.update(mkFrame(2, { stones: [stone(1, [0, 0, 0], { family: "dogbone" }), stone(2)] }));
    expect(view.stone(1)!.userData.family).toBe("dogbone");
    expect(view.stone(2)!.userData.family).toBe("rect");
    view.update({
      ...scene3d,
      surface: scene3d.surface,
      stones: [{ ...scene3d.stones[0]!, id: null, side: "left", dims: [0, 0, 0] }],
    });
    expect(view.stoneCount).toBe(1);
    expect(view.stones.children[0]!.name).toBe("stone-anon-0");
    expect(view.surface.visible).toBe(false);
    const sparse = {
      ...scene3d,
      stones: [{ id: 5, family: "box" as const, pos: [], q: [], dims: [], alpha: 2 }],
      skeleton: { joints: [[0, 0, 0], null], bones: [] },
    };
    view.update(sparse as unknown as Scene3D);
    expect(view.stone(5)!.position.toArray()).toEqual([0, 0, 0]);
  });

  it("draws the focus path and skips joints that are missing", () => {
    const view = new SceneView();
    view.setFocusPath([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1],
    ]);
    expect(view.focusPath.visible).toBe(true);
    expect(view.focusPath.geometry.getAttribute("position").count).toBe(2);
    view.setFocusPath({ id: 1, path2d: [], path3d: [[0, 0, 0]] });
    expect(view.focusPath.visible).toBe(false);
    view.setFocusPath(null);
    const f = mkFrame(3, { stones: [stone(1)] });
    f.world!.focus = {
      id: 1,
      path2d: [],
      path3d: [
        [0, 0, 0],
        [0, 1, 0],
      ],
    };
    f.scene = { ...fullFrame.scene!, skeleton: { world: [[0, 0, 0], null] }, rings: undefined };
    view.update(f);
    expect(view.focusPath.visible).toBe(true);
    expect(view.skeleton.visible).toBe(false);
    const odd = new SceneView({ topology: { ...TOPOLOGY, wrist: { left: 62 }, tips: { left: [] } } });
    odd.update(fullFrame);
    expect(odd.skeleton.visible).toBe(true);
  });

  it("points cameras: source pose and fov, three-quarter, top", () => {
    const view = new SceneView();
    view.update(scene3d);
    const cam = new THREE.PerspectiveCamera();
    view.applyCamera(cam, "source", video);
    const want = codec.sceneToThree(video.camera!.t_c2w!);
    expect(cam.position.toArray().map((x) => +x.toFixed(5))).toEqual(want.map((x) => +x.toFixed(5)));
    expect(cam.aspect).toBeCloseTo(1920 / 1080);
    expect(cam.fov).toBeCloseTo((2 * Math.atan(540 / 1239.6307373046875) * 180) / Math.PI);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    expect(dir.y).toBeLessThan(-0.9);
    view.applyCamera(cam, "source", scene3d.camera);
    expect(cam.position.y).toBeCloseTo(want[1]);
    view.applyCamera(cam, "source", { R_c2w: video.camera!.R_c2w, t_c2w: [0, 0, 1] });
    expect(cam.position.y).toBeCloseTo(1);
    view.applyCamera(cam, "top");
    expect(cam.position.y).toBeGreaterThan(2);
    view.applyCamera(cam, "three");
    expect(cam.position.z).toBeGreaterThan(0);
    expect(() => view.applyCamera(cam, "source", { camera: {} })).toThrow(TypeError);
    expect(() => view.applyCamera(cam, "source")).toThrow(TypeError);
    const empty = new SceneView();
    empty.applyCamera(cam, "top");
    expect(cam.position.y).toBeCloseTo(3.2);
  });

  it("disposes geometries and materials", () => {
    const view = new SceneView();
    view.update(scene3d);
    view.update(fullFrame);
    const spy = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    view.dispose();
    expect(spy).toHaveBeenCalled();
    expect(view.group.children).toHaveLength(0);
    expect(view.stoneCount).toBe(0);
    spy.mockRestore();
  });
});

describe("OverlayCanvas", () => {
  it("draws the primitives of overlay2d (draw=primitives), scaled to the canvas", () => {
    const c = new RecordingContext();
    const images = new Map<string, unknown>([["/api/v2/session/frames/3079/regions.png", { w: 64 }]]);
    const o = new OverlayCanvas(ctxOf(c), { image: (url) => images.get(url) as CanvasImageSource | undefined });
    const stats = o.draw(primitives);
    const p = primitives.primitives!;
    expect(stats).toEqual({
      stones: 0,
      polygons: p.polygons!.length,
      segments: p.segments!.length,
      circles: p.circles!.length,
      labels: p.labels!.length,
      images: 1,
    });
    expect(c.calls.find((x) => x.op === "setTransform" && x.args[0] !== 1)?.args).toEqual([0.5, 0, 0, 0.5, 0, 0]);
    expect(c.count("clearRect")).toBe(1);
    expect(c.count("fillText")).toBe(p.labels!.length);
    expect(c.count("setLineDash")).toBeGreaterThan(0);
    const withTransform = new RecordingContext();
    new OverlayCanvas(ctxOf(withTransform), { image: () => ({}) as CanvasImageSource }).draw(primitives, {
      clear: false,
    });
    expect(withTransform.count("transform")).toBe(1);
    expect(withTransform.count("drawImage")).toBe(2);
    expect(withTransform.count("clearRect")).toBe(0);
    const noLabels = new RecordingContext();
    expect(new OverlayCanvas(ctxOf(noLabels), { labels: false }).draw(primitives).labels).toBe(0);
  });

  it("draws primitives with defaults for missing styles", () => {
    const c = new RecordingContext();
    const o = new OverlayCanvas(ctxOf(c));
    const stats = o.draw({
      ...primitives,
      primitives: {
        polygons: [
          { points: [[0, 0]] },
          {
            points: [
              [0, 0],
              [1, 1],
              [2, 0],
            ],
            fill: "#fff",
          },
        ],
        segments: [{ from: [0, 0], to: [1, 1] }],
        circles: [
          { at: [1, 1], r: 2, stroke: "#f00" },
          { at: [1, 1], r: 2 },
        ],
        labels: [
          { at: [1, 1], text: "hi", baseline: "middle", background: "#000" },
          { at: [2, 2], text: "x" },
        ],
        images: [{ url: "x", x: 0, y: 0, w: 1, h: 1 }],
      },
    });
    expect(stats).toMatchObject({ polygons: 1, segments: 1, circles: 2, labels: 2, images: 0 });
    expect(c.calls.find((x) => x.op === "fillRect")?.args[1]).toBeCloseTo(1 - Math.round(6 * 3) / 2 - 2);
  });

  it("draws the shapes of overlay2d: boxes, stones, skeleton, wrists, focus", () => {
    const c = new RecordingContext();
    const o = new OverlayCanvas(ctxOf(c));
    const stats = o.draw(overlay);
    expect(stats.stones).toBe(overlay.stones!.length);
    expect(stats.segments).toBe(overlay.skeleton!.bones!.length);
    expect(stats.circles).toBe(overlay.skeleton!.joints!.length);
    expect(stats.labels).toBe(2);
    const more = o.draw({
      ...overlay,
      native_wh: [],
      boxes: [{ kind: "stone", x0: 0, y0: 0, x1: 5, y1: 5 }, { kind: "person" }],
      stones: [
        {
          outline: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          style: "held",
          side: "left",
          alpha: 1,
        },
        {
          outline: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          style: "kept",
          alpha: 0.5,
        },
        {
          outline: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          style: "raw",
          alpha: 1,
        },
        {
          outline: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          style: "model",
          alpha: 1,
        },
        {
          outline: [
            [0, 0],
            [1, 0],
          ],
          style: "placed",
          alpha: 1,
        },
      ],
      skeleton: { bones: [{ from: [0, 0] }, { from: [0, 0], to: [1, 1] }], joints: [{}, { at: [1, 1] }] },
      wrists: [{ at: [5, 5], side: "right", filled: true }, { at: [5, 5], visible: false }, {}],
      focus: {
        outline: [
          [0, 0],
          [2, 0],
          [2, 2],
        ],
      },
    });
    expect(more).toMatchObject({ stones: 4, segments: 1, circles: 3, labels: 0 });
    o.draw({
      ...overlay,
      focus: { outline: [[0, 0]] },
      skeleton: undefined,
      stones: undefined,
      boxes: undefined,
      wrists: undefined,
    });
  });

  it("draws a frame: world outlines, the overlay skeleton and wrists, the focus path", () => {
    const c = new RecordingContext();
    const o = new OverlayCanvas(ctxOf(c), { nativeWh: [1920, 1080] });
    const stats = o.draw(fullFrame);
    expect(stats.stones).toBe(fullFrame.world!.stones.length);
    expect(stats.segments).toBeGreaterThan(5);
    expect(stats.circles).toBe(4);
    const f = mkFrame(1, {
      stones: [stone(1, [0, 0, 0], { mode: "placed" }), stone(2, [0, 0, 0], { detected: false, uncertain: true })],
    });
    f.world!.focus = {
      id: 1,
      path2d: [
        [0, 0],
        [5, 5],
      ],
      path3d: [],
    };
    expect(o.draw(f)).toMatchObject({ stones: 2, segments: 1 });
    const g = {
      ...f,
      overlay: {
        ...fullFrame.overlay!,
        joints: [],
        wrists: { left: { uv: null, visible: true, filled: true, ring: true } },
      },
    };
    expect(o.draw(g as Frame).circles).toBe(0);
    const odd = new OverlayCanvas(ctxOf(new RecordingContext()), { topology: { ...TOPOLOGY, wrist: {}, tips: {} } });
    expect(odd.draw(fullFrame).segments).toBeGreaterThan(5);
  });

  it("takes a canvas, and sizes without one", () => {
    const c = new RecordingContext();
    const canvas = { getContext: (kind: string) => (kind === "2d" ? c : null) };
    expect(new OverlayCanvas(canvas).ctx).toBe(c);
    expect(() => new OverlayCanvas({ getContext: () => null })).toThrow(TypeError);
    const bare = new RecordingContext() as unknown as { canvas?: unknown };
    delete bare.canvas;
    expect(new OverlayCanvas(bare as Context2DLike).size).toEqual({ width: 960, height: 540 });
    expect(new OverlayCanvas(bare as Context2DLike, { width: 100, height: 50 }).size).toEqual({
      width: 100,
      height: 50,
    });
  });
});

describe("defaults of sparse inputs", () => {
  it("fills in missing styles and layers", async () => {
    const c = new RecordingContext();
    const o = new OverlayCanvas(ctxOf(c), { image: () => ({}) as CanvasImageSource });
    expect(o.draw({ ...primitives, primitives: {} })).toMatchObject({ polygons: 0, images: 0 });
    const stats = o.draw({
      ...primitives,
      primitives: {
        images: [{ url: "u", x: 0, y: 0, w: 1, h: 1 }],
        polygons: [
          {
            points: [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
            stroke: "#fff",
          },
        ],
        circles: [
          { at: [0, 0], r: 1, stroke: "#fff" },
          { at: [0, 0], r: 1, fill: "#fff" },
        ],
      },
    });
    expect(stats).toMatchObject({ images: 1, polygons: 1, circles: 2 });
    expect(o.draw({ ...overlay, wrists: [{ at: [1, 1], side: "left" }] }).circles).toBeGreaterThan(0);
    const bare = mkFrame(1, { world: false });
    expect(new OverlayCanvas(ctxOf(new RecordingContext())).draw(bare).stones).toBe(0);
    const view = new SceneView();
    const w = mkFrame(2).world!;
    delete (w as { stones?: unknown }).stones;
    view.update(w);
    expect(view.stoneCount).toBe(0);
    const surface = { ...scene3d.surface!, opacity: undefined };
    view.update({ ...scene3d, surface, skeleton: { joints: scene3d.skeleton.joints, bones: [{ a: 13, b: 11 }] } });
    expect((view.surface.material as THREE.Material).opacity).toBe(0.5);
    expect(view.skeleton.visible).toBe(true);
    const r = Replay.fromLines([mkFrame(1, { t: 1 }), mkFrame(2, { t: 1 })]);
    const a = attachToClient({ update: () => undefined }, r, {
      clock: { now: () => 0, sleep: () => Promise.resolve() },
    });
    await a.done;
    expect(a.count).toBe(3);
  });
});

describe("EventFeed", () => {
  it("lists events and activities newest first with hand colours, and trims", async () => {
    const el = document.createElement("div");
    const feed = new EventFeed(el, { max: 5 });
    const r = await Replay.load(recordingPath("joined-mid-move"));
    const ups = [...r.updatesSync()];
    for (const u of ups) feed.addUpdate(u);
    expect(feed.size).toBe(5);
    expect(el.classList.contains("pdigger-feed")).toBe(true);
    const lines = feed.lines;
    expect(lines).toHaveLength(5);
    const golden = readText("golden/joined-mid-move.activities.txt") + readText("golden/joined-mid-move.events.txt");
    for (const l of lines) expect(golden).toContain(l);
    const first = el.firstElementChild as HTMLElement;
    expect(["event", "move", "push"]).toContain(first.dataset.kind);
    const t = feed.add("plain text");
    expect(t.dataset.kind).toBe("text");
    expect(t.dataset.hand).toBe("none");
    feed.clear();
    expect(feed.size).toBe(0);
    const calm = new EventFeed(document.createElement("div"), { skip: ["new"], activities: false });
    for (const u of ups) calm.addUpdate(u);
    expect(calm.lines.every((l) => !l.includes("appears"))).toBe(true);
    const acts = new EventFeed(document.createElement("div"), { events: false, colors: { left: "#010203" } });
    for (const u of ups) acts.addUpdate(u);
    expect(acts.size).toBe(ups.flatMap((u) => u.activities).length);
    const left = [...acts.element.children].find((c) => (c as HTMLElement).dataset.hand === "left") as HTMLElement;
    expect(left.style.borderLeft).toContain("#010203");
  });
});

describe("attachToClient", () => {
  it("drives views from a replay, an interpreter and a client", async () => {
    const replay = await Replay.load(recordingPath("dry1-0296-0306-full"));
    const scene = new SceneView();
    const ctx = new RecordingContext();
    const canvas = new OverlayCanvas(ctxOf(ctx));
    const feed = new EventFeed(document.createElement("div"));
    const seen: Update[] = [];
    const sink = { update: (u: Update) => seen.push(u) };
    const a = attachToClient([scene, canvas, feed, sink], replay, { pace: "none", onUpdate: () => undefined });
    await a.done;
    expect(a.count).toBe(seen.length);
    expect(seen.at(-1)?.isFinal).toBe(true);
    expect(scene.g).toBe(1530);
    expect(ctx.count("clearRect")).toBeGreaterThan(40);
    expect(feed.size).toBeGreaterThan(0);
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const factory = clientOf(fake);
    const interp = factory.interpreter({ resume: false });
    const b = attachToClient(feed, interp);
    await b.done;
    expect(b.count).toBe(23); // 22 frames and the final update of the ended stream
    seen.length = 0;
    const c = attachToClient(sink, factory, { interpreter: { resume: false } });
    await c.done;
    expect(c.count).toBe(23);
    expect(seen.at(-1)).toMatchObject({ frame: null, isFinal: true });
    // The Interpreter made for a client streams the layers the views draw, unless told otherwise.
    const layersOf = (from: number): (string | null)[] =>
      fake.requests
        .slice(from)
        .filter((r) => r.query.has("layers") && !/\/frames\/\d/.test(r.path))
        .map((r) => r.query.get("layers"));
    expect(layersOf(0).at(-1)).toBe("world,cards,scene,overlay");
    const before = fake.requests.length;
    const d = attachToClient(sink, factory, { interpreter: { resume: false, layers: ["world"] } });
    await d.done;
    expect(layersOf(before)).toEqual(["world"]);
  });

  it("draws a frame that carries only the overlay, over the newest world", async () => {
    const { overlay, world, session, video } = fullFrame;
    const frame = (g: number, withWorld: boolean): Frame => ({
      cursor: g + 1,
      session,
      video,
      g,
      i: 2 * g,
      t: g / 5,
      past_valid: true,
      dt_past: 0.6,
      overlay,
      ...(withWorld && world !== undefined ? { world: { ...world, g } } : {}),
    });
    const text = [frame(1, false), frame(2, true), frame(3, false)].map((f) => JSON.stringify(f)).join("\n");
    const canvas = new OverlayCanvas(ctxOf(new RecordingContext()));
    const draws = vi.spyOn(canvas, "draw");
    const a = attachToClient(canvas, Replay.fromBytes(new TextEncoder().encode(`${text}\n`)), { pace: "none" });
    await a.done;
    // every frame draws: the first without stones, the third over the second's world
    expect(draws.mock.calls.map(([f]) => [(f as Frame).g, (f as Frame).world?.g ?? null])).toEqual([
      [1, null],
      [2, 2],
      [3, 2],
    ]);
  });

  it("draws over a newest world only of the same session and video, and only in its own attachment", async () => {
    const { overlay, world, video } = fullFrame;
    const frame = (session: number, g: number, withWorld: boolean, v = video): Frame => ({
      cursor: g + 1,
      session,
      video: v,
      g,
      i: 2 * g,
      t: g / 5,
      past_valid: true,
      dt_past: 0.6,
      overlay,
      ...(withWorld && world !== undefined ? { world: { ...world, session, video: v, g } } : {}),
    });
    const replayOf = (frames: Frame[]): Replay =>
      Replay.fromBytes(new TextEncoder().encode(frames.map((f) => `${JSON.stringify(f)}\n`).join("")));
    const canvas = new OverlayCanvas(ctxOf(new RecordingContext()));
    const draws = vi.spyOn(canvas, "draw");
    const drawn = (): (string | null)[] =>
      draws.mock.calls.map(([f]) =>
        (f as Frame).world ? `${(f as Frame).world!.session}/${(f as Frame).world!.g}` : null,
      );
    // a new session's first frame comes without its world: the old session's stones are not drawn over it
    await attachToClient(canvas, replayOf([frame(1, 1, true), frame(2, 0, false), frame(2, 1, true)]), { pace: "none" })
      .done;
    expect(drawn()).toEqual(["1/1", null, "2/1"]);
    // a new attachment of the canvas starts without the last one's world, even of the same session and video
    draws.mockClear();
    await attachToClient(canvas, replayOf([frame(2, 2, false)]), { pace: "none" }).done;
    expect(drawn()).toEqual([null]);
    // another video under the same session number: not its world either
    draws.mockClear();
    await attachToClient(canvas, replayOf([frame(2, 3, true), frame(2, 4, false, "other")]), { pace: "none" }).done;
    expect(drawn()).toEqual(["2/3", null]);
  });

  it("closes the interpreter it made for a client, and leaves one it was given open", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake);
    const sink = { update: () => undefined };
    const a = attachToClient(sink, factory, { onUpdate: () => (a.count === 3 ? a.stop() : undefined) });
    await a.done;
    await settle();
    expect(fake.streams).toBe(0);
    expect((factory as unknown as { active: Set<unknown> }).active.size).toBe(0); // nothing left behind
    const interp = factory.interpreter();
    const b = attachToClient(sink, interp, { onUpdate: () => (b.count === 3 ? b.stop() : undefined) });
    await b.done;
    expect(b.count).toBe(3);
    expect(await take(interp.updates(), 2)).toHaveLength(2); // still usable: the caller owns it
    interp.close();
  });

  it("stops on stop() or an aborted signal, and rejects on stream errors", async () => {
    const fake = await fixtureFake("joined-mid-move");
    const factory = clientOf(fake, { retries: 0 });
    const feed = new EventFeed(document.createElement("div"));
    const a = attachToClient(feed, factory, { onUpdate: () => (a.count === 5 ? a.stop() : undefined) });
    await a.done;
    expect(a.count).toBe(5);
    const pre = new AbortController();
    pre.abort();
    const b = attachToClient(feed, factory, { signal: pre.signal });
    await b.done;
    expect(b.count).toBe(0);
    const later = new AbortController();
    const c = attachToClient(feed, await Replay.load(recordingPath("joined-mid-move")), {
      signal: later.signal,
      pace: "realtime",
    });
    later.abort();
    await c.done;
    fake.failNext("streamFrames", 1, { status: 400, body: { error: "x", code: "unknown_layer" } });
    const d = attachToClient(feed, factory);
    expect(((await rejection(d.done)) as { code: string }).code).toBe("unknown_layer");
    const r = await Replay.open(new Blob([new TextEncoder().encode('{"recording":"pfr1","video":null}\n')]).stream());
    await all(r.updates());
    expect(((await rejection(attachToClient(feed, r, { pace: "none" }).done)) as Error).name).toBe("TypeError");
  });
});
