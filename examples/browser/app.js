// The viz example: a Replay of a recording drives SceneView, OverlayCanvas and EventFeed (pdigger-factory-sdk/viz);
// its report mode shows one tray's report with TrayReportView. The page (index.html) runs it in a browser;
// test/browser-example.test.ts runs it in Node without WebGL.
import * as THREE from "three";
import { Replay, clock } from "pdigger-factory-sdk";
import {
  EventFeed,
  OverlayCanvas,
  REPORT_COLORS,
  SceneView,
  TrayReportView,
  attachToClient,
} from "pdigger-factory-sdk/viz";

/**
 * @typedef {object} StartOptions
 * @property {string | Uint8Array} recording a recording URL (or path / bytes), `.ndjson` or `.ndjson.gz`
 * @property {Document} [document] the page (default: the global document)
 * @property {"realtime" | "none"} [pace] `realtime` (default): frames at their media times; `none`: as fast as read
 * @property {number} [speed] real-time speed factor (default 1)
 * @property {number} [until] stop after this grid frame (default: the end of the recording)
 * @property {"source" | "three" | "top"} [camera] 3-D camera preset (default `source`: the recording camera's pose)
 * @property {boolean} [webgl] draw the 3-D view with WebGL (default true; false in tests)
 * @property {object} [context2d] a 2-D context to draw the overlay on instead of the canvas's (tests)
 */

/** @param {StartOptions} options */
export async function start(options) {
  const doc = options.document ?? document;
  const status = doc.getElementById("status");
  const sceneCanvas = doc.getElementById("scene");
  const overlayTarget = options.context2d ?? doc.getElementById("overlay"); // a canvas (tests: a 2-D context)
  const feedElement = doc.getElementById("feed");
  const renderer = options.webgl === false ? null : new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true });
  renderer?.setPixelRatio(globalThis.devicePixelRatio ?? 1);
  const until = options.until ?? Number.POSITIVE_INFINITY;

  // #region viz
  const replay = await Replay.open(options.recording); // or follow a unit: attachToClient(views, factory)
  const source = replay.header?.source ?? null; // the catalog entry: camera pose, native size

  const scene = new SceneView(); // one THREE.Group: board, stones, skeleton, wrist rings, surface, focus path
  const overlay = new OverlayCanvas(overlayTarget, { nativeWh: source?.native_wh ?? [1920, 1080] });
  const feed = new EventFeed(feedElement, { max: 400, skip: ["new", "confirm", "freeze"] });

  const three = new THREE.Scene();
  three.background = new THREE.Color(0x171c22);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, 3, 2);
  three.add(new THREE.HemisphereLight(0xffffff, 0x404850, 2.2), sun, scene.group);
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.01, 50);

  const attachment = attachToClient([scene, overlay, feed], replay, {
    pace: options.pace ?? "realtime", // frames at their media times
    speed: options.speed ?? 1,
    onUpdate: ({ frame, state }) => {
      if (frame === null) return; // the final update of a replay
      if (camera.userData.preset === undefined && frame.world) {
        camera.userData.preset = options.camera ?? (source?.camera ? "source" : "three");
        scene.applyCamera(camera, camera.userData.preset, source); // after the first world: the board is known
      }
      renderer?.render(three, camera);
      status.textContent =
        `${replay.header?.name ?? "recording"} · frame ${frame.g} · ${clock(frame.t)} · ${state.stones.size} stones · ` +
        `left ${state.hands.left.state ?? "-"}, right ${state.hands.right.state ?? "-"}`;
      if (frame.g >= until) attachment.stop();
    },
  });
  await attachment.done;
  // #endregion viz
  return { replay, scene, overlay, feed, camera, three, renderer, updates: attachment.count };
}

/**
 * @typedef {object} ReportOptions
 * @property {string | Uint8Array} recording a recording URL (or path / bytes), `.ndjson` or `.ndjson.gz`
 * @property {number} tray the tray's number: the first tray of that number that arrived and left
 * @property {Document} [document] the page (default: the global document)
 * @property {boolean} [webgl] draw the view with WebGL (default true; false in tests)
 */

/**
 * The report mode: one tray's report from straight above with TrayReportView, the tray as it arrived and as it left,
 * with HTML labels in the role colours, the two sides' titles, a legend and the report's text.
 * @param {ReportOptions} options
 */
export async function startReport(options) {
  const doc = options.document ?? document;
  const status = doc.getElementById("status");
  const canvas = doc.getElementById("report-scene");
  const labelLayer = doc.getElementById("report-labels");
  const renderer = options.webgl === false ? null : new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer?.setPixelRatio(globalThis.devicePixelRatio ?? 1);

  // #region report
  const replay = await Replay.open(options.recording);
  // one pass: every tray of the recording, with its report once it has left
  const tray = (await replay.trays()).find((t) => t.n === options.tray && t.report() !== null);
  if (tray === undefined) throw new Error(`the recording has no tray ${options.tray} that arrived and left`);
  // another: the world at its arrival point and at its leaving point
  const worlds = new Map();
  for await (const frame of replay.frames()) {
    const point = frame.g === tray.arrived.g || frame.g === tray.leaving.g;
    if (point && frame.session === tray.session && frame.world && !worlds.has(frame.g)) worlds.set(frame.g, frame);
    if (worlds.has(tray.arrived.g) && worlds.has(tray.leaving.g)) break;
  }

  const view = new TrayReportView(); // two SceneViews side by side: as it arrived, as it left
  view.show(tray, worlds.get(tray.arrived.g), worlds.get(tray.leaving.g));
  const three = new THREE.Scene();
  three.add(new THREE.HemisphereLight(0xffffff, 0x5a6470, Math.PI), view.group); // the roles' own colours on top
  const size = view.bounds().getSize(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(18, size.x / size.z, 0.01, 100);
  view.applyCamera(camera, "top"); // straight down on both sides

  // a label on each stone removed, added or moved: HTML over the canvas, in its role's colour, two lines: the stone's
  // label, and under it its change's confidence from the report (a moved stone has its move's on both sides)
  for (const label of view.labels()) {
    const change = view.report[label.mark.role].find((c) => c.stone === label.mark.stone);
    const p = label.position.clone().project(camera); // -1 to 1 across the canvas
    const tag = labelLayer.appendChild(doc.createElement("span"));
    tag.textContent = `${label.text}\n${change.confidence.toFixed(2)}`; // 117, and 0.98 under it
    tag.style.background = label.color;
    tag.style.left = `${((p.x + 1) / 2) * 100}%`;
    tag.style.top = `${((1 - p.y) / 2) * 100}%`;
  }
  // #endregion report

  three.background = new THREE.Color(0x171c22);
  canvas.style.aspectRatio = String(camera.aspect);
  if (renderer) {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.render(three, camera);
  }
  // the sides' titles, over the middle of each
  const titles = doc.getElementById("report-titles");
  const sides = [
    ["before", `as it arrived ${clock(tray.arrived.t)}`],
    ["after", `as it left ${clock(tray.leaving.t)}`],
  ];
  for (const [side, text] of sides) {
    const b = view.bounds(side);
    const p = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, b.min.z).project(camera);
    const title = titles.appendChild(doc.createElement("span"));
    title.textContent = text;
    title.style.left = `${((p.x + 1) / 2) * 100}%`;
  }
  // the legend: the roles' colours, then how unclear changes, removed places and other stones look
  const legend = doc.getElementById("report-legend");
  const keys = [
    ["removed", `background: ${REPORT_COLORS.removed}`],
    ["added", `background: ${REPORT_COLORS.added}`],
    ["moved", `background: ${REPORT_COLORS.moved}`],
    ["sure", `background: ${REPORT_COLORS.sure}`],
    ["not sure", `background: ${REPORT_COLORS.unsure}`],
    ["unclear (translucent)", `background: ${REPORT_COLORS.added}; opacity: 0.45`],
    ["where a removed stone was", `border: 2px dashed ${REPORT_COLORS.removed}; box-sizing: border-box`],
    ["not on the tray", "background: #7d8790; opacity: 0.4"],
  ];
  for (const [text, swatch] of keys) {
    const item = legend.appendChild(doc.createElement("li"));
    item.appendChild(doc.createElement("i")).setAttribute("style", swatch);
    item.appendChild(doc.createTextNode(text));
  }
  doc.getElementById("report-text").textContent = view.report.describe();
  status.textContent =
    `${replay.header?.name ?? "recording"} · tray ${tray.n} · ${clock(tray.arrived.t)} to ` +
    `${clock(tray.leaving.t)} · ${view.marks.before.size} stones as it arrived, ${view.marks.after.size} as it left`;
  return { replay, tray, view, camera, three, renderer, labels: labelLayer.children.length };
}
