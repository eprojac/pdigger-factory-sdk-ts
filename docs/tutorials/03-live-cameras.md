# Live cameras: one source at a time

A unit shows one source at a time, to everybody: a recording it plays, or a live camera of a plant rig. How many of
each it offers depends on the distribution of the unit (a unit can list several recordings and several cameras, or
only one of them), but there is always exactly one selected, on the one shared session that the unit's page, the
operators' screens and every SDK client follow. Selecting a camera changes what every viewer sees.

The code is [examples/sources.ts](../../examples/sources.ts) and
[examples/live-camera.ts](../../examples/live-camera.ts).

## 1. The sources

<!-- snippet: examples/sources.ts#sources -->
```ts
for (const source of await factory.sources()) {
  const length = source.duration === null ? "live" : `${Math.round(source.duration)} s`;
  console.log(`${source.id}: ${source.title} (${source.kind}, ${length}, seekable: ${source.seekable})`);
}

const live = await factory.live().catch((err: unknown) => {
  if (isFactoryError(err, "live_unavailable")) return null; // a unit that lists recordings only
  throw err;
});
console.log(live === null ? "this unit lists no camera" : `live camera: ${live.title} (${live.station})`);

// the session's clock maps media time to the server's and this machine's wall clock
const clock = await factory.session.clock({ samples: 3 });
const t = clock.mediaTimeNow();
console.log(`the session plays ${clock.state.video}, now at ${fmt(t, 1)} s of media (live: ${clock.isLive})`);
const local = clock.localWallOf(t); // null only for a rate of 0
console.log(`that moment on this machine's clock: ${local === null ? "-" : new Date(local * 1000).toISOString()}`);
```

A recording has a duration and can be sought in; a camera (`kind` camera, `isLive`) has neither: it is the camera
itself, at rate 1.0. The cameras are listed after the recordings, by their serials; `factory.cameras()` returns only
them, and `factory.live()` the first (or rejects with `live_unavailable`). The session's clock maps its media time to
the server's wall clock and to this machine's.

## 2. Watch a camera, see its pictures, follow it

<!-- snippet: examples/live-camera.ts#live -->
```ts
const camera = serial === undefined ? await factory.live() : await factory.source(serial); // the first camera, or that
await factory.session.watch(camera); // connecting, then warming up on the camera's first 3 s
const state = await factory.session.untilLive();
const lag = state.live?.lag ?? 0;
console.log(`${camera.id} (${camera.title}) is live: session ${state.session}, ${fmt(lag, 2)} s behind the camera`);

const picture = await factory.session.picture(); // the JPEG the newest frame was interpreted from
console.log(`frame g ${picture.g}: a ${picture.jpeg.length}-byte JPEG`);

for await (const event of factory.interpreter().events()) {
  const at = event.wall === null ? "--:--:--" : new Date(event.wall * 1000).toISOString().slice(11, 19);
  console.log(`${at} UTC  ${event.describe()}`); // on a camera, the wall time is the timestamp that matters
}
```

`watch` starts a new session on the camera. The unit connects to it, runs the interpreter on its first seconds of frames
to warm the world up (those frames are never shown or stored), and then shows it live: the session's `state.live.phase`
goes from `connecting` to `warming` to `live`, and `untilLive()` waits for the last. The unit interprets only while
someone watches: the watch counts as a viewer for 15 s, and the interpreter's stream opened next keeps the camera live.

Every frame of a camera comes with the camera's own picture, the JPEG the model saw: `session.picture()` gives the
newest one, `session.picture(g)` that of frame `g`, and the unit keeps the newest 64.

The interpreter follows a camera exactly as it follows a recording. On a camera, media time only counts the seconds
since the session started, so the time that matters is each event's wall time (`event.wall`, in seconds since 1970).

To check a watch without changing anything, send it as a dry run:

<!-- snippet: examples/sources.ts#dry-watch -->
```ts
const target = live ?? (await factory.sources())[0]; // the first camera, or else the first recording
if (target !== undefined) {
  const would = await factory.session.watch(target, { dryRun: true }); // the unit checks it; nothing changes
  console.log(`watching ${target.id} would start session ${would.session} at ${fmt(would.anchor_media, 1)} s`);
}
```

## What differs on a camera

- A camera cannot be sought: `watch(camera, { at })` and `session.seek()` reject with `not_seekable` without sending the
  select or the seek (`seek()` reads the shared state first, since another viewer may have switched the session).
  `pause` freezes the shared view and `play` goes on at the live edge, after a new warm-up.
- A camera's frames come at the camera's own rate as far as the unit's worker keeps up (on the 20.20 unit 1.6 to 3.9 a
  second with build `claude-20261120-looks1` and about 3.6 with build `claude-20261122-hr4x1`; a recording gives 5 per
  media second), and `g` counts them from the start of the session.
- If no camera is offered, `factory.live()` rejects with `live_unavailable`; `untilLive()` rejects with
  `live_timeout` when the camera does not come up in time (30 s by default, `{ timeout }` in ms).

## 3. Test it without a camera

`FakeFactory.create({ recording, live: true })` offers a camera, `cam-live`, made from the recording, with its phases
and pictures on the fake's clock ([examples/testing.ts](../../examples/testing.ts)):

<!-- snippet: examples/testing.ts#camera -->
```ts
const withCamera = await FakeFactory.create({
  recording: "fixtures/recordings/dry1-0000-0130.ndjson.gz",
  live: true,
  clock: new InstantClock(),
});
const viewer = withCamera.client({ clock: withCamera.clock }); // one clock: untilLive() moves the fake's
await viewer.session.watch(await viewer.live()); // connecting
const live = await viewer.session.untilLive(); // warming on the first 3 s of frames, then live
console.log(`${live.video} is live, ${live.live?.lag} s behind the camera`);
const picture = await viewer.session.picture(); // the newest frame's camera picture
console.log(`frame ${picture.g} has a ${picture.jpeg.length}-byte picture`);
viewer.close();
withCamera.close();
```

The details are in [concepts.md](../concepts.md#sources-and-the-live-cameras) and [testing.md](../testing.md).
