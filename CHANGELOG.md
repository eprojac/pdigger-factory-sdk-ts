# Changelog

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the version follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - Unreleased

- Report sheet actions and the tray stones under paper at departure. The optional trayBounds rectangle lets visible faces establish continuity during a partial lift.

## [1.0.1] - 2026-11-26

This patch release also adds a public field, `HandState.away`; by Semantic Versioning a release that adds API is a minor
one (1.1.0).

### Added

- `HandState.away`: true on a hand the unit sends as `free` because it is in contact away from the board, a worker's
  hand busy beside it or a false hand on machinery (build `claude-20261126-handgate1` onwards). Such a hand no longer
  blocks a tray's calm moments, so most trays on the plant cameras arrive (at a stacking station, stones that come and
  go still keep many from arriving).

### Changed

- The summary's hand times add up each frame's own step (SDK-DESIGN.md 4.5): the media time since the session's previous
  frame, when that frame is the grid step before it; otherwise (a frame after a gap, a time step under 0.5 ms or of 2^31
  ms or more, or a time that is not a finite number) the session's previous step, and 0.2 s for a session's first frame.
  On a live camera, whose worker releases two to three and a half frames a second, the hand times of 1.0.0 were a third
  to over a half short; they now add up to about the media time of a session without gaps. On a recorded video a step is
  its grid frame: 0.199 s on dry1 and dry2, whose hand times are now 0.5 % shorter, and 0.2 s on aug28 and jul30
  (aug28's free times are 0.03 s longer). On these four recordings, summaries made with 1.0.0 differ in their hand times
  only.
- A visit continues the open tray only on the camera's word (SDK-DESIGN.md 4.6.1): of the stones no hand holds on the
  stop's first frame, at least one the world detects must have been seen on the tray, and nine tenths of the detected
  ones or of them all. On a plant camera whose boards drive out of view, the world kept some of a board's stones, not
  detected, on the empty conveyor for a few frames: the tray went on and reported all its stones as unclear removals; it
  now leaves with them. Where the world still remembers them when the next stop becomes a visit, that tray arrives with
  them and reports them as unclear removals (4.6.1, known limits). On such cameras the summary's trays line can differ
  from 1.0.0's in any of its counts (trays opened and arrived, stones at arrival, unclear changes, not sure), and so can
  tray numbers and tray-stone ids.
- A live frame's picture: from worker `claude-20261125-dspad1` on, the unit scales a camera picture of another shape to
  fit `native_wh` and centres it (letterboxed); earlier workers stretched it, as the docs of 1.0.0 said.

## [1.0.0] - 2026-11-25

Initial SDK for API v2.2. The reference unit ran build `claude-20261123-speckle7` with four recordings and six plant
cameras. It supplies stone appearance data and surface-pattern comparisons.

### Added

#### Tray reports and tracking

- Read one `TrayReport` for each completed tray, live or from a recording. Each change carries a stone ID, a time, a
  position and a confidence score. Use `JSON.stringify(report)` for the complete data.
  [Report fields](docs/interpreter.md#report-fields).
- Inspect `tray.open` at departure to see the possible identities for each unresolved stone. Tray facts carry reason
  codes. Tray stones expose their arrival and departure positions, touch history and the appearance matches used by
  the report. [Tray tracking](docs/interpreter.md#trays-and-tray-stones).
- Read the unit’s `world.speckle` comparisons (build `claude-20261123-speckle3` onwards). `TraySpeckle` groups
  matches by tray. `StoneSpeckle` gives a stone’s best and second-best scores, match quality and pairing. The
  interpreter keeps the latest 1,024 comparisons.
  [Speckle fields and examples](docs/interpreter.md#the-units-speckle-check).
- Version 8 of the tray rules uses the departure comparison to confirm or recover stone IDs. It records
  `speckle_same`, `speckle_moved` or `speckle_found` as the reason. The evidence can be found, absent or undecided.
  Each change’s confidence also appears in the printed report. [Confidence scores](docs/interpreter.md#confidence).
- If a stone disappears at two calm moments, the SDK can hold its identity open. It restores the identity if the
  stone returns in place and the intervening frames rule out a swap. Hand activity, competing matches, missing
  frames or a stream reset can end the question. Stones with an appearance history follow their own matching rules.
  [Presence and identity rules](spec/SDK-DESIGN.md#461-the-tray-rules).
- A certain removal requires evidence of recent hand contact. Otherwise a lost stone stays available for matching or
  becomes an unclear removal at departure. A visit continues the same tray only if at least 90% of its initial
  stones were already seen on it. Across the four recordings, the SDK found 628 trays and produced 532 reports. A
  video check confirmed 49 of 52 certain removals.
- At departure, the SDK uses appearance, timing and nearby hand activity to decide whether a new tracker ID belongs
  to a lost stone. If the evidence is ambiguous, it records an unclear removal and addition and lists each as a
  candidate for the other. The departure rules also allow some previously tracked stones that have no bounding box
  at departure. In a video check, 32 of the 63 extra stones counted this way were present. Another 25 were false
  detections on empty jul30 boards. [Departure rules](spec/SDK-DESIGN.md#461-the-tray-rules).

#### Client, replay and streams

- `FactoryClient`: one client per unit, with timeouts, retries with full-jitter backoff, typed `FactoryError`s, an
  injectable `fetch`, clock and random source, `observe` and `idleTimeoutMs` defaults, and `using` / `await using`.
- The Interpreter (`factory.interpreter()`): typed events, moves and push bursts, hand states, the stone inventory,
  per-stone tracks (`track()` from its frames, `serverTrack()` from the unit), trays with tray stones (stone ids of the
  SDK's own that are never reused and hold whatever ids the world gives the stone, certain and unclear facts about them
  in `trayFacts()`, and each tray's arrival and leaving points to jump between in `trays()` and `Tray.window()`; a
  second stone first seen on a tray in the same tenth of a second under one world id gets `-2` at the end of its id, a
  third `-3`), the summary and its text, `waitFor`; one shared stream per Interpreter, every iteration cancellable with
  an `AbortSignal`; the shared state read on every (re)connect, so events have wall times; held by the client only while
  its stream is open. Golden-tested on every fixture recording against the golden files in `fixtures/golden/`.
- `Replay`: the Interpreter over a recording (path, URL, bytes or stream; `.ndjson` or `.ndjson.gz`), real-time pacing,
  synchronous passes for recordings in memory, and every tray of a recording (`trays()`).
- Sources and the live cameras (`factory.sources()`, `factory.cameras()`, `factory.live()`, `Source` objects with
  `hold` and `station`); watching a camera: `session.watch(camera)` (a time for a camera refused locally),
  `session.untilLive()` through its `connecting` and `warming` phases (`live_timeout`), and `session.picture(g)`, the
  JPEG a live frame was interpreted from; the shared session's controls with `dryRun`, `factory.session.lastState`,
  and `SessionClock` (with the worker's hold after a select or seek).
- Streams: frames over SSE with resume (`Last-Event-ID`, also across a `reset`), `limit` and `maxS` counted by the SDK,
  an idle watchdog, the state on connect (`clockOnConnect`), backfill of late layers, revisions and duplicates, side
  events; the long-poll; raw packets over SSE or NDJSON.
- The low level: one method per operation (32; `getFramePicture` gives `{ g, jpeg }`), typed models of every schema,
  and `codec` decoders.
- An Interpreter whose stream ends (`resume: false`) ends its iterations with a final update (`isFinal`, `frame` null)
  carrying what `end()` closed (and the facts of the open tray leaving), as a replay does; an iteration joins the
  shared stream at its first `next()`, and `events()`, `activities()` and `trayFacts()` stop at once when their signal
  aborts.
- A stream event that does not decode is skipped and the stream goes on (its id still counts, and an Interpreter's
  iterations still end with the final update); `onDecodeError` (streams and the Interpreter) is called with its
  `decode` error; an event decodes when the fields of SDK-DESIGN.md 2.3 rule 9 are there with their types, and
  `waitFor` waits on past one that does not. A replay skips the lines a reader does not understand (frame and side
  lines that do not decode too); its header is the first line that is not blank, when it decodes. A read error (gzip
  data cut short, a dropped download: `transport`) rejects and gives no final update. A recording URL that answers an error status rejects with the code of
  that status (the API's code when the reply is an API error), as the API's calls do, and an empty 2xx reply is an
  empty recording.
- Raw packets drop repeats per boot only: after a restart (a `reset`, cursors starting again) the new boot's packets
  follow, over SSE and NDJSON. `FakeFactory.injectReset(boot)` restarts the fake unit that way.
- `FactoryError.headers` (the error reply's headers); a whole-file media reply with neither a length nor byte ranges
  rejects with `not_seekable` instead of reading an endless body (use `openVideoMedia`); a 416 keeps the file's size.
  `session.seek()` on a camera is refused locally also when no state was seen yet (the state is read first).
- The type declarations declare `Symbol.dispose` and `Symbol.asyncDispose`, so projects without `esnext.disposable` or
  Node's types compile against them; CI type-checks consumer projects and runs the package on Deno and Bun.

#### Visualisation

- `pdigger-factory-sdk/viz`: `SceneView`, `OverlayCanvas`, `EventFeed` and `attachToClient` on three.js, and an example
  page.
- `TrayReportView` (`pdigger-factory-sdk/viz`): a tray's report as a picture, the tray as it arrived and as it left side
  by side, its stones coloured by the report (`reportMarks()`, `REPORT_COLORS`: the colours of the Rust viewer), a
  dashed outline where each removed stone was, and where to put the labels; the example page's report mode
  (`?report=<tray>`).

#### Testing and documentation

- `pdigger-factory-sdk/testing`: `FakeFactory` (the API from a recording, as a `fetch`, with a live camera,
  `LIVE_CAMERA`, that connects, warms up and goes live on the fake's clock and has its frames' pictures, fault
  injection, and the 20.20 unit's ways on request: `connect: "newest"`, `atLimit: "hold"`), `InstantClock`,
  `ManualClock`.
- Five [runnable tutorials](docs/tutorials/README.md) cover tray reports, the interpreter, frame data, live cameras
  and TypeScript conventions. The first tutorial explains a real tray report and follows the uncertain changes back
  to their evidence.
- Unit tests in Docker with no network at 100 % coverage; opt-in integration tests against a unit (read-only) and the
  four published recordings; CI, release and integration workflows.
- A small image (`Dockerfile`) to try the examples without installing Node packages, offline against the fake unit,
  and to serve the viz page with three.js (`make image-check` checks both).
- The fake unit's camera follows build live3: a play connects again and warms up on the camera's next frames (after a
  break, `g` jumping by 5), only the newest 64 pictures are kept (`KEEP_PICTURES`), frames and raw packets are numbered
  as the unit numbers them, controls and errors come in the unit's order and words, and on the fake's own clock
  (starting at the recording's time) a stream or a long-poll waiting for a phase moves it on; `fake.advance(seconds)`,
  `fake.now` and `fake.livePhase`.
- The fake unit's shared state follows a recording as it plays: its first clock line is the state at the start, and
  each later one (dry1's own rate changes, `auto-rate`) becomes it as a stream (frames or raw, SSE or NDJSON) or a
  long-poll passes it, so `GET /session` and a long-poll reply's `state` answer the state in force, as the unit's do;
  a long-poll reply ends before a clock line not yet taken, and the fake's own clock starts at the first clock line's
  time. A control (at a revision above the recording's clock lines) or an appended clock event ends it, the
  recording's clock lines then only sent; with `connect: "newest"` or `live: true` the state is the last clock line's.
