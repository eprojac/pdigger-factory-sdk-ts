/**
 * The three levels on one unit: the Interpreter (high), streams (mid), and one method per operation plus the codec
 * (low). Everything here only reads: no control is sent. The Interpreter and the stream count as viewers (the
 * default), so the unit interprets while they run.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/levels.ts
 */
import { FactoryClient, codec } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");

// #region high
// High level: typed events, activities and plain sentences.
const interpreter = factory.interpreter(); // a viewer (the default), so the unit interprets while it runs
const lift = await interpreter.waitFor("lift", { timeout: 60_000 });
console.log("high:", lift.describe());
const { hands, stones } = interpreter.state;
console.log(`high: left hand ${hands.left.state}, right hand ${hands.right.state}, ${stones.size} stones`);
interpreter.close();
// #endregion high

// #region mid
// Mid level: frames with automatic resume, backfill of late layers and world revisions, plus side events.
for await (const item of factory.streams.frames({ layers: ["world", "overlay"] })) {
  if (item.kind !== "frame") continue; // clock, worker, gap and reset events
  const { g, world, overlay } = item.frame;
  console.log(`mid: frame ${g}: ${world?.stones.length ?? 0} stones, ${overlay?.items.length ?? 0} detections`);
  break; // leaving the loop closes the stream
}
// #endregion mid

// #region low
// Low level: one typed method per operation, typed errors, and decoders for the packed layers.
const frame = await factory.api.getFrame("latest", { layers: ["overlay"] });
const regions = frame.overlay?.regions;
if (regions) {
  const tray = codec.decodeU8Map(regions.tray, regions.rows, regions.cols); // rows x cols, row-major
  console.log(
    `low: frame ${frame.g}: tray covers ${tray?.filter((v) => v > 0).length} of ${regions.rows * regions.cols} cells`,
  );
}
const scene = await factory.api.renderScene3d({ g: frame.g, surface: "vertices" });
const mesh = codec.decodeSurfaceMesh(scene.surface);
console.log(
  `low: scene ${scene.g}: ${scene.stones.length} stones, surface of ${(mesh?.indices.length ?? 0) / 3} triangles`,
);
// #endregion low
