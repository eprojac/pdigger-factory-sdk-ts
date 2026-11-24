/**
 * The low-level tutorial (docs/tutorials/02-low-level.md) in one program: one call per API operation, typed replies,
 * and the codec for what the replies pack. Every step only reads, or sends a dry run that changes nothing. The frame
 * is the newest one, or the `g` given after the URL.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/tutorial-low-level.ts [g]
 */
import { FactoryClient, clock, codec } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
const api = factory.api;
const g: number | "latest" = process.argv[2] ? Number(process.argv[2]) : "latest";

// #region ready
const ready = await api.getReady(); // while it starts: FactoryError not_ready, and what it waits for
const { worker } = await api.getStatus();
console.log(`ready ${ready.ready}, worker ${worker.state}: ${worker.fps} frames a second, ${worker.frame_ms} ms each`);
// #endregion ready

// #region model
const model = await api.getModel();
console.log(`checkpoint ${model.checkpoint} on ${model.backend}: ${model.engines.length} engines`);
const topology = await api.getTopology();
const colours = Object.keys(topology.colors).length; // named colours: stones, hands, the tray, ...
console.log(`${topology.joints} joints, ${topology.bones.length} bones, ${colours} colours`);
// #endregion model

// #region stone
const world = await api.getWorld();
const first = world.stones[0]; // none between trays, or on a camera with nothing in view
if (first === undefined) {
  console.log("no stone in the newest world");
} else {
  const track = await api.getStone(first.id); // its path, from frame first_g to last_g
  console.log(`stone ${track.id}: ${track.path2d.length} points, g ${track.first_g} to ${track.last_g}`);
  const focus = await api.putFocus(track.id, { dryRun: true }); // the unit checks it; nothing changes
  console.log(`focus on stone ${track.id}: dry run ${focus.dry_run}`);
}
// #endregion stone

// #region frame
const frame = await api.getFrame(g, { layers: ["world", "cards"] });
const stones = frame.world?.stones ?? [];
const families = [...new Set(stones.map((s) => s.family))].sort();
console.log(`frame g ${frame.g} at ${clock(frame.t)}: ${stones.length} stones, ${families.join(", ")}`);
const packet = await api.rawPacket(frame.g); // what the model saw, before the world made sense of it
const [rows = 0, cols = 0] = packet.maps.grid; // the model's grid of cells
const tray = codec.decodeZlibMap(packet.maps.tray, rows, cols); // one byte a cell
const stoneMap = codec.decodeZlibMap(packet.maps.stone, rows, cols);
const cells = (map: Uint8Array | null): number => map?.filter((v) => v > 0).length ?? 0;
console.log(`maps of g ${packet.g}: ${rows} x ${cols} cells, ${cells(tray)} of the tray, ${cells(stoneMap)} of stones`);
// #endregion frame

// #region draw
const overlay = await api.renderOverlay2d({ g: frame.g, draw: "primitives" }); // shapes, styled, in video pixels
const p = overlay.primitives;
const [width, height] = overlay.native_wh;
const shapes = `${p?.polygons?.length ?? 0} polygons, ${p?.segments?.length ?? 0} segments, ${p?.circles?.length ?? 0} circles`;
console.log(`overlay of g ${overlay.g}: ${shapes} at ${width} x ${height} px`);
const scene = await api.renderScene3d({ g: frame.g, surface: "compact" }); // stones, hands and the plane, scene units
console.log(`scene of g ${scene.g}: ${scene.stones.length} stones, ${scene.skeleton.bones?.length ?? 0} bones`);
// #endregion draw

// #region stones
const outlines = stones.map((stone) => ({
  fill: stone.detected ? topology.colors.stones : topology.colors.stoneBox,
  points: stone.outline, // [x, y] in video pixels: hand them to a canvas, SVG or any drawing library
}));
const points = outlines.reduce((n, o) => n + o.points.length, 0);
console.log(`g ${frame.g}: ${outlines.length} outlines, ${points} points`);
// #endregion stones

// #region hands
const view = await api.getFrame(frame.g, { layers: ["overlay", "cards"] });
const [w = 0, h = 0] = (await api.getVideo(view.video)).nativeWh;
const joints = codec.toJoints(view.overlay?.joints); // u, v, visibility, x, y, z, or null
const px = joints.map((j) => (j ? codec.uvToPx(j.u, j.v, w, h) : null));
const bones = codec.bonesOf(topology).filter(([a, b]) => px[a] && px[b]); // lines to draw, in video pixels
console.log(`g ${view.g}: ${bones.length} of ${topology.bones.length} bones`);
for (const hand of ["left", "right"] as const) {
  const wrist = px[codec.wristJoint(topology, hand) ?? -1];
  const where = wrist ? `wrist at ${wrist[0].toFixed(0)}, ${wrist[1].toFixed(0)} px` : "not in view";
  console.log(`${hand} hand: ${view.cards?.[hand]?.title ?? "no card"}, ${where}`);
}
// #endregion hands

// #region image
const png = await api.getFrameRaster(frame.g, "regions"); // also "mask" and "depth"
console.log(`regions of g ${frame.g}: a ${png.length}-byte PNG`);
const video = await api.getVideo(frame.video);
if (video.isLive) {
  // a camera has no video: each frame comes with the JPEG it was interpreted from
  const picture = await api.getFramePicture(frame.g, { session: frame.session });
  console.log(`picture: a ${picture.jpeg.length}-byte JPEG of g ${picture.g}`);
} else {
  const [pw, ph] = video.entry.proxy_wh; // a recording's picture is its video at frame.t, as the catalog lists it
  console.log(`picture: ${video.proxy} at ${clock(frame.t)}, ${pw} x ${ph}`);
}
// #endregion image
