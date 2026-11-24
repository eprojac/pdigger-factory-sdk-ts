/**
 * TrayReportView and reportMarks (SDK-DESIGN.md sections 4.7 and 11): a synthetic tray with every role, the layout, the
 * labels, the camera and the outlines of the removed stones, then the fixture recording's tray 1.
 */
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  InterpreterCore,
  Replay,
  Tray,
  TrayFact,
  TrayStone,
  type Frame,
  type Scene3D,
  type StoneView,
  type TrayFactInit,
  type TrayPoint,
  type TrayStoneInit,
  type WorldLayer,
} from "pdigger-factory-sdk";
import { REPORT_COLORS, TrayReportView, reportMarks, type ReportMark, type SceneView } from "pdigger-factory-sdk/viz";
import { readJson, readText, recordingPath } from "../helpers/fixtures.js";
import { mkFrame, stone } from "../helpers/frames.js";

const at = (t: number): TrayPoint => ({ g: Math.round(t * 5), t, wall: null });
const SIZE: [number, number] = [0.4, 0.2];
const TURNED: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // a quarter turn about z

/** A tray stone of tray 3 first seen under world id `wid` (the last segment of its id), on the tray and sure. */
function trayStone(wid: number, more: Partial<TrayStoneInit> = {}): TrayStone {
  const place = more.place ?? [0, 0];
  return new TrayStone({
    id: `s7t1.0-3-${wid}`,
    worldId: wid,
    status: "on",
    sure: true,
    added: false,
    certain: null,
    born: at(1),
    size: SIZE,
    firstPlace: place,
    leftPlace: place,
    ...more,
    place,
  });
}

const removed = (more: Partial<TrayStoneInit>): Partial<TrayStoneInit> => ({
  status: "removed",
  worldId: null,
  certain: true,
  leftPlace: null,
  ...more,
});

const fact = (init: Partial<TrayFactInit> & Pick<TrayFactInit, "kind">): TrayFact =>
  new TrayFact({
    tray: 3,
    session: 7,
    video: "v",
    stone: null,
    worldId: null,
    certain: null,
    why: null,
    g: 10,
    t: 2,
    wall: null,
    stones: null,
    sure: null,
    added: null,
    removed: null,
    unclear: null,
    ...init,
  });

/**
 * Tray 3: it arrived with 1, 2, 10, 11, 3, 4, 5 and 9; 1, 10 and 11 were removed for certain, 2 unclear; 3 moved; 4
 * is on it as world stone 14; 5 is not sure; 9 has no world stone as it left (not what a tray that has left has, but
 * the view must not fail on it); 6 was set down for certain, 7 is an unclear addition; 8 was set down and taken again.
 */
const STONES = [
  trayStone(1, removed({ place: [0.2, 0.3] })),
  trayStone(2, removed({ place: [0.7, 0.3], certain: false, sure: false })),
  trayStone(10, removed({ place: [1.2, 0.3] })),
  trayStone(11, removed({ place: [1.7, 0.3] })),
  trayStone(3, { place: [0.7, 1.0], firstPlace: [0.2, 1.0], leftPlace: [0.7, 1.0], touched: 30 }),
  trayStone(4, { worldId: 14, place: [1.2, 1.0] }),
  trayStone(5, { place: [1.7, 1.0], sure: false }),
  trayStone(9, { worldId: null, place: [2.2, 1.0] }),
  trayStone(6, { added: true, certain: true, place: [2.2, 0.3], born: at(4) }),
  trayStone(7, { added: true, certain: false, sure: false, place: [1.2, 0.3], born: at(8) }),
  trayStone(8, removed({ added: true, certain: false, place: [2.2, 1.4], born: at(5) })),
];
const sid = (wid: number): string => `s7t1.0-3-${wid}`;
const FACTS = [
  fact({ kind: "arrived", g: 5, t: 1, stones: 8 }),
  fact({ kind: "removed", stone: sid(1), certain: true, code: "missing", t: 3 }),
  fact({ kind: "added", stone: sid(6), worldId: 6, certain: true, code: "set_down", t: 4 }),
  fact({ kind: "removed", stone: sid(11), certain: true, code: "carried_away", t: 4.5 }),
  fact({ kind: "added", stone: sid(8), worldId: 8, certain: true, code: "set_down", t: 5 }),
  fact({ kind: "removed", stone: sid(10), certain: true, code: "missing", t: 6 }),
  fact({ kind: "removed", stone: sid(8), certain: false, code: "not_found", t: 9 }),
  fact({ kind: "removed", stone: sid(2), certain: false, code: "not_found", t: 9 }),
  fact({ kind: "added", stone: sid(7), worldId: 7, certain: false, code: "not_recognised", t: 9 }),
  fact({ kind: "leaving", g: 45, t: 9, stones: 7, sure: 4, added: 2, removed: 3, unclear: 3 }),
];
const TRAY = new Tray({ session: 7, video: "v", n: 3, arrived: at(1), leaving: at(9), stones: STONES, facts: FACTS });

/** A world stone at a scene place, 0.1 high. */
const ws = (
  id: number,
  [x, y]: [number, number],
  more: { dims?: [number, number, number]; q?: [number, number, number, number] } = {},
): StoneView =>
  stone(id, [x, y, 0.05], {
    solid: { pos: [x, y, 0.05], q: more.q ?? [0, 0, 0, 1], dims: more.dims ?? [0.4, 0.2, 0.1] },
  });

/** The world as tray 3 arrived: its stones (10 not seen), and 50, not a tray stone, off the board. */
const BEFORE = mkFrame(5, {
  session: 7,
  board: { cx: 1.2, cy: 0.7, theta: 0, hw: 1.3, hh: 0.8 },
  stones: [
    ws(1, [0.2, 0.3], { q: TURNED }), // its long side along y: turned
    ws(2, [0.7, 0.3], { dims: [0.2, 0.4, 0.1] }), // its long side along y: the longer second side
    ws(11, [1.7, 0.3]),
    ws(3, [0.2, 1.0]),
    ws(4, [1.2, 1.0]),
    ws(5, [1.7, 1.0]),
    ws(9, [2.2, 1.0]),
    ws(50, [3.0, 0.3]),
  ],
});
/** The world as it left: 4 as world stone 14, the additions, and 51 where 9 was (not linked). */
const AFTER = mkFrame(45, {
  session: 7,
  board: { cx: 1.25, cy: 0.65, theta: 0.05, hw: 1.3, hh: 0.8 },
  stones: [
    ws(3, [0.7, 1.0]),
    ws(14, [1.2, 1.0]),
    ws(5, [1.7, 1.0]),
    ws(6, [2.2, 0.3]),
    ws(7, [1.2, 0.3]),
    ws(51, [2.2, 1.0]),
  ],
});

const hex = (m: THREE.Material | THREE.Material[]): string =>
  `#${(m as THREE.MeshStandardMaterial).color.getHexString()}`;
const colorOf = (view: SceneView, id: number): string => hex(view.stone(id)!.material);
const opacityOf = (view: SceneView, id: number): number => (view.stone(id)!.material as THREE.Material).opacity;
const lower = (c: string): string => c.toLowerCase();

describe("reportMarks", () => {
  it("marks the stones the tray arrived with and those on it as it left, by world id", () => {
    expect(reportMarks(new Tray({ ...TRAY, leaving: null, open: null }))).toBeNull(); // still on: no report
    const marks = reportMarks(TRAY)!;
    const m = (stoneId: number, role: ReportMark["role"], certain = true, label = ""): ReportMark => ({
      stone: sid(stoneId),
      role,
      certain,
      label,
    });
    expect([...marks.before]).toEqual([
      [1, m(1, "removed", true, "1")],
      [2, m(2, "removed", false, "2")],
      [10, m(10, "removed", true, "10")],
      [11, m(11, "removed", true, "11")],
      [3, m(3, "moved", true, "3")],
      [4, m(4, "sure")],
      [5, m(5, "unsure")],
      [9, m(9, "sure")],
    ]);
    // as it left: 4 by the world id it stands for then, 9 without one left out, 8 (taken again) on neither side
    expect([...marks.after]).toEqual([
      [3, m(3, "moved", true, "3")],
      [14, m(4, "sure")],
      [5, m(5, "unsure")],
      [6, m(6, "added", true, "6")],
      [7, m(7, "added", false, "7")],
    ]);
  });

  it("labels a stone by its id after the tray's number, a second stone first seen under a world id with -2", () => {
    // tray stone 1 arrives at t 9.96 and is removed; world 1, back at t 10.04 in the same tenth, is added as s1t10.0-1-1-2
    const core = new InterpreterCore();
    const times = [9, 9.2, 9.4, 9.6, 9.96, 10, 10.04, ...Array.from({ length: 12 }, (_, k) => 10.2 + 0.2 * k)];
    const slab = (id: number, x: number): StoneView =>
      stone(id, [x, 0, 0.046], {
        mode: "kept",
        shape: "frozen",
        solid: { pos: [x, 0, 0.046], q: [0, 0, 0, 1], dims: [0.3, 0.2, 0.092] },
      });
    times.forEach((t, g) => {
      const stones = g === 5 ? [slab(2, 0.6)] : [slab(1, g >= 6 ? 0.3 : -0.6), slab(2, 0.6)];
      const events = g === 5 ? [{ type: "place" as const, id: 2, side: "left" }] : [];
      core.feed(mkFrame(g, { t, stones, events, stats: { stones: stones.length, confirmed: stones.length } }));
    });
    core.end();
    const marks = reportMarks(core.trays()[0]!)!;
    expect(marks.before.get(1)).toEqual({ stone: "s1t10.0-1-1", role: "removed", certain: false, label: "1" });
    expect(marks.after.get(1)).toEqual({ stone: "s1t10.0-1-1-2", role: "added", certain: false, label: "1-2" });
  });

  it("keeps the colours of the Rust viewer", () => {
    expect(REPORT_COLORS).toEqual({
      removed: "#D8432E",
      added: "#1E96C8",
      moved: "#6E48B9",
      sure: "#0E8A72",
      unsure: "#DE7C34",
    });
    expect(Object.isFrozen(REPORT_COLORS)).toBe(true);
  });
});

describe("TrayReportView", () => {
  it("shows the tray as it arrived and as it left, side by side, its stones coloured by the report", () => {
    const view = new TrayReportView();
    expect(view.group.children.map((c) => c.name)).toEqual(["before", "after"]);
    expect(view.labels()).toEqual([]); // nothing shown yet
    view.show(TRAY, BEFORE, AFTER);
    expect(view.report?.describe().split("\n")[0]).toBe(
      "tray 3, 0:01.0 to 0:09.0: 5 removed, 3 added, 1 moved, not complete: 3 unclear, 1 not sure",
    );
    expect(view.marks?.after.size).toBe(5);
    const { before, after } = view;
    expect([before.stoneCount, after.stoneCount]).toEqual([8, 5]);
    expect(before.skeleton.visible || after.skeleton.visible).toBe(false);
    // the roles' colours; an unclear removal or addition translucent; a world stone without a mark dimmed grey
    expect([1, 2, 11, 3, 4, 5, 9].map((id) => colorOf(before, id))).toEqual(
      ["removed", "removed", "removed", "moved", "sure", "unsure", "sure"].map((r) =>
        lower(REPORT_COLORS[r as ReportMark["role"]]),
      ),
    );
    expect([3, 14, 5, 6, 7].map((id) => colorOf(after, id))).toEqual(
      ["moved", "sure", "unsure", "added", "added"].map((r) => lower(REPORT_COLORS[r as ReportMark["role"]])),
    );
    expect([opacityOf(before, 1), opacityOf(before, 2), opacityOf(after, 6), opacityOf(after, 7)]).toEqual([
      1, 0.45, 1, 0.45,
    ]);
    expect((before.stone(2)!.material as THREE.Material).transparent).toBe(true);
    expect(after.stone(51)).toBeUndefined();
    const dim = before.stone(50)!;
    expect(hex(dim.material)).toBe("#7d8790");
    expect((dim.material as THREE.Material).opacity).toBe(0.3);
    expect(dim.userData.mark).toBeNull();
    expect(after.stone(7)!.userData.mark).toEqual({ stone: sid(7), role: "added", certain: false, label: "7" });
    // one material per colour and opacity, shared
    expect(before.stone(1)!.material).toBe(before.stone(11)!.material);
  });

  it("draws every linked member at its recorded place when the leaving observation is incomplete", () => {
    const view = new TrayReportView();
    const before = mkFrame(5, { stones: [ws(4, [0, 0], { dims: [0.2, 0.4, 0.12], q: TURNED })] });
    const raw = readJson<Scene3D>("api/renderScene3d.json");
    const tray = new Tray({
      ...TRAY,
      stones: [
        trayStone(4, { worldId: 14, leftPlace: [1, 2], place: [3, 4] }),
        trayStone(6, { added: true, leftPlace: null, place: [5, 6] }),
        trayStone(5, { leftPlace: [0, 1] }),
      ],
    });
    view.show(tray, before, { ...raw, stones: [{ ...raw.stones[0]!, id: 5, pos: [9, 9, 0.1] }] });
    expect(view.after.stoneCount).toBe(3);
    const renamed = view.after.stone(14)!;
    expect(renamed.position.toArray().slice(0, 2)).toEqual([1, 2]);
    expect(renamed.scale.toArray()).toEqual([0.2, 0.4, 0.12]);
    expect(renamed.quaternion.toArray()).toEqual(TURNED);
    expect(view.after.stone(5)!.position.toArray().slice(0, 2)).toEqual([0, 1]);
    expect(view.after.stone(6)!.position.toArray()).toEqual([5, 6, 0.03]);
    expect(view.after.stone(6)!.scale.toArray()).toEqual([0.4, 0.2, 0.06]);
    expect(view.after.stone(6)!.userData.mark.stone).toBe(sid(6));
    view.dispose();
  });

  it("lays the two sides out along x with a gap, each centred, and frames them with the camera", () => {
    const view = new TrayReportView({ gap: 0.5 });
    // before anything is shown: a unit square on each side
    expect(view.bounds("before").min.x).toBeCloseTo(-1.25);
    expect(view.bounds("after").max.x).toBeCloseTo(1.25);
    view.show(TRAY, BEFORE, AFTER);
    const b = view.bounds("before");
    const a = view.bounds("after");
    expect(b.max.x).toBeCloseTo(-0.25);
    expect(a.min.x).toBeCloseTo(0.25);
    for (const box of [a, b]) expect(box.min.z + box.max.z).toBeCloseTo(0);
    // the before side runs from the board's left edge (-0.1) to the end of stone 50 off it (3.2); the boards 1.6 deep
    expect(b.max.x - b.min.x).toBeCloseTo(3.3);
    expect(b.max.z - b.min.z).toBeCloseTo(1.6);
    const turned = 1.3 * Math.cos(0.05) + 0.8 * Math.sin(0.05);
    expect(a.max.x - a.min.x).toBeCloseTo(2 * turned);
    expect([b.min.y, b.max.y]).toEqual([expect.closeTo(0), expect.closeTo(0.1)]);
    const all = view.bounds();
    expect([all.min.x, all.max.x]).toEqual([b.min.x, a.max.x]);

    // every corner of both sides inside the view, the outermost with a little room (1 / 1.04 of the half-width)
    const corners = (box: THREE.Box3): THREE.Vector3[] =>
      [box.min.x, box.max.x].flatMap((x) =>
        [box.min.y, box.max.y].flatMap((y) => [box.min.z, box.max.z].map((z) => new THREE.Vector3(x, y, z))),
      );
    const reach = (camera: THREE.Camera): number =>
      Math.max(
        ...corners(all)
          .map((p) => p.project(camera))
          .map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))),
      );
    const camera = new THREE.PerspectiveCamera(40, 2.5, 0.01, 50);
    // top: straight down
    view.applyCamera(camera);
    expect(camera.getWorldDirection(new THREE.Vector3()).y).toBeCloseTo(-1);
    expect(reach(camera)).toBeCloseTo(1 / 1.04, 6);
    // the scene's y is up on the screen: the before side's far edge (its smallest z) above its near one
    expect(new THREE.Vector3(b.min.x, 0, b.min.z).project(camera).y).toBeGreaterThan(0);
    // three: from the front, tilted down
    view.applyCamera(camera, "three");
    expect(camera.position.z).toBeGreaterThan(all.max.z);
    expect(camera.position.y).toBeGreaterThan(1);
    expect(reach(camera)).toBeCloseTo(1 / 1.04, 6);
    // a narrow view: the width decides
    const tall = new THREE.PerspectiveCamera(40, 0.5, 0.01, 50);
    view.applyCamera(tall);
    expect(reach(tall)).toBeCloseTo(1 / 1.04, 6);
  });

  it("labels the removed, added and moved stones at their top centres, in the group's coordinates", () => {
    const view = new TrayReportView();
    view.show(TRAY, BEFORE, AFTER);
    const labels = view.labels();
    // 10 was not in the world given as it arrived: no stone, no label
    expect(labels.map((l) => [l.side, l.text, l.color])).toEqual([
      ["before", "1", REPORT_COLORS.removed],
      ["before", "2", REPORT_COLORS.removed],
      ["before", "11", REPORT_COLORS.removed],
      ["before", "3", REPORT_COLORS.moved],
      ["after", "3", REPORT_COLORS.moved],
      ["after", "6", REPORT_COLORS.added],
      ["after", "7", REPORT_COLORS.added],
    ]);
    expect(labels[1]!.mark).toEqual({ stone: sid(2), role: "removed", certain: false, label: "2" });
    // scene [x, y, z] is three.js [x, z, -y], then the side's place in the group
    const top = (side: "before" | "after", [x, y]: [number, number]): THREE.Vector3 =>
      new THREE.Vector3(x, 0.1, -y).add(view[side].group.position);
    const near = (p: THREE.Vector3, q: THREE.Vector3): void => expect(p.distanceTo(q)).toBeLessThan(1e-9);
    near(labels[0]!.position, top("before", [0.2, 0.3]));
    near(labels[4]!.position, top("after", [0.7, 1.0]));
    // a group placed elsewhere in a scene: still the group's own coordinates
    const scene = new THREE.Scene();
    scene.add(view.group);
    view.group.position.set(5, 1, -2);
    view.group.rotation.y = 0.4;
    near(view.labels()[0]!.position, top("before", [0.2, 0.3]));
  });

  it("outlines, on the after side, where each removed stone was taken from, axis-aligned, as it lay", () => {
    const view = new TrayReportView();
    view.show(TRAY, BEFORE, AFTER);
    const outlines = view.removedPlaces.children as THREE.Mesh[];
    expect(view.removedPlaces.parent).toBe(view.after.world);
    expect(outlines.map((o) => o.name)).toEqual([1, 11, 10, 8, 2].map((w) => `removed-${sid(w)}`));
    const round = (v: number): number => +v.toFixed(6);
    const boxOf = (o: THREE.Mesh): THREE.Box3 => {
      o.geometry.computeBoundingBox();
      return o.geometry.boundingBox!;
    };
    // the dashes lie inside the stone's footprint: its place and size. 1 lay turned and 2 with its longer second side:
    // upright; 11 lengthwise; 10 and 8 were not in the world as the tray arrived: lengthwise
    expect(
      outlines.map((o) => {
        const box = boxOf(o);
        return [round(box.max.x - box.min.x), round(box.max.y - box.min.y), round(box.min.z), round(box.max.z)];
      }),
    ).toEqual([
      [0.2, 0.4, 0.002, 0.002],
      [0.4, 0.2, 0.002, 0.002],
      [0.4, 0.2, 0.002, 0.002],
      [0.4, 0.2, 0.002, 0.002],
      [0.2, 0.4, 0.002, 0.002],
    ]);
    const centre = (o: THREE.Mesh): number[] => {
      const c = boxOf(o).getCenter(new THREE.Vector3());
      return [round(c.x), round(c.y)];
    };
    expect(centre(outlines[0]!)).toEqual([0.2, 0.3]);
    expect(centre(outlines[3]!)).toEqual([2.2, 1.4]);
    // dashes of 0.04 with gaps of 0.03, fitted to each edge: 6 along a side of 0.4, 3 along one of 0.2, two triangles
    // each; the first starts at the first corner
    const outline = outlines[1]!;
    const position = outline.geometry.getAttribute("position");
    expect(position.count).toBe((6 + 3 + 6 + 3) * 6);
    expect([round(position.getX(0)), round(position.getY(0))]).toEqual([1.5, 0.2]);
    expect(round(position.getX(1) - position.getX(0))).toBe(round((0.4 / 6) * (4 / 7)));
    expect(outline.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(hex(outline.material)).toBe(lower(REPORT_COLORS.removed));
    expect((outline.material as THREE.Material).depthTest).toBe(false);
    expect(outline.renderOrder).toBe(10);
    expect((outline.userData.change as { kind: string }).kind).toBe("removed");
    // a stone without a size still gets a (tiny) outline, not one of NaNs
    const flat = new Tray({ ...TRAY, stones: [trayStone(1, removed({ size: [0, 0] })), ...STONES.slice(1)] });
    view.show(flat, BEFORE, AFTER);
    const points = (view.removedPlaces.children[0] as THREE.Mesh).geometry.getAttribute("position").array;
    expect([...points].every(Number.isFinite)).toBe(true);

    // another tray: its own outlines only, the old ones freed
    const freed = (view.removedPlaces.children as THREE.Mesh[]).map((o) => vi.spyOn(o.geometry, "dispose"));
    const calm = new Tray({
      ...TRAY,
      stones: STONES.filter((s) => s.status === "on"),
      facts: [FACTS[0]!, FACTS.at(-1)!],
    });
    view.show(calm, BEFORE, AFTER);
    expect(view.removedPlaces.children).toHaveLength(0);
    for (const spy of freed) expect(spy).toHaveBeenCalledOnce();
    expect(colorOf(view.before, 1)).toBe("#7d8790"); // no longer a stone of the tray's report: dimmed
  });

  it("takes frames, worlds and render-ready scenes, with or without a board", () => {
    const view = new TrayReportView({ gap: 0, scene: { colors: { board: "#000000" } } });
    const width = (): number => view.bounds("before").max.x - view.bounds("before").min.x;
    view.show(TRAY, BEFORE.world as WorldLayer, AFTER);
    expect(width()).toBeCloseTo(3.3); // the world layer's board, and stone 50 off it
    // a frame whose world has no board: the stones' extent
    view.show(TRAY, mkFrame(5, { stones: [ws(1, [0, 0]), ws(2, [1, 0])] }), AFTER);
    expect(width()).toBeCloseTo(1.4);
    // a world layer without one
    view.show(TRAY, mkFrame(5, { stones: [ws(1, [0, 0])] }).world!, AFTER);
    expect(width()).toBeCloseTo(0.4);
    // a frame without a world leaves the side as it was; its extent is its stones'
    view.show(TRAY, mkFrame(6, { world: false }), AFTER);
    expect(view.before.stoneCount).toBe(1);
    // nothing at all: a unit square
    view.show(TRAY, mkFrame(5), AFTER);
    expect(width()).toBeCloseTo(1);
    // a render-ready scene, with its board and without one; its surface left out unless asked for
    const scene3d = readJson<Scene3D>("api/renderScene3d.json");
    view.show(TRAY, scene3d, AFTER);
    expect(view.before.stoneCount).toBe(scene3d.stones.length);
    expect(view.before.surface.visible).toBe(false);
    const { theta, hw, hh } = scene3d.board!;
    const deep = 2 * (Math.abs(Math.sin(theta)) * hw + Math.abs(Math.cos(theta)) * hh);
    expect(view.bounds("before").max.z - view.bounds("before").min.z).toBeGreaterThanOrEqual(deep - 1e-9);
    view.show(TRAY, { ...scene3d, board: null, stones: [] }, AFTER);
    expect(width()).toBeCloseTo(1);
    // a stone without an id has no mark: dimmed
    view.show(TRAY, { ...scene3d, stones: [{ ...scene3d.stones[0]!, id: null }] }, AFTER);
    expect(hex((view.before.stones.children[0] as THREE.Mesh).material)).toBe("#7d8790");
    const withSurface = new TrayReportView({ scene: { surface: true } });
    withSurface.show(TRAY, scene3d, AFTER);
    expect(withSurface.before.surface.visible).toBe(true);
    // the focus path is not part of the report
    const focused = mkFrame(5, { stones: [ws(1, [0, 0])] });
    focused.world!.focus = {
      id: 1,
      path2d: [],
      path3d: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    };
    view.show(TRAY, focused, AFTER);
    expect(view.before.focusPath.visible).toBe(false);
  });

  it("refuses a tray without a report, and disposes of everything", () => {
    const view = new TrayReportView();
    expect(() => view.show(new Tray({ ...TRAY, leaving: null }), BEFORE, AFTER)).toThrow(TypeError);
    view.show(TRAY, BEFORE, AFTER);
    const geometries = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const materials = vi.spyOn(THREE.Material.prototype, "dispose");
    view.dispose();
    expect(geometries).toHaveBeenCalled();
    expect(materials.mock.contexts).toEqual(expect.arrayContaining([expect.any(THREE.MeshBasicMaterial)]));
    expect(view.group.children).toHaveLength(0);
    expect(view.removedPlaces.children).toHaveLength(0);
    expect([view.report, view.marks, view.labels()]).toEqual([null, null, []]);
    geometries.mockRestore();
    materials.mockRestore();
  });
});

describe("TrayReportView on a recording", () => {
  it("shows dry1's tray 1: 6 removed and 5 unclear removals as it arrived, 13 unclear additions as it left, 8 moved, 1 not sure", async () => {
    const replay = await Replay.load(recordingPath("dry1-0018-0153"));
    const tray = replay.traysSync().find((t) => t.n === 1)!;
    expect(`${tray.report()!.describe()}\n`).toBe(readText("golden/dry1-0018-0153.reports.txt"));
    const worlds = new Map<number, Frame>();
    for (const f of replay.framesSync()) if (f.world && !worlds.has(f.g)) worlds.set(f.g, f);
    const view = new TrayReportView();
    view.show(tray, worlds.get(tray.arrived!.g)!, worlds.get(tray.leaving!.g)!);

    const roles = (side: "before" | "after"): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const c of view[side].stones.children) {
        const mark = c.userData.mark as ReportMark | null;
        const key = mark === null ? "none" : `${mark.role}${mark.certain ? "" : "?"}`;
        out[key] = (out[key] ?? 0) + 1;
      }
      return out;
    };
    expect(reportMarks(tray)!.before.size).toBe(42);
    expect(roles("before")).toEqual({ removed: 6, "removed?": 5, moved: 8, sure: 22, unsure: 1 });
    // as it left: 44 accounted stones. 238's positive sighting on the next frame, 230's box on the tray's last frame,
    // 240's at the leaving point and 281's where the world kept it there establish their places; the leaving's speckle
    // answer finds 119 again on 230 and 120 (moved) on 240, and recognises 116 on 238 (4.6.13); 281's origin is unclear.
    expect(reportMarks(tray)!.after.size).toBe(44);
    expect(roles("after")).toEqual({ "added?": 13, moved: 8, sure: 22, unsure: 1 });
    const one = "20261122T023847.0Z-1-";
    expect(view.after.stone(230)!.userData.mark).toMatchObject({ stone: `${one}119`, role: "sure", certain: true });
    expect(view.after.stone(238)!.userData.mark).toMatchObject({ stone: `${one}116`, role: "sure", certain: true });
    expect(view.after.stone(240)!.userData.mark).toMatchObject({ stone: `${one}120`, role: "moved", certain: true });
    expect(view.after.stone(281)!.userData.mark).toMatchObject({ role: "added", certain: false });
    const labels = view.labels();
    const texts = (side: string): string[] =>
      labels
        .filter((l) => l.side === side)
        .map((l) => l.text)
        .sort();
    // the removed and the moved as it arrived, the added and the moved as it left
    const moved = ["104", "118", "120", "85", "86", "88", "89", "90"];
    expect(texts("before")).toEqual(
      [...moved, "105", "112", "117", "121", "125", "126", "127", "128", "129", "130", "87"].sort(),
    );
    expect(texts("after")).toEqual(
      [...moved, "151", "177", "193", "201", "203", "246", "249", "278", "279", "280", "281", "282", "284"].sort(),
    );
    // stone 126 lay turned on the tray: its place is outlined upright
    const outline = view.removedPlaces.getObjectByName("removed-20261122T023847.0Z-1-126") as THREE.Mesh;
    outline.geometry.computeBoundingBox();
    const size = outline.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.y).toBeGreaterThan(size.x);
    expect(view.removedPlaces.children).toHaveLength(11);
    // the boards side by side
    expect(view.bounds("before").max.x).toBeLessThan(view.bounds("after").min.x);
    view.dispose();
  });
});
