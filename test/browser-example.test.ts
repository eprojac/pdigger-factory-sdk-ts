// @vitest-environment happy-dom
/** The viz example page's logic (examples/browser/app.js) on a recording, without WebGL: a fake 2-D context records. */
import { expect, it } from "vitest";
import type { TrayChange, TrayReport } from "pdigger-factory-sdk";
import { start, startReport } from "../examples/browser/app.js";
import { RecordingContext } from "./helpers/context2d.js";
import { readText, recordingPath } from "./helpers/fixtures.js";

it("follows a replay with SceneView, OverlayCanvas and EventFeed", async () => {
  document.body.innerHTML =
    '<span id="status"></span><canvas id="overlay"></canvas><canvas id="scene"></canvas><ul id="feed"></ul>';
  const ctx = new RecordingContext();
  const run = await start({
    recording: recordingPath("dry1-0296-0306-full"),
    document,
    pace: "none",
    until: 1512,
    webgl: false,
    context2d: ctx,
  });
  expect(run.updates).toBe(33);
  expect(document.getElementById("status")?.textContent).toMatchInlineSnapshot(
    `"dry1-0296-0306-full · frame 1512 · 5:01.6 · 42 stones · left touch, right carry"`,
  );
  expect(run.scene.stoneCount).toBeGreaterThan(30);
  expect(run.renderer).toBeNull();
  expect(run.camera.position.length()).toBeGreaterThan(1);
  expect(ctx.count("stroke")).toBeGreaterThan(100);
  expect(run.feed.lines.slice(0, 3)).toMatchInlineSnapshot(`
    [
      "4:59.8 Right hand pushes stones 629, 630 and 632 (4 pushes in 0.6 s)",
      "5:01.6 Right hand carries stone 643",
      "5:01.6 Right hand lifts stone 643",
    ]
  `);

  const top = await start({
    recording: recordingPath("dry1-0296-0306-full"),
    pace: "none",
    camera: "top",
    webgl: false,
    context2d: ctx,
  });
  expect(top.updates).toBeGreaterThan(33);
});

// dry1-0018-0153's tray 1: the stones removed as it arrived, the world ids added as it left, and the stones it arrived
// with that moved (labelled on both sides)
const REMOVED = ["105", "112", "117", "121", "125", "126", "127", "128", "129", "130", "87"];
const ADDED = ["151", "177", "193", "201", "203", "246", "249", "278", "279", "280", "281", "282", "284"];
const MOVED = ["104", "118", "120", "85", "86", "88", "89", "90"];

it("shows a tray's report with TrayReportView: labels on its stones, the sides' titles, a legend, its text", async () => {
  document.body.innerHTML =
    '<span id="status"></span><div id="report-titles"></div><canvas id="report-scene"></canvas>' +
    '<div id="report-labels"></div><ul id="report-legend"></ul><pre id="report-text"></pre>';
  const run = await startReport({ recording: recordingPath("dry1-0018-0153"), tray: 1, document, webgl: false });
  expect(run.renderer).toBeNull();
  expect(document.getElementById("status")?.textContent).toBe(
    "dry1-0018-0153 · tray 1 · 0:22.5 to 2:24.0 · 42 stones as it arrived, 44 as it left",
  );
  expect(`${document.getElementById("report-text")?.textContent}\n`).toBe(
    readText("golden/dry1-0018-0153.reports.txt"),
  );
  // a label on each of the 11 removed stones as it arrived, of the 13 added ones as it left, and of the 8 moved ones on
  // both sides, two lines: the stone's label (its id after the tray's number), and under it its change's confidence from
  // the report
  const labels = [...document.querySelectorAll<HTMLElement>("#report-labels span")];
  const idOf = (l: HTMLElement): string => l.textContent.split("\n")[0] as string;
  expect(run.labels).toBe(40);
  expect(labels.map(idOf).sort()).toEqual([...REMOVED, ...ADDED, ...MOVED, ...MOVED].sort());
  const report = run.view.report as TrayReport;
  const text = (c: TrayChange): string => `${c.stone.split("-").slice(2).join("-")}\n${c.confidence.toFixed(2)}`;
  const changes = [...report.removed, ...report.added, ...report.moved, ...report.moved]; // a move on both sides
  expect(labels.map((l) => l.textContent).sort()).toEqual(changes.map(text).sort());
  // each label shows the change of its role: the removal's on the left, the addition's on the right, the move's on both
  for (const [role, ids] of [
    ["removed", REMOVED],
    ["added", ADDED],
    ["moved", MOVED],
  ] as const) {
    for (const l of labels.filter((x) => ids.includes(idOf(x)))) {
      const change = report[role].find((c) => c.stone.endsWith(`-${idOf(l)}`)) as TrayChange;
      expect(l.textContent).toBe(`${idOf(l)}\n${change.confidence.toFixed(2)}`);
    }
  }
  const percent = (v: string): number => Number(v.replace("%", ""));
  for (const l of labels) {
    for (const v of [l.style.left, l.style.top]) expect(percent(v)).toBeGreaterThan(0);
    for (const v of [l.style.left, l.style.top]) expect(percent(v)).toBeLessThan(100);
  }
  // the removed ones on the left half, the added ones on the right, each moved one on both
  const side = (ids: string[]): number[] =>
    labels.filter((l) => ids.includes(idOf(l))).map((l) => percent(l.style.left));
  expect(Math.max(...side(REMOVED))).toBeLessThan(50);
  expect(Math.min(...side(ADDED))).toBeGreaterThan(50);
  expect(side(MOVED).filter((x) => x < 50)).toHaveLength(MOVED.length);
  expect(side(MOVED).filter((x) => x > 50)).toHaveLength(MOVED.length);
  const titles = [...document.querySelectorAll<HTMLElement>("#report-titles span")];
  expect(titles.map((t) => t.textContent)).toEqual(["as it arrived 0:22.5", "as it left 2:24.0"]);
  expect(percent(titles[0]!.style.left)).toBeLessThan(50);
  expect(percent(titles[1]!.style.left)).toBeGreaterThan(50);
  expect([...document.querySelectorAll("#report-legend li")].map((l) => l.textContent)).toEqual([
    "removed",
    "added",
    "moved",
    "sure",
    "not sure",
    "unclear (translucent)",
    "where a removed stone was",
    "not on the tray",
  ]);
  // the canvas has the camera's shape (a browser keeps "2.29"; happy-dom writes "2.29 / 1")
  const canvas = document.getElementById("report-scene") as HTMLCanvasElement;
  expect(parseFloat(canvas.style.aspectRatio)).toBeCloseTo(run.camera.aspect);
  await expect(
    startReport({ recording: recordingPath("dry1-0018-0153"), tray: 9, document, webgl: false }),
  ).rejects.toThrow("the recording has no tray 9 that arrived and left");
});
