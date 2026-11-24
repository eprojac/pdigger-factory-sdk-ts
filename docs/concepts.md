# Concepts

What the unit serves, in the words the SDK uses. The measured behaviour of the 20.20 unit is in
[BEHAVIOUR-20.20.md](BEHAVIOUR-20.20.md).

## The shared session

A unit runs one interpretation at a time: the **shared session**. Every viewer sees the same one. A select or a seek
starts a new session (a new `session` number); play, pause and focus change the current one. The controls
(`factory.session.watch()`, `seek()`, `play()`, `pause()`, `focus()`, `clearFocus()`) therefore move what every viewer
sees, and their doc comments say so. Each takes `dryRun: true`, which makes the unit validate the control and answer
with the state it would produce, without applying it.

The unit interprets only while someone watches. A stream counts as a viewer unless it is opened with `observe: true`
(`observe=1`). The default of streams and Interpreters is the client's `observe`, false unless the client was made with
`observe: true`: an integration that wants events keeps its interpreter running, and an idle worker interprets nothing
("nobody is watching").

`factory.session.lastState` is the newest shared state the client has seen, without a request: from `state()`,
`clock()`, `watch()`, the replies of the controls (not of dry runs), and the `clock` items of its streams and
Interpreters. Other viewers move the session too, so it can be out of date; `await factory.session.state()` asks.

## Sources and the live cameras

A **source** is what the session can show. The API calls sources videos: `GET /api/v2/videos` is the catalog and
`factory.sources()` returns it as `Source` objects (`id`, `title`, `kind`, `live`, `seekable`, `duration`, `frames`,
`fps`, `hold`, `station`, `nativeWh`, `camera`, ...). There are two kinds:

- **recordings** (`kind: "recording"`): a video file with a `duration` and a `defaultStart`, and you can seek in it.
  The session plays it at the unit's `rate`. On the 20.20 unit that was 0.8 on build `claude-20261114-int17` (its
  worker keeps up at 0.8, not at 1.0, on the full-frame videos); build `claude-20261122-hr4x1` sets the rate itself to
  what its worker keeps up with (a `clock` change by `auto-rate`): dry1 played at 0.75, except for about a minute when
  it went down to 0.63; the fixture `dry1-0000-0130` goes from 0.8 to 0.74 and 0.75 in its first 23 s, and both dry2
  sessions of the fixture `dry2-pause-seek` play at 0.75. When a recording ends, the session moves on to the next
  recording of the catalog (cameras are skipped; after the last recording, the first).
- **live cameras** (`kind: "camera"`, `live: true`, `seekable: false`), listed after the recordings by their serials
  (`CAM00000001`): the camera itself, at rate 1.0, with no duration, no frame count and no media. `hold` is the
  warm-up: the seconds of camera frames the interpreter runs on before the first is shown (3), and `station` the plant
  station of the camera's rig. The 20.20 unit lists the six cameras of the plant rigs. On build
  `claude-20261120-looks1` they streamed at 1.6 to 3.9 frames a second; build `claude-20261122-hr4x1` interprets
  about 3.6 a second on a camera, as fast as its worker goes (274 ms a frame, 35 ms of it decoding the JPEG), live
  about 0.5 s behind the camera. `factory.cameras()` returns the cameras, and
  `factory.live()` the first (or `live_unavailable`).

Watching a camera (`session.watch(camera)`) starts a session at media time 0 and rate 1.0 with `state.live`:
`{ phase, warmup, since, lag }`. The phase is `connecting` until the camera's first frame (the worker's reason says why
when it takes long: `connecting to the camera`, `the camera is not answering`), `warming` while the interpreter runs on
the first `warmup` seconds of frames, which warm the world but are never released, stored or served, and then `live`.
Every change of phase bumps `revision`, so the long-poll and the stream's `clock` event carry it;
`session.untilLive()` waits for `live` by reading the state every 250 ms (`UNTIL_LIVE_POLL_MS`) and rejects with
`live_timeout` after `timeout` ms (30 000 by default). From then on, frames are released as they are interpreted, at
the camera's rate: `g` counts the session's camera frames from 0 (the warm-up's included, so the first shown is about
15 at 5 a second), `t` is a frame's arrival in seconds since `since`, and the playhead runs at 1.0, `lag` behind the
camera. Each live frame comes with the camera's own picture, the JPEG it was interpreted from
(`session.picture(g)`, the newest 64 are kept); a recording has none.

A camera has no time. A select with a `time` is refused (`400 not_seekable`, field `time`), and so is a seek
(`409 not_seekable`, field `video`): `session.watch(camera, { at })` rejects without sending the select (for an id,
after looking it up in the catalog), and `session.seek()` reads the shared state first (another viewer may have switched
the session) and refuses locally when it shows a camera. `pause` freezes the shared view and stops the interpreter on
the camera; `play` continues at the live edge in the same session, after a new warm-up, so `g` jumps (by 5) over the
pause, as it does after a camera stopped answering. `Source.isLive` tells the kinds apart; an entry without `kind`,
`live` or `seekable` (the unit's recordings omit them) is a seekable recording.

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

`SessionClock` maps media time to the server's wall clock and to this machine's: the offset comes from `getSession`
samples, `offset = server_recv - (t_send + t_recv) / 2`, and the sample with the shortest round trip wins. On a camera,
media time only counts the seconds since the session started, and wall times are the useful timestamps: the SDK gives
every event and activity its server wall time (`wall`), `start + (t - anchor_media) / rate`, where `start` is
`max(anchor_wall, hold_until)` while the session plays and `anchor_wall` while it is paused.

## Frames and layers

The unit samples its source on a grid: a **frame** is one grid frame `g`, 5 per media second, with its media time `t`.
Each frame carries up to five **layers**:

| Layer | Schema | What |
|---|---|---|
| `raw` | `sip1` | the model's own output: maps (tray, stone, confidence), depth, boxes, the person's joints, stone tuples |
| `overlay` | `ovl1` | video-space drawing data: regions, the 70 joints, stone items, the mask |
| `scene` | `scn1` | the 3-D scene: the tray plane, the observed surface, the skeleton in scene coordinates, wrist rings |
| `cards` | `crd1` | the hand cards: what each hand is doing, in words ("Holding a stone") |
| `world` | `stw1` | the Stable sim: persistent stones and hands, the board, and the **events** of this frame |

The Interpreter needs only `world` and `cards`. In the public recordings, face keypoints (joints 0-4 and 69) are null,
and appearance masks and depth textures are removed; the models make those fields optional and the decoders return
null for an absent map.

## Cursors, event ids and resume

Every frame the unit releases gets a **cursor**, increasing within one boot of the unit. On the SSE stream each frame's
event id is `<boot>-<cursor>`. A stream that drops reconnects with `Last-Event-ID` and continues after the last frame it
delivered, so a caller sees one stream with nothing lost or repeated. After a restart of the unit (another boot) the
server sends a `reset` event and the stream continues in the new boot; a later reconnect resumes from the cursor the
`reset` named.

## Revisions and late layers

The Stable sim can refine a frame's world after it was released: the frame comes again with a higher `world.rev`, a
**revision**. Streams pass revisions on with `isRevision: true` and drop duplicates; the Interpreter emits only the
revision's new events.

A frame is released at a 300 ms deadline even if its world is not ready; it then lists `missing: ["world"]` and its
world is never pushed. On the 20.20 unit while playing, that was 4.3 % of the frames of dry1 and 3.2 % of dry2 on
build `claude-20261114-int17`, none on the 1088 crop of aug28 and jul30, and every one was there when read again 1.5 s
later; on build `claude-20261122-hr4x1`, 507 of dry1's 9,042 frames (5.6 %), every one read back (the recordings of
dry2, aug28 and jul30 of 22 November come from a replay on a Mac, so they say nothing about the unit). With backfill
(the Interpreter's default) the stream holds such a frame and every frame after it, reads the world with
`GET /frames/{g}` 1.5 s later (up to 3 tries, 1 s apart), and releases them in order with `isBackfill: true`. The cost
is up to about 4 s of latency when a world is late.

## Coordinates and the template gauge

- **Video space**: pixels of the source (`nativeWh`, 1920 x 1080 for dry1), and normalised `u, v` in 0..1;
  `codec.uvToPx(u, v, W, H)` is `u * W - 0.5`.
- **Scene space**: right-handed, `z` up. Stones have `solid.pos` (position), `solid.q` (quaternion `x, y, z, w`) and
  `solid.dims` (length, width, height). three.js is `y` up: `codec.sceneToThree([x, y, z])`
  is `[x, z, -y]`, and `SceneView` does it for you.
- **Units**: the scene is in the gauge of the body template (an adult MHR template), not metres. Distances in the
  Interpreter's text say "units" for that reason.

## Time

`t` is media time in seconds. `wall` (events, activities, the Interpreter's state) is the server's wall clock in epoch
seconds at which the shared playhead shows (or showed) `t`, from the newest clock state of the frame's session:
`max(anchor_wall, hold_until) + (t - anchor_media) / rate` while it plays, `anchor_wall + (t - anchor_media) / rate`
while it is paused; it is null until a clock state of that session is known (the states of the last 8 sessions are
kept, so frames held back for a late layer keep their session's clock after a seek). The text of events and activities
uses media time (`21:17.8`).

After a select or a seek the playhead waits for the worker's warm-up hold and starts at `hold_until` (1.4 s to 2.2 s
after `anchor_wall` on the 20.20 unit), so `wall` starts there too, as `SessionClock` (`mediaTimeAt`, `wallOf`) and the
unit itself do: an event's `wall` equals `SessionClock.wallOf(event.t)`. Both are the server's clock; `localWallOf`
maps to this machine's.
