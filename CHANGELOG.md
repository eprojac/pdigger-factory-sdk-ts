# Changelog

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the version follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

The first release, for the API v2.2: what the 20.20 unit serves (build `claude-20261123-speckle7`: four recordings,
six plant cameras, the stones' looks and the speckle answers).

### Added

- Tray reports (SDK-DESIGN.md 4.7), simple mode: one `TrayReport` per tray, from `tray.report()`,
  `interpreter.trayReports()` (as each tray leaves a unit) and `replay.trayReports()` (every tray of a recording): the
  stones removed, added and moved (`TrayChange`), when and where (each one's final place on the tray), and whether
  that is the tray's whole account, as text (`describe()`) and as data (`toJSON()`).
- The tray's open account as it leaves (`tray.open`, `TrayOpen`, SDK-DESIGN.md 4.6.8), each fact's reason as a code
  (`TrayFact.code`), and the tray stones' `firstPlace`, `leftPlace` and `touched`, which the report reads; with the
  stones' looks, `identified` facts and the tray stones' `question`, `looks`, `byLook`, `lookLost` and `open`.
- The unit's speckle answers (SDK-DESIGN.md 4.6.12, `world.speckle` since build `claude-20261123-speckle3`), read as a
  tray's: `TraySpeckle` in `update.speckle` and `interpreter.speckle()` (the newest 1024), each tray stone's part as
  `TrayStone.speckle` (`StoneSpeckle`: `score`, `second`, `clean`, `found`, `pair`, `same`), and
  `describeSpeckleTxt()`, the golden `speckle.txt`.
- The leaving's speckle answer in every tray report (SDK-DESIGN.md 4.6.13, tray rules version 8): the stones it pairs
  are sure, confirmed on their world stone or linked again (`identified` facts with codes `speckle_same`,
  `speckle_moved` and `speckle_found`, `SPECKLE_CODES`; `TrayStone.bySpeckle`); each tray stone's `evidence` as its tray
  leaves (`found`, `not_found` or `undecided`); and every report change's `confidence` (`TrayChange.confidence`, from
  the measured constants `CONFIDENCE` and `MOVED_CONFIDENCE`), at the end of each change line of `describe()`.

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
- Presence questions (SDK-DESIGN.md 4.6.1): a tray stone without a look chain that is not seen at two calm moments while
  nothing could have changed it is held in question (`TrayStone.question`, cause `unseen`; not sure, no fact) and is
  sure again once the world sees it again on its place with no hand at work, no held stone, no stone a hand took away
  and no push on the tray meanwhile, no other stone of its size within 0.12 of its place, and no look of its world stone
  that matches another stone in question or lost; otherwise its fact `unsure` comes where the question ends, `opened` at
  its doubt. A question settled on a calm moment that does not show the stone (at once at its doubt, or by a sight
  before that calm moment) holds only if the next calm moment that shows it, or the tray's last frame when the tray
  leaves first and that frame shows it, finds nothing at work since (else a plain `unsure` fact there). A stone with a
  look chain is never held in question: its doubt is a question only its looks settle. Frames the tray rules can not
  read (a frame without a world, a jump in `g`, a `gap` or `reset` of the stream, any revision, the moving frames of a
  tray that goes on) end the questions open then; `InterpreterCore.gap()` tells the core about a `gap` or `reset` event.
  A settled stone gets no `unsure` fact, one whose question ends gets its fact there, and the leaving counts its last
  snapshot's own frame only once for a stone nothing could have changed since its last sight (a stone not detected only
  there gets no `unsure` fact).
- Certain removals and a visit's continuation (SDK-DESIGN.md 4.6.1): a lost tray stone is removed for certain only when
  a hand touched its world id (a `lift`, `hinge`, `carry`, `place`, `drop` or `gone`, a `push` with a `side`, or a
  `delete` with why `hand` or `carried-away`) from the last calm moment before its loss, or from 3.0 s before it was
  last seen if that is earlier, up to its loss; else it stays lost, and a rename or the leaving pairs it, or the leaving
  reports it removed, unclear, with the open cause `no_hand`. A visit continues the open tray only when nine tenths of
  its first frame's stones were seen on it, so a new board that carries over many of the last board's world ids is a
  tray of its own. On the four published recordings: 52 certain removals, 49 of them right by the maintainers' camera
  check, and 628 trays with 532 reports.
- The leaving's evidence (SDK-DESIGN.md 4.6.1, Leaving): as a tray leaves, a lost tray stone is linked to a new world
  stone near it only with evidence that it is the same stone: their looks agree, or the world stone was first seen at or
  after the lost stone was last seen (less 3.0 s), no hand worked within 0.40 of either place since, and their looks do
  not disagree. Without it the lost stone is removed and the world stone added, both unclear (each the other's candidate
  in the open account), so a stone's id never passes to a stone that may be another: by the maintainers' camera check,
  every stone that left dry1's and dry2's trays is reported removed. An unidentified stone that the leaving point's
  world shows detected and not held is present as the tray leaves, at its place there (positive evidence at departure).
  So is one that world keeps there (lists it, not detected), not held, with less than 0.30 of its box under one other
  unheld stone's box there: by the maintainers' camera check, 32 of the 63 stones this adds on the four published
  recordings were there (dry1's tray 2 accounts for the 44 stones the video shows), and 25 are boxes on jul30's bare
  boards that are not there.
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
- `pdigger-factory-sdk/viz`: `SceneView`, `OverlayCanvas`, `EventFeed` and `attachToClient` on three.js, and an example
  page.
- `TrayReportView` (`pdigger-factory-sdk/viz`): a tray's report as a picture, the tray as it arrived and as it left side
  by side, its stones coloured by the report (`reportMarks()`, `REPORT_COLORS`: the colours of the Rust viewer), a
  dashed outline where each removed stone was, and where to put the labels; the example page's report mode
  (`?report=<tray>`).
- `pdigger-factory-sdk/testing`: `FakeFactory` (the API from a recording, as a `fetch`, with a live camera,
  `LIVE_CAMERA`, that connects, warms up and goes live on the fake's clock and has its frames' pictures, fault
  injection, and the 20.20 unit's ways on request: `connect: "newest"`, `atLimit: "hold"`), `InstantClock`,
  `ManualClock`.
- Examples, docs, four tutorials (`docs/tutorials/`: high level, low level, live cameras, TypeScript; every sample a
  region of an example program the tests run).
- Unit tests in Docker with no network at 100 % coverage; opt-in integration tests against a unit (read-only) and the
  four published recordings; CI, release and integration workflows.
- A small image (`Dockerfile`) to try the examples without installing Node packages, offline against the fake unit,
  and to serve the viz page with three.js (`make image-check` checks both).
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
