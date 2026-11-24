/**
 * Mid level: frames over SSE with resume, backfill and revisions; the long-poll; raw packets. Read-only streams; each
 * counts as a viewer while it is open (the default), so the unit interprets meanwhile.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/streams.ts
 */
import { FactoryClient } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");

// #region frames
let frames = 0;
for await (const item of factory.streams.frames({ layers: ["world"], backfill: true })) {
  if (item.kind === "clock")
    console.log(`clock: ${item.state.video} session ${item.state.session}, rate ${item.state.rate}`);
  else if (item.kind === "worker") console.log(`worker: ${item.worker.state}`);
  else if (item.kind === "gap") console.log(`gap: ${item.count} items skipped`);
  else if (item.kind === "reset") console.log(`reset: the unit restarted (boot ${item.boot})`);
  else {
    const { g, world } = item.frame;
    const tag = item.isRevision ? " (revised)" : item.isBackfill ? " (late world read back)" : "";
    console.log(`frame ${g} [${item.id}]: ${world?.events.length ?? 0} events${tag}`);
    if (++frames === 3) break; // leaving the loop closes the connection
  }
}
// #endregion frames

// #region poll
// the same frames by long-poll, for places where streaming responses do not get through
let polled = 0;
for await (const item of factory.streams.poll({ layers: ["world"], limit: 4 })) {
  if (item.kind !== "frame") continue;
  console.log(`polled frame ${item.frame.g}, cursor ${item.frame.cursor}`);
  if (++polled === 3) break;
}
// #endregion poll

// #region raw
// raw packets (sip1): the model's own output before the Stable sim, for your own post-processing
for await (const item of factory.streams.rawPackets({ format: "ndjson" })) {
  if (item.kind !== "packet") continue;
  console.log(`packet of frame ${item.packet.g}: ${item.packet.stones.items?.length ?? 0} stone detections`);
  break;
}
// #endregion raw
