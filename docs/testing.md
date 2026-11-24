# Testing your code

`pdigger-factory-sdk/testing` is the fake unit this SDK's own tests run on. Give its `fetch` to a client (or take
`fake.client()`) and your code talks to it as to a unit: deterministic, in process, no network, no real waiting.

<!-- snippet: examples/testing.ts#testing -->
```ts
import { FakeFactory, InstantClock } from "pdigger-factory-sdk/testing";

const fake = await FakeFactory.create({ recording: "fixtures/recordings/dry1-0000-0130.ndjson.gz" });
const factory = fake.client({ clock: new InstantClock() });

const lift = await factory.interpreter().waitFor("lift");
console.log(lift.describe());

// fault injection: the next getWorld answers 503 once; the client retries after retry_ms
fake.failNext("getWorld", 1, { status: 503, body: { error: "busy", code: "world_unavailable", retry_ms: 250 } });
const world = await factory.api.getWorld();
console.log(
  `world at frame ${world.g} after ${fake.requests.filter((r) => r.operationId === "getWorld").length} requests`,
);
factory.close();
fake.close();
```

## FakeFactory

| | |
|---|---|
| `FakeFactory.create({ recording, replies, ... })` | a recording (path, URL, bytes or lines) and recorded replies (a `fixtures/api`-style directory or a map) |
| `FakeFactory.fromFixtures(dir, name, options)` | `<dir>/recordings/<name>.ndjson.gz` with the replies of `<dir>/api` |
| `new FakeFactory(lines, options)` | from lines already in memory |
| `fake.fetch`, `fake.client(options)` | the `fetch` implementation; a client on `http://fake.factory` |
| `fake.requests` | every request received, with its `operationId` |
| `fake.state`, `fake.streams` | the shared state now (after a camera's phases that are due); stream connections open now (viewers) |
| `fake.now`, `fake.livePhase`, `fake.clock` | its wall clock now (epoch seconds); the phase of its camera session (`""` on a recording); its clock |
| `await fake.advance(seconds)` | moves the fake's clock on (its own, or a `ManualClock` you gave it): the playhead runs, a camera takes the phases due |

It answers the v2 API:

- `GET` operations from recorded replies where given, otherwise made from the recording: the catalog (a recorded
  `listVideos`, its entries in its order, with the recording's source added: the header's `source`, else an entry made
  from the first frame's video as the unit's recordings are shaped; its default the recording), the session state from
  its clock lines (the first one at the start, each later one as playback passes it: see below), frames, the world, its
  events and stone tracks from its frames, render-ready draw lists from the frames' layers;
- `frames/stream` and `raw/stream` (SSE and NDJSON) over the recording's frames, honouring `layers`, `after`,
  `Last-Event-ID`, `limit` and `max_s`, with the recording's clock and worker lines as side events (an open stream
  moves on to a new program, as the unit's does); the long-poll (on the fake's own clock it answers at once, as Go's
  fake does; on a clock you give the fake, at the end of a recording it waits up to its `wait` on that clock for more:
  frames appended, a control, a close; with `endOfData: "close"` it answers at once);
- controls validated like the server, in its order (a foreign `Origin` is refused with `403 cross_origin`, `dry_run`
  must be 0 or 1, then the body and its fields: the video, a camera, then the time, `"time": null` a time of the wrong
  type; `dryRun` honoured, the server's error codes and messages), applied to the fake's state: a select or a seek
  starts a new fake session over the recording's frames, with the session id one higher, held for the source's `hold`
  (1.4 s without one). A seek whose video is a camera (the one it names, else the one shown) is refused with
  `409 not_seekable` (field `video`); a seek naming a recording is applied, and leaves the camera, as on the unit. A
  control that changes nothing (a play while playing, a second pause) answers the state as it is, with no `clock`
  event.

The session state follows the recording as it plays: its first clock line is the state at the start, and each later
one (on the 20.20 unit's recordings, the rate the unit sets itself, `changed_by: "auto-rate"`) becomes the state when a
stream (frames or raw, SSE or NDJSON) or a long-poll serves what comes after it, so `GET /session` answers the state in
force, as the unit's does. A long-poll reply ends before a clock line not yet taken, so that its `state` is that of
all its frames. A stream that plays the recording from its start again sends its clock lines again, but the state
stays the newest one passed: an Interpreter that joins then reads that state on connect, as a viewer who joins a unit
late does. A control that changes the state, or `fake.appendSide("clock", …)`, ends this: the recording's later clock
lines are then only sent (a control's revision is above theirs). With `connect: "newest"` (the recording has played
to its newest frame) or `live: true`, the state is the last clock line's from the start.

Options: `live: true` adds a live camera, `cam-live` (`LIVE_CAMERA`), shaped as the 20.20 unit's plant cameras
(`kind: "camera"`, `hold` 3, `station`, no media; its `fps` the recording's grid rate, 5.0 without one, its picture
sizes the recording's) and listed after the recording; the session shows it at the start, already live. The camera
behaves as the unit's build live3. It sends the recording's frames as a camera session does: `g` from 0 (`i` the same,
and the raw packet's `g`, `i`, `t` and `cursor` the frame's, the overlay's `prev_g` moved with `g`), `t` the arrival
in seconds since the session started (from `CONNECT_S`, 0.5 s), the recording's sessions end to end, the cursors after
the recording's. A select of it starts a session as the unit does: `connecting` for `CONNECT_S`, then `warming` while
the interpreter runs on the first `hold` (3) seconds of frames, which are never released, then `live` (`LIVE_LAG_S`,
0.25 s, behind the camera), each phase a new `revision` and a `clock` event at its own time. The phases fall due on
the fake's clock while the session plays: every request (and `fake.state`, `fake.livePhase`) takes those that are
due, and nothing runs while it is paused (a pause keeps the phase). A play continues at the live edge
(`now - since - lag`), goes back to `connecting` in its own reply and plans the phases again from then (warming
changes only the phase, as on the unit: its `lag` stays the one before, 0 after a select, the live lag after a play of
a live camera); on a camera that was live, the camera's next frames come after a break (`g` jumps by 5) and after the
frames it sent already (the fake's camera sends its whole run at once when it goes live), and their warm-up is never
released.

On the fake's own clock (no `clock` option), a stream that waits for the camera's next phase moves that clock on to
it, and so does a long-poll for the phases within its `wait`: a long-poll then answers at once, on a camera or at the
end of a recording. On a clock you give the fake, a stream or a long-poll sleeps on that clock until the next phase (a
long-poll at most its `wait`): an `InstantClock` moves on as it sleeps, a `ManualClock` when you advance it. Give the
client the same clock, so that `session.untilLive()` moves it:

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

The newest `KEEP_PICTURES` (64) released frames have a picture (`frames/{g}/image.jpg`: a small grey JPEG with
`FakeFactory <video> g <g>` in a comment segment); an older frame's is `404 not_retained`, without a `retained` window,
as on the unit. Until the camera releases a frame there is no world (`503 world_unavailable` with `retry_ms`, for a
focus too) and the event log has no `oldest_g`; a camera session answers frames, raw packets, the world, its events,
stone tracks and the focus from its own frames, never from recorded replies (recorded render draw lists and rasters
still answer, as on a recording). The camera has no media (`404 not_found`), and a select of it with any `time`,
`null` too, is refused (`400 not_seekable`, field `time`). A recording selected or sought plays at its last clock
line's rate (the start state's without one): one selected after a camera the fake started on plays at 0.8. Unlike the
unit, the fake interprets whether anyone watches or not, and its camera never stops or stalls: a session goes back to
`connecting` only on a play; its connect time and lag are constant, and the worker's status names no camera's reasons
(it runs on the current session, unless the recording has a worker line).

Further options: `endOfData: "close"` ends streams at the end of the data instead of holding them open;
`late: { g, layers }` withholds layers of some frames from streams (listed in `missing`) and serves them on
`GET /frames/{g}`, to exercise backfill; `realtime: true` paces streams at media time on the fake's `clock` (on its
own clock they wait until you advance it); `delay` is a hook before every reply.

Two options make it behave as the 20.20 unit does rather than as a convenient replayer: `connect: "newest"` starts a
stream without a position at the newest frame (a long-poll at cursor 0: the newest `limit` frames) and sends no `clock`
event, so a client has to read `GET /session` itself; `atLimit: "hold"` keeps a stream that sent its `limit` frames or
reached `max_s` open and silent until the client closes it, as the unit does for about 10 s. The defaults (`replay`,
`close`) replay a recording from its start with its clock line first and end a finished stream at once.

Fault injection:

| | |
|---|---|
| `fake.failNext(operationId, n, reply)` | the next `n` requests of an operation (`"*"`: any) get `reply`: a canned reply, the name of a recorded reply (`"getFrame-404"`), or `"network"` (fetch rejects) |
| `fake.dropAfter(k)` | the next stream connection drops after `k` events |
| `fake.injectGap(n)` | the next stream connection starts with a `gap` event |
| `fake.injectReset(boot)` | the unit restarts as `boot`: its cursors start again from 1, open streams break, and the next stream connection starts with a `reset` event (NDJSON skips it) |
| `fake.appendFrames(frames)`, `fake.appendSide(sse, data)` | more frames or side events, as a unit releases them; held streams wake up |
| `fake.close()` | ends every held stream |

## Clocks

Every wait in the SDK (backoff, backfill, pacing, `waitFor` timeouts, long-poll waits, `maxS` and the stream
watchdog) goes through the client's `clock`; only the request timeouts (`timeoutMs`, `connectTimeoutMs`) run on real
timers, as fetch's own do. Without a `clock` option the fake runs on a `ManualClock` of its own, which starts at the
time of the clock line its state starts in (`server_now`: the recording's first clock line's, its last's with
`connect: "newest"` or `live: true`; else the recorded `getSession` reply's; else 1794950000, the fake's epoch) and
stands still unless `fake.advance(seconds)` moves it, or a stream or a long-poll waiting for a camera's next phase does
(playback passing a later clock line does not). A clock you give the fake is its wall clock.

- `InstantClock`: a sleep returns after one macrotask turn (never a real wait) and then moves its time forward by its
  length; a sleep aborted first rejects and moves no time. For tests where time only has to pass.
- `ManualClock`: sleeps wait until `advance(ms)` or `runAll()` passes their time. For exact timing tests.
- `seededRandom(seed)` for deterministic backoff jitter.

## How this SDK is tested

Unit tests in Docker with no network at 100 % coverage, golden tests over every fixture recording, the examples and the
docs' samples run as tests: see [TESTING.md](../TESTING.md).
