# Low level: one call per operation

Under the interpreter, `factory.api` has one async method for each of the unit's 32 operations, named after its
`operationId` and returning a typed model of its reply (fields the SDK does not know are kept), and `codec` decodes
what the replies pack: maps, bitsets, depth, joints and stone tuples. Use this level to build what the interpreter does
not: your own drawing, a dashboard of the unit, a bridge to your MES or ERP, a check of the model.

The code is [examples/tutorial-low-level.ts](../../examples/tutorial-low-level.ts), one step after another; run it
with `node examples/tutorial-low-level.ts`, or give it a frame (`... tutorial-low-level.ts 1510`). Every step only
reads, or sends a dry run. The full list of operations is in [low-level.md](../low-level.md#one-method-per-operation).

## 1. Is it ready, and how fast?

<!-- snippet: examples/tutorial-low-level.ts#ready -->
```ts
const ready = await api.getReady(); // while it starts: FactoryError not_ready, and what it waits for
const { worker } = await api.getStatus();
console.log(`ready ${ready.ready}, worker ${worker.state}: ${worker.fps} frames a second, ${worker.frame_ms} ms each`);
```

The status also has the time of each stage of the model (`worker.stage_ms`), the frames the unit keeps (`retained`),
and how many viewers, long-polls and streams it serves. `getHealth()` is the short answer for a load balancer, and
`getMetrics()` the Prometheus text with its samples parsed.

## 2. The model, and what to draw with

<!-- snippet: examples/tutorial-low-level.ts#model -->
```ts
const model = await api.getModel();
console.log(`checkpoint ${model.checkpoint} on ${model.backend}: ${model.engines.length} engines`);
const topology = await api.getTopology();
const colours = Object.keys(topology.colors).length; // named colours: stones, hands, the tray, ...
console.log(`${topology.joints} joints, ${topology.bones.length} bones, ${colours} colours`);
```

The model is the unit's cascade, engine by engine with its hash; the topology is what every drawing is made with: the
skeleton's bones, which joints are the wrists and the fingertips, and the colours the unit's own page uses.

## 3. A stone's track, and the focus

<!-- snippet: examples/tutorial-low-level.ts#stone -->
```ts
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
```

The focus highlights one stone for every viewer of the unit, so here it is a dry run: the unit checks the request and
answers with the state it would have, without changing it. The same holds for every control of the shared session
(`factory.session.watch`, `seek`, `play`, `pause`, `focus`): each takes `dryRun: true`, and `factory.session.clock()`
maps the session's media time to wall clocks ([concepts.md](../concepts.md#the-shared-session)).

A request the unit refuses rejects with a `FactoryError`: its stable `code`, the HTTP `status`, and the `field` it
refused ([examples/errors.ts](../../examples/errors.ts)):

<!-- snippet: examples/errors.ts#errors -->
```ts
try {
  await factory.api.getFrame(0); // the unit keeps only its newest frames
} catch (err) {
  if (!isFactoryError(err, "not_retained")) throw err;
  console.log(`frame 0 is gone: the unit keeps frames ${err.retained?.g0} to ${err.retained?.g1}`);
}

try {
  const live = await factory.live();
  console.log(`live camera: ${live.title}`);
} catch (err) {
  if (!isFactoryError(err, "live_unavailable")) throw err;
  console.log("this unit lists no camera: the shared session plays recordings");
}

try {
  await factory.api.getVideo("no-such-video");
} catch (err) {
  if (!isFactoryError(err)) throw err;
  console.log(`${err.status} ${err.code} (field ${err.field}): ${err.message}; retryable: ${err.isRetryable()}`);
}
```

## 4. A frame, and the model's maps of it

A frame carries the layers you ask for: `world` (the stones, hands and events of the world model), `cards` (the hand
cards' titles), `overlay` (the model's 2-D view: regions, boxes, joints), `scene` (the 3-D scene) and `raw`.

<!-- snippet: examples/tutorial-low-level.ts#frame -->
```ts
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
```

`g` is a frame of the grid (`"latest"` for the newest); the unit keeps the newest frames of the session (512 on the
20.20 unit), and an older one rejects with `not_retained`, which says what is kept.

## 5. Draw lists, ready to paint

The unit also sends what its own views draw: the 2-D overlay in video pixels, as shapes with their style, and the 3-D
scene in scene units. Paint them with any library; no SDK code is needed between the reply and your canvas.

<!-- snippet: examples/tutorial-low-level.ts#draw -->
```ts
const overlay = await api.renderOverlay2d({ g: frame.g, draw: "primitives" }); // shapes, styled, in video pixels
const p = overlay.primitives;
const [width, height] = overlay.native_wh;
const shapes = `${p?.polygons?.length ?? 0} polygons, ${p?.segments?.length ?? 0} segments, ${p?.circles?.length ?? 0} circles`;
console.log(`overlay of g ${overlay.g}: ${shapes} at ${width} x ${height} px`);
const scene = await api.renderScene3d({ g: frame.g, surface: "compact" }); // stones, hands and the plane, scene units
console.log(`scene of g ${scene.g}: ${scene.stones.length} stones, ${scene.skeleton.bones?.length ?? 0} bones`);
```

Each polygon has its `points` and `stroke`, each segment its `from`, `to` and `color`, each circle its `at`, `r` and
`fill`. With `surface: "vertices"` the scene also sends the work surface as a mesh, which `codec.decodeSurfaceMesh`
unpacks ([examples/levels.ts](../../examples/levels.ts)).

## 6. Stone shapes, drawn by hand

To draw it your own way, start from the world layer: each stone's outline is a polygon in video pixels, and the
topology gives the colours.

<!-- snippet: examples/tutorial-low-level.ts#stones -->
```ts
const outlines = stones.map((stone) => ({
  fill: stone.detected ? topology.colors.stones : topology.colors.stoneBox,
  points: stone.outline, // [x, y] in video pixels: hand them to a canvas, SVG or any drawing library
}));
const points = outlines.reduce((n, o) => n + o.points.length, 0);
console.log(`g ${frame.g}: ${outlines.length} outlines, ${points} points`);
```

## 7. Hands and bones, drawn by hand

The overlay layer has the 70 joints of the body and both hands, in content units; the topology names the bones and
the wrists, and `codec.uvToPx` turns a joint into video pixels.

<!-- snippet: examples/tutorial-low-level.ts#hands -->
```ts
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
```

In the fixture dry1-0296-0306-full, at frame 1510 (5:01.2), that is 50 of the 62 bones, with the left hand on a stone
and the right one holding one.

## 8. A frame's image data

<!-- snippet: examples/tutorial-low-level.ts#image -->
```ts
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
```

A recording's video is served by byte ranges, so any player can seek in it:
`api.getVideoMedia(id, { range: [0, 1023] })` gives the first KiB with its `status`, `etag` and the file's `size`,
and `openVideoMedia` streams it. On a live camera there is no video: every frame comes with the camera's own picture,
the JPEG it was interpreted from (`api.getFramePicture(g, { session })`, or `factory.session.picture()`; see
[Live cameras](03-live-cameras.md)).

## 9. Frames as they are made

The streams are the level between the operations and the interpreter: the frames themselves, resumed with
`Last-Event-ID` when the connection drops, in order, with the side events between them (clock, worker, gap, reset).
From [examples/streams.ts](../../examples/streams.ts):

<!-- snippet: examples/streams.ts#frames -->
```ts
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
```

Where a stream cannot stay open, the long-poll gives the same frames:

<!-- snippet: examples/streams.ts#poll -->
```ts
// the same frames by long-poll, for places where streaming responses do not get through
let polled = 0;
for await (const item of factory.streams.poll({ layers: ["world"], limit: 4 })) {
  if (item.kind !== "frame") continue;
  console.log(`polled frame ${item.frame.g}, cursor ${item.frame.cursor}`);
  if (++polled === 3) break;
}
```

and the raw packets are the model's output before the world:

<!-- snippet: examples/streams.ts#raw -->
```ts
// raw packets (sip1): the model's own output before the Stable sim, for your own post-processing
for await (const item of factory.streams.rawPackets({ format: "ndjson" })) {
  if (item.kind !== "packet") continue;
  console.log(`packet of frame ${item.packet.g}: ${item.packet.stones.items?.length ?? 0} stone detections`);
  break;
}
```

More in [streams.md](../streams.md).

## Next

- [Live cameras](03-live-cameras.md): select a plant camera and follow it.
- [TypeScript](04-typescript.md): runtimes, async iteration, errors, the three.js views and testing in this SDK.
