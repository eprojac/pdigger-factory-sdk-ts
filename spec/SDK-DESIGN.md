# pDigger Factory SDK: design and parity contract

This is the contract our SDK follows in its four languages (Go, Python, Rust, TypeScript), so that the same program
reads the same way in every language and the same recording gives byte-identical human-readable output everywhere.
Where this file and a language's habits disagree, the language's habits win for *shape* (naming case, error style,
async primitive) and this file wins for *behaviour* (what is computed, what text is produced, what is retried).

Sources of truth, in this order:

1. `spec/openapi.yaml`: the HTTP API (v2.2, the shipping API: build claude-20261122-hr4x1 on 20.20, with the stones'
   looks, the stone head's maps at 4x resolution in the raw packet, and its six plant cameras, see section 3).
2. This file: SDK behaviour, names, the Interpreter's rules and text templates, tests, CI, docs.
3. `fixtures/`: recorded API data (real output of the 20.20 unit, and for aug28's two excerpts of a replay of its model
   and build on a Mac) and the golden outputs every SDK must reproduce exactly.

## 1. Names, folders, packages

| Language | Folder (= GitHub repo) | Package | Import | Runtime |
|---|---|---|---|---|
| Go | `pdigger-factory-sdk-go` | module `github.com/eprojac/pdigger-factory-sdk-go` | `pdiggerfactory "github.com/eprojac/pdigger-factory-sdk-go"` (package name `pdiggerfactory`) | Go 1.23+ (range-over-func), standard library only |
| Python | `pdigger-factory-sdk-python` | PyPI `pdigger-factory-sdk` | `import pdigger_factory_sdk` | Python 3.10+, asyncio, `httpx` only runtime dependency |
| Rust | `pdigger-factory-sdk-rust` (cargo workspace) | crates `pdigger-factory-sdk` (core, publishable) and `pdigger-factory-viz` (egui UI) | `use pdigger_factory_sdk::...` | Rust stable (edition 2021 or 2024), tokio, reqwest (rustls), serde |
| TypeScript | `pdigger-factory-sdk-ts` | npm `pdigger-factory-sdk` with subpath exports `/viz` and `/testing` | `import { FactoryClient } from "pdigger-factory-sdk"` | Node 18+, browsers, Deno, Bun; ESM + type declarations; core has no runtime dependencies; `/viz` has `three` as a peer dependency |

Each folder is a self-contained project: it is pushed as its own GitHub repository as it is (its own `.github/workflows`,
`README.md`, `LICENSE` (Apache-2.0), `CHANGELOG.md`, `Dockerfile`, tests, docs, pictures, and its own copy of the spec and
fixtures under `spec/` and `fixtures/`, refreshed by the maintainers in all four at once). The SDK version starts at
`0.1.0`.
User agent: `pdigger-factory-sdk-<lang>/<version>`.

Words used everywhere: **source** (a recording or a live camera; the API calls them videos), **session** (the one
shared interpretation run; a select or seek starts a new one), **frame** (one grid frame `g`, 5 per media second),
**layer** (raw, overlay, scene, cards, world), **world** (the Stable sim's persistent stones and hands), **event** (what
the world says happened in a frame), **activity** (events the SDK joins into one human-scale action: a move or a push
burst), **interpreter** (the SDK object that turns frames into state, events, activities and text).

## 2. Layers of every SDK

Every SDK has the same five layers. A user can stay on the top one and never see the others.

| Level | What | Module / namespace |
|---|---|---|
| High | `Interpreter`: follow the shared session (a recording, or one of the plant cameras live), typed events, activities (moves, push bursts), hand states, stone inventory, per-stone tracks, summary, human-readable text, `wait_for` | `interpreter` |
| High | `Replay`: the same Interpreter over a recorded stream file (the four published recordings), offline, synchronous iteration, optional real-time pacing | `replay` |
| Mid | Streams: frames over SSE with automatic resume (`Last-Event-ID`), long-poll fallback, raw packet stream, clock/worker/gap/reset side events, world revisions | `streams` |
| Mid | Render-ready: overlay2d and scene3d draw lists, typed | part of `api` + models |
| Low | `api`: one method per HTTP operation, typed request/response models, typed errors; `codec`: decoders for maps, bitsets, depth, surface buffers, joints, stone tuples, coordinate helpers | `api`, `models`, `codec` |
| Tooling | `testing`: a fake server/transport serving fixture or recording data, so user code can be unit-tested without a server | `testing` |
| UI (TS, Rust only) | Visualisation helpers: TS on three.js, Rust on egui reusing texturecraft / craft-ui components | TS `pdigger-factory-sdk/viz`, Rust crate `pdigger-factory-viz` |

### 2.1 Client and transport

- Construct with a base URL (`http://factory-orin.local:8120` in docs; tests read `PDIGGER_FACTORY_URL`). Options:
  request timeout (default 10 s), connect timeout (5 s), retries (default 3), backoff (base 250 ms, factor 2, max 5 s,
  full jitter; deterministic when a seeded random source is injected, which tests do), extra headers, optional bearer
  token (`Authorization: Bearer <token>`; 20.20 ignores it; the shipped API may require it), user agent suffix, an
  injectable HTTP client/transport (that is how tests run without a network), and `observe` default (see 2.4).
- Async first. Python `asyncio` (`async with FactoryClient(url) as factory`), Rust `async fn` + `futures::Stream`,
  TypeScript `Promise` + `AsyncIterable` + `AbortSignal`, Go `context.Context` on every call and range-over-func
  iterators (`iter.Seq2[T, error]`) for streams. Every stream can be cancelled (context, AbortSignal, dropping the
  stream, `aclose()`), and cancelling closes the HTTP connection.
- Retries: GET/HEAD are retried on connection errors, 429, 502, 503, 504, waiting `retry_ms` from the error body, else
  `Retry-After`, else the backoff. A POST/PUT/DELETE is retried only on 429 (the server checks rate limits before it
  applies anything, so a 429 is never half-applied). Never retry 4xx other than 429.
- Errors: one error type per SDK carrying `status`, `code` (the API's stable error code string, see
  `ErrorCode` in the spec, plus the SDK-only codes below), `message` (`error`), `field`, `retry_ms`, `retained`
  (the retained window), `waiting`. Helpers: `is_retryable`, `is_not_retained`, `is_session_gone`. SDK-only codes:
  `transport` (no HTTP reply), `decode` (a reply that is not the documented JSON), `live_unavailable` (the server's
  catalog has no live camera), `live_timeout` (`session.until_live` waited in vain), `stream_closed`. Code is keyed on
  `code`, never on `message`. A reply without the API's
  JSON error body (the empty 416 of a media range, a proxy's page) gets its code from the status, the same in every
  SDK: 400 and 416 `invalid_param` (416 with `field` `range`), 403 `cross_origin`, 404 `not_found`, 405
  `method_not_allowed`, 413 `body_too_large`, 415 `json_only`, 429 `too_many_requests`, 503 `not_ready`, any other 5xx
  `internal`, anything else `decode`.
- Same-origin: controls refuse a foreign `Origin`; non-browser SDK clients send none. The TS client in a browser works
  only from a page served by the same server (the API sends no CORS headers; the docs say so).

### 2.2 Low level: one method per operation

Names follow the spec's `operationId` in the language's case: Go `ListVideos`, Python/Rust `list_videos`, TS
`listVideos`. All live under `client.api` (Go `client.API()`, Rust `client.api()`). Every v2 operation of the spec is
covered except the frozen legacy surface (`/api/live`, `/api/control`, `/api/health`, `/catalog.json`, `/videos/*.mp4`),
which the SDK does not wrap.

| operationId | Notes for the SDK |
|---|---|
| getApiRoot, getOpenApi, getModel, getTopology, listVideos, getVideo | `listVideos`/`getVideo` return `Source` models (section 3) |
| getVideoMedia | byte range download (`range: [start, end]` optional), returns bytes + content range; HEAD variant `head_video_media` |
| getSession, sessionSelect, sessionSeek, sessionPlay, sessionPause | controls take `dry_run: bool` (default false) |
| getFocus, putFocus, deleteFocus | `put_focus(stone_id, g?, session?, dry_run?)` |
| rawStream, streamFrames | low-level: return the raw event iterator (section 2.3); the high level uses them |
| rawPacket, getFrame | `g` is an int or `"latest"`; `session` guard optional |
| rawTensors | bytes (npz); `debug_disabled` error when off |
| pollFrames | one long-poll call (cursor, rev, cid, layers, limit, wait, precision) |
| getFrameRaster | `raster: regions|mask|depth`, `scale 1..8`, returns PNG bytes |
| getWorld, getStone, getWorldEvents | typed |
| renderOverlay2d, renderScene3d | exactly one of `g`/`t`; `mode`, `draw`, `surface`, `session` |
| getHealth, getReady, getStatus, getMetrics | `get_metrics` returns text and a parsed `{name, labels, value}` list |

Models: every schema in `components/schemas` gets a typed model. Parsing is tolerant: unknown fields are ignored (and
kept in an `extra`/`raw` map where the language makes that cheap), fields listed as redactable in section 6 are optional.
JSON numbers that are integers in the spec (`g`, `cursor`, `session`, ids) are 64-bit integers.

### 2.3 Mid level: streams

`client.streams.frames(layers=…, after=None, observe=None, precision="rounded", resume=True)` yields `StreamItem`s:

- `FrameItem(frame)` for SSE `frame` events (data = Frame);
- `ClockItem(state, server_now)`, `WorkerItem(worker)`, `GapItem(count)`, `ResetItem(boot, cursor)` for the side events.

Rules:

1. Transport is SSE (`format=sse`). The parser follows the SSE spec (fields `event`, `data` (multi-line joined with
   `\n`), `id`, `retry`; comments `:`; CRLF/LF/CR line ends; UTF-8; BOM at start ignored). The resume id is the id of
   the last dispatched event (an event cut off before its blank line does not count). A line, or one event's data,
   over 64 MiB is a `decode` error that ends the connection; parsers scan only new bytes for line ends. A stream's reply
   headers must come within the client's timeouts, and a connection that sends nothing for 30 s (the unit sends a
   `worker` event every 5 s) is closed and reconnected (TS, Python and Rust; Go relies on TCP keepalive).
2. `limit` and `max_s` end a server stream; with `resume=True` (default) the SDK reconnects at once with
   `Last-Event-ID` = the last event id, so a caller sees one endless stream. Connection errors reconnect with the
   backoff. A `reset` (another boot) is passed to the caller and the stream continues from the newest (the resume id
   becomes `{boot}-{cursor}` of the reset). The SDK counts
   `limit` and `max_s` itself and closes the connection when either is reached, without waiting for the server's end:
   the 20.20 unit sends nothing more but closes a finished stream only about 10 s later ([BEHAVIOUR-20.20.md](../docs/BEHAVIOUR-20.20.md)).
3. The stream counts as a viewer unless `observe=True` (query `observe=1`). The high level's default is
   `observe=False`: an integration that wants events must keep the interpreter running, and an idle worker interprets
   nothing ("nobody is watching").
4. World revisions: a frame whose `world.rev` is higher than a frame already delivered for the same `(session, g)` is a
   revision. The stream passes it on with `is_revision = True`. Frames are otherwise in cursor order.
5. `client.streams.poll(...)` is the long-poll equivalent (loop of `pollFrames` continuing from the reply's `cursor` and
   `state.revision`), for environments without streaming. The unit counts a long-poll as a viewer only with a client
   id, so unless `observe` is set the SDK sends one (`cid`: the caller's, or a random one for the whole poll).
   `client.streams.raw_packets(...)` is the `raw/stream` version (NDJSON or SSE, same resume rules).
6. Late layers: a frame released with `missing: ["world"]` (the 300 ms deadline; on 20.20 while playing, on build
   claude-20261114-int17 3-4 % of the frames of dry1 and dry2 and none of aug28 and jul30, on build
   claude-20261122-hr4x1 5.6 % of dry1's) is never pushed again. `frames(..., backfill=True)` (the high level's default)
   holds such a frame back, and every frame after it, reads the missing layers with `GET /frames/{g}?layers=…&session=…`
   1.5, 2.5 and 3.5 s after it arrived (until they come; each read one request without retries, bounded by 1 s, running
   beside the stream), merges them in (removing them from `missing`), and then releases the held frames in cursor order;
   the completed frame has `is_backfill = True`. A frame that cannot be completed (404 not retained, 410 session gone,
   tries used up) is released with the layers that did come merged in (`is_backfill = True` when one did) and the others
   still in `missing`. Side events are never held. So the Interpreter always sees frames in order, at the cost of up to
   about 4.5 s of extra latency when a world is late.
7. Duplicates: a frame for a `(session, g)` already delivered with the same or a lower `world.rev` is dropped.
8. The state on connect: the unit sends a `clock` event only when the shared state changes, never on connect. With
   `clock_on_connect` (the Interpreter's default) the SDK reads `GET /session` after every connect (one request, at
   most 1 s) and passes it on as a `ClockItem` before that connection's frames; without it, wall times wait for a
   `clock` event.
9. Events that do not decode: an event whose data is not JSON, or not the documented shape of its type, does not end
   the stream. Its id still counts (the resume id moves past it), and the stream goes on with the next event. Go and
   Rust yield it as a `decode` error item; Python and TS, whose iterators cannot yield an error and go on, skip it:
   Python logs a warning to the `pdigger_factory_sdk.streams` logger, TS calls the `onDecodeError` option when one is
   given. The Interpreter goes on past it too (Go and Rust pass the error on, and `wait_for` waits on), and a stream
   that ends after it still ends with the final update (2.4). What ends a stream with `decode` is a line or event over
   64 MiB (rule 1) or a reply body that does not decode (a bad `Content-Encoding`).

   What every SDK checks, for events and for the lines of a recording (section 6): the data is a JSON object (RFC 8259:
   `NaN` and `Infinity` are not JSON), a field that is null counts as missing, and each type has the fields below, of
   their types (a whole number is an integer, `2` or `-7`; a number may have a fraction):
   - a frame: `cursor`, `session`, `g` and `i` whole numbers, `t` and `dt_past` numbers, `video` a string and
     `past_valid` a boolean. `missing`, when there, is an array, and every layer there is an object: `world` with
     `schema`, `video` and `motion` strings, `session` and `g` whole numbers, `t` and `logF` numbers, `stones` and
     `events` arrays of objects, and `hands` and `stats` objects (when there, `draw` and `focus` objects and `rev` a
     whole number); `cards` with a `schema` string and `left`, `right` and `numbers` objects (`stage`, when there, an
     object); `raw` as a packet below;
   - a sip1 packet (a frame of `raw_packets`, or a frame's `raw`): `schema` and `video` strings, `session`, `g` and `i`
     whole numbers, `t`, `dt_past` and `both` numbers, `past_valid` a boolean, and `maps`, `depth`, `boxes`, `person`,
     `stones`, `tray`, `hands` and `ms` objects (`cursor`, when there, a whole number);
   - a `clock`: `session` and `revision` whole numbers, `video` and `changed_by` strings, `playing` a boolean, and
     `rate`, `anchor_media`, `anchor_wall`, `hold_until`, `media_time` and `server_now` numbers; `duration`, when there,
     is a number and `focus` an object;
   - a `worker`: `state` and `reason` strings and, when there, `fps`, `frame_ms`, `cycle_ms` and `gpu` numbers,
     `session`, `g` and `errors` whole numbers, `model` and `video` strings, and `stage_ms` and `engines` objects;
   - a `gap`: `gap` a whole number; a `reset`: `boot` a string and `cursor` a whole number.

   Further inside (a stone, an event, a hand card, the other layers), each SDK reads the data as its models do: Python
   skips an event with a field there missing or of the wrong type; Go one with a field of the wrong type (a missing or
   null one reads as its zero value); Rust one with a field of the wrong type, or null where its model takes none (a
   missing one reads as its zero value); and TypeScript, which has no types at run time, takes it as it is. The four languages
   differ in the same way on a whole number written with a fraction or an exponent (`2.0`, `2e0`: that number in Python
   and TypeScript, no whole number in Go and Rust), a whole number written `-0` (0, but no whole number in Rust), one
   beyond 2^53, a number beyond a double's range (`1e400`: infinity in Python and TypeScript, not decoded where Go and
   Rust read it as a number), a key that differs from a field's name only in case (Go's models read it as that field,
   the others ignore it), an object that repeats a key, a string with a lone surrogate (`"\ud800"`: kept in Python and
   TypeScript, U+FFFD in Go, not decoded where Rust reads it as a string), and JSON nested deeper than a reader goes
   (128 levels in Rust, 10 000 in Go, Python's recursion limit; TypeScript any depth). A unit sends none of these. The
   fixture `fixtures/damaged` holds damaged lines and events of every type the list checks, and each SDK's tests check
   that it skips them.

### 2.4 High level: the Interpreter

```text
interpreter = client.interpreter(layers=("world", "cards"), observe=False, backfill=True)
for each update in interpreter.updates():          # async iterator; Go: iter.Seq2; Rust: Stream
    update.frame        # the Frame
    update.events       # new events of this frame, typed, in world order
    update.activities   # activities completed by this frame
    update.tray_facts   # tray facts made by this frame (section 4.6)
    update.speckle      # the unit's speckle answer this frame carried, read as a tray's (section 4.6.12)
    update.state        # InterpreterState after this frame
interpreter.events()       # just the events
interpreter.activities()   # just the activities
interpreter.tray_facts()   # just the tray facts
interpreter.tray_reports() # a report as each tray leaves (section 4.7): removed, added, moved
interpreter.trays()        # the trays so far: Tray {session, video, n, arrived, leaving, stones, facts}
interpreter.speckle()      # the unit's speckle answers so far: TraySpeckle {tray, ref, at, stones, ...} (4.6.12)
interpreter.wait_for(predicate | event type, timeout)   # first event that matches
interpreter.track(stone_id)    # the stone's path: TrackPoint {g, t, pos}
```

Loops over one interpreter run one at a time and follow one another: a later loop goes on where the last one stopped
and misses nothing in between. It first yields the rest of the frame the last loop stopped in (the events and
activities that loop did not yield; after `wait_for`, the events after the match and all of that frame's
activities), then the frames after it (the stream resumes after the last frame fed, while the unit still holds it).
So a later loop reads again what came after that frame: side events, and an event that does not decode, which is
reported again (2.3 rule 9). `wait_for` waits on past an event that does not decode, as the loops go on past it.
`track(stone_id)` is the path of a stone's solid in this session: a point for every frame fed where the solid moved,
the newest 512, for the 4096 most recently moved stones, reset on a new session (the server's own track since the
session began is `getStone`).

`Interpreter` itself is a pure synchronous state machine: `InterpreterCore.feed(frame) -> Update`,
`InterpreterCore.end() -> Update` (the final update, `frame` null and `final` true: open activities closed as
`interrupted`, and the facts of the open tray leaving) and `InterpreterCore.finish() -> [Activity]` (the same end, its
activities only; the tray facts stay in `trays()`). `InterpreterCore.gap()` tells the core that the stream dropped
frames there (a `gap` or `reset` event): the tray rules count the next frame as one after frames they could not read
(4.6.1, presence questions); the Interpreter calls it for every `gap` and `reset` item of its stream. The client streams
feed the core; `Replay` feeds it from a file. `updates()` ends with the final update when its frames end: a replay at
the end of its file, a live stream when the server ends it and `resume` is off. A stream that ends with an error, a
replay whose file cannot be read to its end, and a loop the caller stops or cancels have no final update. All rules
below live in the core, so they are unit-tested without I/O, and the golden files (section 5) are produced by `Replay`
over fixture files.

**State (`InterpreterState`)**: `session`, `video`, `g`, `t` (media seconds), `wall` (epoch seconds, from the
newest clock state of the frame's session, the last 8 sessions kept: `start + (t - anchor_media) / rate` with `start` =
`max(anchor_wall, hold_until)` while playing and `anchor_wall` while paused, the wall time at which the shared playhead
shows (or showed) media time `t`, the same as `SessionClock.wall_of(t)`; null without a clock state of that session or
when `rate` is not above 0), `stones` (map id →
`Stone` from the newest world: id, mode, family, shape, side, outline, solid {pos, q, dims}, detected, uncertain,
source, placed), `hands.left` / `hands.right` (`state` free|touch|grasp|hinge|carry, `stone` id or null, `card` title
from the cards layer when present, e.g. "Holding a stone"), `board` (world.draw.board), `stats` (world.stats),
`open_moves` (stone id → partial move), `tray` (the open tray of section 4.6 with its tray stones, or null), counters
(section 4.4).

**Frame handling, in order** (frames without a `world` layer only update `g`, `t` and the cards, and tell the trays they
could not read a frame, 4.6.1):

1. A frame of a new `session` (different from the state's) resets the state (stones, hands and their cards, open
   activities: open moves are closed as `interrupted` and emitted first; push bursts are closed and emitted), and sets
   `session`, `video`.
2. A frame of this session whose `g` is not above the newest `g` seen is either a revision (a world with a higher
   `world.rev` than the one seen for that `g`) or a duplicate (dropped, not counted; the iterators skip it). A
   revision's events are emitted only if their key `(type, id, side, into)` was not already emitted for that `g`, and
   are fed to the activities; their `tray_stone` (step 3) is the one that stood for the world id before that `g`, not
   the tray's latest. The state is replaced from the revised world only if its `g` is the newest `g` seen; a revision
   changes neither the cards nor the trays, but tells the trays they could not read a frame (4.6.1): it may hold a hand
   at work they never saw. What a revision needs (each `g`'s `world.rev`, its event keys and its tray links) is kept for
   at least the 4096 newest grid frames of the session (the server keeps 512); a later version of a frame no longer kept
   is a duplicate.
3. Otherwise, events of `world.events` are emitted in order, each as a typed `Event`: `type` (the wire name),
   `g`, `t`, `wall`, `session`, `video`, `stone_id` (`id`), `hand` (`side`: left|right|both|null), `why`, `into`,
   `source`, `stone` (the stone's snapshot in this frame's world, or null), `tray_stone` (the id of the tray stone
   that stood for this world id before this frame, section 4.6, or null), and `describe()` (section 4.1).
4. Activities are updated from those events (section 4.2) and completed ones emitted in the order of section 4.3.
5. State (stones, hands, board, stats) is replaced from the world.
6. The frame is fed to the trays (section 4.6); the tray facts it makes are emitted after the activities.

Stone ids in events and activities are the world's (the engine's tracker): it renames a stone it lost and found again
and can keep an id on another stone. The tray stones of section 4.6 carry the SDK's own ids, one per stone, never
reused, and their facts are never revised; use them for anything that must hold over time ("stone X was removed").

Frames are processed in the order received. Within a session `g` normally increases by 1; a jump (dropped frames, a
paused live camera) is counted in `summary.gaps`, and tells the trays they could not read a frame (4.6.1).

### 2.5 Replay

`Replay.open(path_or_url)` reads a recording file (section 6): `.ndjson` or `.ndjson.gz`, local path or HTTP(S) URL
(streamed, not loaded whole). `replay.frames()` (sync iterator of Frames), `replay.updates()` (sync iterator of
`Update`, feeding an `InterpreterCore`: duplicates skipped, then the final update; a file that cannot be read to its
end gives its error instead), `replay.events()`, `replay.activities()`, `replay.tray_facts()`,
`replay.trays()` (every tray with its `arrived` and `leaving` points; consumes the file), `replay.tray_reports()` (the report of
every tray that arrived, section 4.7; consumes the file), `replay.summary()` (consumes
the file), `replay.header` (the recording header).

Jumping between tray points: `replay.trays()` lists them; on the shared session `client.session.seek(point.t)` shows a
point (a recording; a live camera is not seekable); `Tray.window()` is `(arrived.t, leaving.t)`, the span to replay or
to show for that tray. `pace="realtime"` (async variants only) sleeps so frames come at their media times (divided by
`speed`, default 1.0). Clock lines of the file give `wall` times. Its `gap` and `reset` lines that decode go to
`InterpreterCore.gap()`, as a live stream's events do.

### 2.6 Session and sources (high level)

- `client.sources()` → `[Source]`; `client.source("aug28")`; `client.cameras()` → the live camera `Source`s (empty
  when the server lists none); `client.live()` → the first camera, or the `live_unavailable` error when there is none
  (kept for code written for one camera; prefer `cameras()`).
- `client.session.state()`; `client.session.watch(source, at=None, dry_run=False)`: play first if paused, then select
  (a select keeps the paused/playing state; playing first gives the worker its hold to warm up), returns the new
  state; `seek(t)`, `pause()`, `play()`, `focus(stone_id)`, `clear_focus()`. All mutate the shared session for every
  viewer and say so in their doc comments. Every control takes `dry_run`.
- `client.session.until_live(timeout=30)`: waits until the session's camera shows live frames (`state.live.phase` is
  `live`), reading the session at most every 0.25 s, and returns that state; on a recording it returns the state at
  once. After `timeout` seconds it raises `live_timeout` (the state it saw is in the error's message). It sends no
  control.
- `client.session.picture(g="latest", session=None)` → `Picture {g, jpeg}`: the camera picture a live frame was
  interpreted from (`GET /api/v2/session/frames/{g}/image.jpg`; `g` from the frame header `X-Interp-G`). A recording
  has none (`not_found`); a frame no longer retained is `not_retained`.
- `client.session.clock()` → a `SessionClock` from `getSession` that maps between media time, server wall time and
  local wall time (offset from `server_recv`/`server_now` and the request's round trip, the same sampler the portal uses:
  offset = server_recv - (t_send + t_recv)/2), `media_time_now()`, `wall_of(t)`.

## 3. The live cameras (20.20 builds claude-20261120-live3 and looks1)

The plant cameras are sources like the recordings: listed by the catalog, selected for the one shared session. The
contract, as in `spec/openapi.yaml` (measured on the unit in `docs/BEHAVIOUR-20.20.md` section 7):

- Catalog: cameras come after the recordings, each with `kind: camera`, `live: true`, `seekable: false`,
  `duration`, `frames` and `default_start` null, `held_out: []`, `grid_step: 1`, `fps` the grid it is said to run on,
  `hold` the warm-up in seconds (3), and `station`. Their ids are the camera serials (`CAM00000001`). `default_video`
  stays a recording. Missing `kind`/`live`/`seekable` (older builds) mean a seekable recording.
- Selecting a camera (`select {video: <id>}`, never with `time`: 400 `not_seekable`, field `time`) starts a session
  at `media_time` 0 and rate 1.0 (the rate never changes; `set_rate` and auto-rate leave it), with `state.live`:
  `{phase, warmup, since, lag}`. `phase` is `connecting` until the first camera frame, `warming` while the
  interpreter runs on the first `warmup` seconds of frames (they warm the world but are never released, stored or
  served), then `live`. A playing camera that sends no frame for 5 s goes back to `connecting`, and its next frame
  starts a new warm-up: `live` means that frames came within the last 5 s (a pause keeps the phase). Each change bumps
  `revision`. `duration` is null and there is no end of video.
- Live frames: `g` counts the session's camera frames from 0 (one grid frame each, the warm-up's included); `t` is the
  frame's arrival in seconds since `since`. The playhead starts at the first frame shown and runs at 1.0, `lag` behind
  the camera (the interpreter's time). Frames are released as the worker interprets them and stream like a recording's
  (`frames/stream`, `frames`, the render routes). Build `claude-20261122-hr4x1` delivered about 3.6 frames per second
  from cameras of about 3.8 (section 7 of `docs/BEHAVIOUR-20.20.md`).
- Pictures: `GET /api/v2/session/frames/{g|latest}/image.jpg` is the JPEG the frame was interpreted from (640 x 360 on
  the rigs; the native pixels of the layers are that picture stretched to `native_wh`), with `X-Interp-G`; the newest
  64 are kept (an older frame that is still retained answers 404 `not_retained`, without a `retained` window). On a
  recording: 404 `not_found`. `GET /api/v2/videos/{camera}/media` is 404 `not_found`.
- A seek whose video is a camera is refused (409 `not_seekable`, field `video`): the one it names, or without a `video`
  the one shown; a seek naming a recording is applied and moves every viewer off the camera. `pause` freezes the shared
  view and stops the interpreter on the camera (worker reason `paused on the camera`); `play` goes back to
  `connecting` in its own reply and continues at the live edge (`now - since - lag`) in the same session after a new
  warm-up: a pause or a camera that stopped answering leaves a hole in `g` (it jumps by 5). Worker reasons while on a
  camera: `connecting to the camera`, `the camera is not answering`, `paused on the camera`, and `the camera's pictures
  do not decode` (more than 3 s of them; a single picture that does not decode is dropped).
- Viewers: the worker interprets while there is a viewer (an open stream that does not `observe`, a long-poll with a
  `cid`, the page, and for 15 s the address that sent a control that is not a dry run) and idles 20 s after the last
  (reason `nobody is watching`); on a camera the phase then goes back to `connecting` 5 s later. A client that selects a
  camera keeps it live by opening a stream.

SDK behaviour: `Source.is_live`; `client.cameras()`; `session.watch(camera)` never sends `time` (an `at` raises
`not_seekable` locally, for a `Source` and for an id the catalog lists as a camera); `seek` on a live session raises
`not_seekable` locally without a request; `session.until_live()`; `session.picture(g)`; durations and progress are
null for live; wall times always come from the clock (they are the useful timestamps on a live camera). The testing
emulator offers one camera, `cam-live`, which replays a recording in real time with the same phases and pictures.

## 4. Interpreter rules (golden-tested)

### 4.1 Event text

`describe()` = `"{clock} {sentence}"`. `clock` is the media time: `M:SS.s` below one hour (`0:05.2`, `21:17.8`),
`H:MM:SS.s` from one hour (`1:02:03.4`), computed as in 4.5. `{Hand}` is `Left hand`, `Right hand`, `Both hands`, or
`A hand` when the event has no side. Verbs agree with it: the third person singular for one hand (`pushes`, `lifts`,
`tips`, `carries`, `places`, `drops`, `takes`, `moves`, `is`), the plural for `Both hands` (`push`, `lift`, `tip`,
`carry`, `place`, `drop`, `take`, `move`, `are`). Below, `{pushes}` etc. stand for the agreeing form. Stone ids are
printed bare (`stone 72`); a missing id prints `?`.

| type | sentence |
|---|---|
| new | `stone {id} appears` ; with `source: image`: `stone {id} appears (found in the image)` |
| confirm | `stone {id} is confirmed` |
| freeze | `stone {id} gets its final shape` |
| push | `why: course`: `stone {id} is pushed along its row` ; `why: reseat`: `stone {id} is reseated` ; else with a side: `{Hand} {pushes} stone {id}` ; else `stone {id} is pushed` plus ` ({why})` when there is another why |
| lift | `{Hand} {lifts} stone {id}` |
| hinge | `{Hand} {tips} stone {id} up on its edge` |
| carry | `{Hand} {carries} stone {id}` |
| place | `{Hand} {places} stone {id}` |
| drop | `{Hand} {drops} stone {id}` |
| gone | `{Hand} {takes} stone {id} out of view` |
| delete | `stone {id} is removed`, plus ` ({reason})` when there is a `why`: absent → `no longer seen`, overlap → `overlapped another stone`, outside → `outside the board`, merged → `merged with a neighbour`, empty → `its place is empty`, hand → `a hand emptied its place`, carried-away → `carried away`; any other `why` verbatim |
| split | `into` of 2 or more: `stone {id} splits into {a} and {b}` / `{a}, {b} and {c}` (commas, the last joined by ` and `) ; `into` of 1: `stone {id} is trimmed` ; no `into`: `stone {id} splits` |
| other | `stone {id}: {type}` (forward compatible) |

Example: `21:17.8 Right hand lifts stone 2660`, `0:20.5 Both hands push stone 90`.

### 4.2 Activities

Two kinds, both with `kind`, `hand`, `start {g, t, wall}`, `end {g, t, wall}`, `duration` (`end.t - start.t`, seconds),
`session`, `video`, `describe()`.

**Move** (one stone taken and put somewhere), per `stone_id` within a session:

- Opens on `lift` or `hinge` of a stone with no open move: `hand` = the event's side, `start` = this event's frame,
  `from` = the stone's `solid.pos` in this frame's world (null if the stone or its solid is absent, or its `pos` has
  fewer than 2 entries; of an id the world lists more than once, the last stone's), `carried = false`,
  `tipped` = (type == hinge).
- While open: `carry` sets `carried = true`; `hinge` sets `tipped = true`; a further `lift` sets nothing (keeps
  the first). If an event of the move has a different side than `hand`, `hand` becomes `both` and stays `both`.
- Closes on `place` (outcome `placed`), `drop` (`dropped`), `gone` (`carried_away`), `delete` of that id (`removed`;
  but a `delete` of a stone whose `place`, `drop` or `gone` is in the same frame is skipped: the engine deletes a
  carried-away stone and reports the hand's `gone` in the same frame, and the hand's event decides),
  with `end` = that frame, `to` = the stone's `solid.pos` in that frame's world for placed/dropped, read as `from` is
  (null otherwise), `distance` = Euclidean distance of `from` and `to` in x, y (null if either is null), rounded to 3 decimals.
- A `place`, `drop` or `gone` with no open move makes a move with `partial = true`, `start = end` = that frame,
  `from = null`, `carried = false`. (A stream joined in the middle of a carry.)
- At a session change or `finish()`, open moves close with outcome `interrupted`, `end` = the last frame of that
  session that had a world, `to` = null.

**Push burst** (a hand pushing stones about), per hand side:

- Only `push` events with a `side` (left/right/both) and no `why` count. (A `course` push names no side: a hand
  pushed a row and its stones slid along it together. A `reseat` push is the engine reseating a stone.)
- A push of side S at time t joins S's open burst if `t - burst.last_t <= 1.0`, else it closes S's open burst (if any)
  and opens a new one. A burst holds `stones` (unique ids, ascending), `pushes` (count of push events), `start`,
  `last` (frame of the latest push), `end` = `last` when closed.
- Before handling the events of a frame that has a world, every open burst whose `last_t` is more than 1.0 s before the
  frame's `t` closes (frames without a world close nothing). At a session change or `finish()` all open bursts close.

**Text** (`{dur}` = `fmt(duration, 1)`, `{dist}` = `fmt(distance, 2)`, verbs agree as in 4.1):

- placed and `carried`: `{start} {Hand} {moves} stone {id} {dist} units in {dur} s`; with `distance` null:
  `{start} {Hand} {moves} stone {id} in {dur} s`
- placed, not carried, `tipped`: `{start} {Hand} {tips} stone {id} and sets it down ({dur} s)`
- placed, neither: `{start} {Hand} {lifts} stone {id} and sets it down ({dur} s)`
- dropped: `{start} {Hand} {drops} stone {id} after {dur} s`
- carried_away: `{start} {Hand} {takes} stone {id} away ({dur} s)`
- removed: `{start} {Hand} {lifts} stone {id}; it is removed after {dur} s`
- interrupted: `{start} {Hand} {is} still holding stone {id} ({dur} s so far)`
- partial (any outcome): the same sentence with `{start}` replaced by the clock of `end.t` and ` (joined mid-move)` appended.
- push burst: `{start} {Hand} {pushes} {list} ({n} pushes in {dur} s)`, or `({n} push)` → `(1 push)` when there is one push;
  `{list}` is `stone 3`, `stones 3 and 5`, `stones 3, 5 and 9`; more than 6 stones: the first 6, then ` and {k} more`
  (`stones 3, 5, 9, 11, 12, 14 and 4 more`).

`{start}` is the clock of `start.t` as in 4.1. "units": the scene is in the template gauge, not metres; the docs say so.

### 4.3 Order of output

Within one frame: events in world order; then activities closed by this frame, sorted by (end g, start g, kind
`move` before `push`, stone id or first stone id, hand). Activities closed before the frame's events (stale bursts,
session change) come before that frame's events. `finish()` emits what is still open with the same sort. Tray facts
(section 4.6) come after the frame's activities, in the order they are made; a session change makes the old session's
tray leave first (its facts come with the first frame of the new session), and `finish()` makes the open tray leave.

### 4.4 Summary

`summary()` (Replay) / `interpreter.summary()` (live, so far) is a `Summary` with `describe()` and a JSON form with
exactly these keys (numbers rounded to 3 decimals; times in seconds):

```json
{
  "frames": 0, "frames_with_world": 0, "missing_world": 0, "revisions": 0,
  "sessions": 0, "first_g": null, "last_g": null, "first_t": null, "last_t": null, "media_seconds": 0.0, "gaps": 0,
  "events": {"new": 0, "confirm": 0, "freeze": 0, "push": 0, "lift": 0, "hinge": 0, "carry": 0, "place": 0,
             "drop": 0, "gone": 0, "delete": 0, "split": 0, "other": 0},
  "moves": {"total": 0, "placed": 0, "dropped": 0, "carried_away": 0, "removed": 0, "interrupted": 0, "partial": 0,
            "carried": 0, "mean_duration": null, "mean_distance": null},
  "push_bursts": {"total": 0, "pushes": 0, "left": 0, "right": 0, "both": 0},
  "stones": {"last": null, "max": 0, "confirmed_last": null},
  "trays": {"total": 0, "arrived": 0, "stones": 0, "added": 0, "added_unclear": 0, "removed": 0,
            "removed_unclear": 0, "unsure": 0},
  "hands": {"left": {"free": 0.0, "touch": 0.0, "grasp": 0.0, "hinge": 0.0, "carry": 0.0},
            "right": {"free": 0.0, "touch": 0.0, "grasp": 0.0, "hinge": 0.0, "carry": 0.0}}
}
```

- `frames`: frames fed (a revision counts in `revisions`, not in `frames`); `frames_with_world`; `missing_world`:
  frames whose world was missing (after backfill, for streams; as recorded, for replays).
- `gaps`: within a session, the number of times `g` increased by more than 1 between consecutive frames.
- `media_seconds`: sum over sessions of (last t - first t).
- `stones.last`: number of stones in the last world; `max`: the largest over frames; `confirmed_last`: last
  `stats.confirmed`.
- `hands.<side>.<state>`: seconds = 0.2 × number of frames with a world where that hand was in that state (one grid
  frame is 0.2 s of media). Unknown states are ignored.
- `moves.mean_duration` over closed moves that are not partial or interrupted; `mean_distance` over moves with a
  distance; null when there are none. `moves.carried`: moves with `carried` true.
- `trays` (section 4.6): `total` trays opened, `arrived` trays that arrived, `stones` tray stones at the arrivals,
  `added` / `removed` certain facts, `added_unclear` / `removed_unclear` unclear facts, `unsure` the unsure facts
  (tray stones that stopped being sure for good).

`Summary.describe()` is this text, `\n` after every line (example values):

```text
frames: 9012 (with world 9000, without 12, revisions 0)
media: 30:02.4, sessions 1, gaps 3
stones: last 41, max 52, confirmed 41
moves: 18 (placed 15, dropped 1, carried away 0, removed 1, interrupted 1, partial 0, carried 12), mean 4.1 s, 0.38 units
push bursts: 120 (left 70, right 48, both 2), pushes 1934
events: new 412, confirm 380, freeze 290, push 1934, lift 19, hinge 3, carry 12, place 15, drop 1, gone 0, delete 260, split 7, other 0
trays: 71 (arrived 66), stones at arrival 2752, added 0 (+26 unclear), removed 8 (+3 unclear), not sure 294
left hand: free 12:01.0, touch 8:02.2, grasp 6:40.0, hinge 0:00.4, carry 1:10.2
right hand: free 13:40.0, touch 7:00.2, grasp 6:02.0, hinge 0:00.0, carry 0:58.6
```

Null values print `-` (`stones: last -, …`, `mean - s, - units`). Integers print plainly; durations as the clock of 4.1;
`mean` as `fmt(x, 1)` and units as `fmt(x, 2)`.

### 4.5 Numbers (identical in every language)

- `fmt(x, d)`: `n = floor(x * 10^d + 0.5)` computed in IEEE doubles, then the integer `n` printed with a decimal point
  `d` places from the right, zero-padded (`n = 5, d = 1` → `0.5`; `n = 123, d = 2` → `1.23`); a negative `x` prints `-`
  then `fmt(-x, d)`. Never use the language's float formatting (`%.1f`, `toFixed`, `format!("{:.1}")`) for text output:
  they round ties differently.
- `round3(x) = floor(x * 1000 + 0.5) / 1000` for the JSON summary; golden JSON is compared after parsing.
- The clock: `n = floor(t * 10 + 0.5)` tenths; `h = n / 36000`, `m = (n / 600) % 60`, `s = (n / 10) % 60`,
  `d = n % 10` (integer division); `M:SS.d` when `h == 0` (minutes not padded), else `H:MM:SS.d`.
- Durations are `end.t - start.t` in doubles; sums are in the order the items were produced.

### 4.6 Trays and tray stones (the SDK's own stone ids)

The world's ids are the engine tracker's. It renames a stone it lost and found again, and it can keep an id on another
stone: a stone set down where a removed one lay, a neighbour pushed into its place, a row of equal stones pushed one
place along while the ids stay on the places. The interpreter keeps its own stones per tray, the **tray stones**, with
ids that are never reused: no two tray stones ever share one. A tray stone says whether its identity is **sure**; a fact
about it is **certain** or **unclear**. The rules are conservative: an identity stays sure, and a fact is certain, only
when what the world shows leaves no other reading. Everything else is said to be unclear, never guessed silently. A
stone without a look chain that the world stops detecting while nothing could have changed it is not given up at once:
the doubt is held open as a question, and seeing the stone again where it was, with no hand at work, no push on the
tray, no frame the rules could not read while it was out of sight and no other stone of its size beside it, settles it
(4.6.1, presence questions). Meanwhile it is in question: not sure, but no fact is given. A stone with a look chain has
its looks for that (4.6.4, 4.6.5). Tray facts are final: a fact, once given, is never revised or withdrawn, and a stone
that is not sure (fact `unsure`) is sure again only through its tray's leaving speckle answer, once, with an
`identified` fact (4.6.13). On a worked tray the world stone a tray stone stands for can
turn out to be another stone: the rules mark a stone not sure whenever what the world shows leaves another reading, and
when the tray leaves, its open account (4.6.8) lists every stone left open with the readings the evidence leaves. What
the SDK can not see, since it sees only the world (the engine has to fix these): a box the model sees on an empty slot
when the tray arrives becomes a tray stone, and stays sure while the model keeps seeing it, also when it sees it with
gaps (4.6.1, presence questions); and a stone later set into that slot keeps its id; and a stone the model stops seeing
for good while it stays on the tray looks removed, and is removed for certain once no world stone could be it; and when
the world swaps the ids of two stones it sees, each tray stone follows its id onto the other stone, and a sure stone
stays sure.

When the world stream carries looks of the stones' faces (`look`, 4.6.2), the rules also follow each stone by its look
(4.6.3-4.6.8):
- a doubt that a later look may settle is first held as a *question*. During a question the stone is not sure, but no
  fact is given;
- a look settles a question, or links a stone again, only when it matches that stone's own earlier look above a bar
  that the tray's own looks set;
- a tray's certain removals and additions are the first of those the rules make without looks: the same facts on the
  same frames, until a look changes a link, doubts a stone the rules without looks trust, or keeps a stone from their
  certain removal. After that the tray makes no certain removal or addition (4.6.7).

On a tray whose frames carry no usable look, the rules are 4.6.1's alone, presence questions included, the first version
of these rules (*v1* below; 4.6.7, *Without looks*): the tray facts and their order are 4.6.1's, and 4.6.8 and 4.6.9 add
the open account and the codes.

#### 4.6.1 The tray rules

All numbers below are doubles; `dist(a, b) = sqrt(dx*dx + dy*dy)`. For a world stone `ws`: `place = (pos[0], pos[1])`
of `ws.solid`; `size = (max(dims[0], dims[1]), min(dims[0], dims[1]))`; two sizes are *compatible* when
`|a0 - b0| <= 0.25 * max(a0, b0)` and `|a1 - b1| <= 0.25 * max(a1, b1)`. Its turn, from `q = [x, y, z, w]` without
trigonometry: `n = w*w + z*z`, `cos = (w*w - z*z) / n`, `sin = 2*z*w / n` (`1, 0` when `n == 0`). Its box *covers* a
point `p` with margin `m` when, with `(dx, dy) = p - place`, `|cos*dx + sin*dy| <= dims[0]/2 + m` and
`|-sin*dx + cos*dy| <= dims[1]/2 + m`. Its *overlap* is the largest share of its 25 points
`(place.x + cos*u - sin*v, place.y + sin*u + cos*v)` with `u = (i + 0.5)/5 * dims[0] - dims[0]/2`,
`v = (j + 0.5)/5 * dims[1] - dims[1]/2` (`i, j` = 0..4) that one other world stone not held (mode `carry` or `hinge`)
covers with `m = 0` (count / 25; a stone whose place is farther than `(max side of this + max side of that) / 2` is
skipped). A place is *inside the board* `b = world.draw.board` when, with `(dx, dy)` = place − `(cx, cy)`,
`|cos(theta)*dx + sin(theta)*dy| <= 1.05*hw + 0.02` and `|-sin(theta)*dx + cos(theta)*dy| <= 1.05*hh + 0.02` (no
board: inside). *Within d* of a place means `dist(a, b) <= d`. A world stone whose solid is missing, or whose `pos` or
`dims` has fewer than 2 entries or `q` fewer than 4, is left out of these rules, as if it were not in the world; so is
every later stone of a world id the frame lists more than once (only its first stone counts, and none when the first is
left out). The rules read `pos[0]`, `pos[1]`, `dims[0]`, `dims[1]`, `q[2]` and `q[3]`, which the API schema (`Solid`)
gives as numbers; a solid with another value there is outside the schema, and the rules give it no meaning.

**Stops and trays.** Frames of a session with a world are taken in order (revisions are not; frames without a world are
skipped). Frames the rules do not read can hide a hand at work: presence questions (below) count them. A frame whose
`world.motion` is not `static` ends the current stop. Static frames make a stop; it becomes a *visit* once the newest
frame's `t` is at least 2.0 s after its first frame's `t` (`newest.t - first.t >= 2.0`): its frames so far are then
taken in order (rules below), and its later frames as they come. A visit continues the open tray when the world ids of
its first frame's stones that are not held (at least one) were seen, at least nine tenths of them, in that tray's frames
(a new board under the camera may carry many of the last board's world ids: with half of them, aug28's trays 28 and
29 and jul30's trays 272 and 273 were one tray each);
otherwise the open tray leaves (its account, below) and the next tray opens: trays are numbered 1, 2, ... per session.
When a visit continues a tray that has arrived, the moving frames before it were not read (presence questions, below). A
session change and `finish()` make the open tray leave.

**Calm moments.** `calm` and `quiet` are 0 before a visit's first frame, and each frame of the visit sets them: `calm`
to `calm + 1` when both world hands are `free` (or absent) and the frame has no hand event (`lift`, `hinge`, `carry`,
`place`, `drop`, `gone`, or `push` with a `side`) and no `new`, `delete` or `split`, else to 0; `quiet` to 0 when the
frame has a `new`, else to `quiet + 1`. A *calm moment* is a frame where `calm` becomes 3; a *calm frame* is one with
`calm >= 3`. A tray's *last calm moment* is its last snapshot (the settle, step 4; the arrival's is the first): what
happens on that frame before the snapshot, a loss included, comes before it.

**Incomplete inventory at a boundary.** From the start of each static visit, compare the usable world ids on
consecutive frames. On an event-free frame with both hands free or absent, trusted hands and no held world stone,
remember each id present just before and now absent. This includes an id whose last row was undetected or had no
tray link. Hold its marker during the first and second consecutive frame of absence. Clear it on return or on a
third absent frame. A frame gap, revision, reset, unread frame, non-qualifying frame or new visit clears the markers.
While any marker remains, pause the calm counter and defer arrival, the latest calm frame, the settle and later
calm-frame look work. Process events, ordinary identity rules and the quiet counter normally. A marker supplies no
sighting, place or identity link.

Track a separate run of otherwise quiet observations within each static visit. A frame advances this run when the
hands are free or absent and trusted, no stone is held, no hand event, push, new, delete or split occurs, and no
unread frame intervened. Any other frame ends the run. If the third frame of the run is withheld from the inventory
snapshots, retain a reading for every sure on-tray stone whose linked world row explicitly says `detected=false`.
If a previous withheld third frame in another run recorded the same linked world id as undetected, apply the
ordinary `unseen` doubt with no presence watch before replacing the reading. A settle that tests the stone in a
different frame consumes the reading if it is in a different quiet run or is the final settle. If the world still
explicitly lists that same linked id as undetected there, apply the ordinary `unseen` doubt with no presence watch.
A deferred settle in the same run retains the reading. Start each visit with no retained readings.

**Brief omissions after arrival.** When a detected, non-held world stone that was linked or unidentified disappears
from the next static frame of the same visit, keep its link or its unidentified record pending if the frame has no
events. The last sight before the disappearance, each missing frame and the recovery must all have free or absent,
trusted hands, no held world stone and no hand activity. Hand activity includes lift, hinge, carry, place, drop,
gone, any push and a delete for `hand` or `carried-away`, even on another id. This grace covers at most two adjacent
missing frames. Their frame numbers must be consecutive, with no unread frame, gap, reset or revision between them.
An unidentified record is set aside while absent, so it cannot be matched, minted or counted as evidence. There is
no new sight, place or look for an absent id. While any omission is pending, pause the calm counter, the leaving-point
update and step 7 (including the look work). The quiet counter continues as usual.

A returning id resumes its link or unidentified record only on a consecutive readable frame of the same visit.
The returning stone must be detected, have compatible size and lie within 0.15 of its previous place. Its centre
must be strictly closer to that place than to any other compatible, detected, non-held stone on its last observed
frame. Other ids may have non-hand events such as `new` on recovery. On the returning id only `confirm` and
`freeze` are allowed. On every missing and recovery frame, compare the other detected, non-held, compatible world
ids within 0.15 of the original place with the preceding frame. A new neighbour, including one that disappeared
and returned, ends the grace. A continuously present neighbour can remain. Ordinary processing resumes on recovery.
On expiry, intervening work, an unread frame, failed recovery or the end of a visit or tray, discard the pending
unidentified record or lose the pending link at the first missing frame. An explicit ending event on a linked
id takes precedence: step 3 loses it on the event's own frame and keeps its reason. An unresolved omission is
therefore never a certain sight at closing.

**Arrival.** A tray arrives at the first frame of its visits with `calm >= 3`, `quiet >= 5` and
`stats.confirmed == stats.stones`. Its board is that frame's `world.draw.board`. Every world stone of that frame that is
not held and is inside the board becomes a tray stone, sure, standing for that world stone (its *link*), in world order;
its stamp (below), `born`, first-seen and last-seen times are the arrival frame's. Tray fact `arrived`. The arrival frame
is the tray's first calm moment (its snapshot, below) and its first latest calm frame (the leaving point, below). *Tray
order* is the order in which tray stones are made: the arrival's in world order, then each later one as it is added (the
settle, step 3; the leaving).

**Tray stone ids**: `{stamp}-{tray}-{world id}`: `stamp` = when the stone was first seen on the tray, the frame's
`wall` in UTC to the tenth, `YYYYMMDDTHHMMSS.dZ` (`n = floor(wall*10 + 0.5)`, `d = n % 10`, the date and time of
`n / 10` seconds after 1970-01-01T00:00:00Z, proleptic Gregorian), or, when the frame has no wall, `s`, the session,
`t` and `fmt(t, 1)` (world ids start again in a new session, and a seek can show the same media time again); `tray` =
the tray number; `world id` = the world id it was first seen under. Examples: `20261122T023847.0Z-2-84`,
`s1795314878t22.5-2-84`. When the tray already has a stone with that id (frames less than 0.1 s apart: a stone lost and
its world id seen again within the same tenth of a second), the new stone takes the first of `{id}-2`, `{id}-3`, ...
that the tray does not have: `20261122T023847.0Z-2-84-2`. An id is never given to two stones: not on another tray, not
in another session.

**Every later frame of the tray, in this order** (a tray that has not arrived yet does nothing else; the look store
of 4.6.3 runs first on every frame the tray takes, 4.6.6):

1. *Hand marks*: for each event that is a hand event or a `delete` with why `hand`, the place of its world stone in
   this frame, else that of the tray stone linked to its id, is marked with the frame's `t` (no mark when neither is
   there). The marks are kept until the tray leaves.
2. *Leaving point*: a hand event marks the tray as worked on; a frame with `calm >= 3` is the latest calm frame and
   clears that mark.
3. *Events on linked ids*, in world order: `lift`, `carry`, `hinge`, `place` mark the tray stone as handled; any `push`
   marks it pushed (both until the next calm moment). A `push` on an id that is not linked is read after step 6, as this
   step reads it, when step 6 links that id on this frame (each id once, in the order of its first push). An id with a
   `gone`, `drop` or `delete` loses its link: the tray stone becomes *lost*; it keeps its last place, size and last-seen
   time, its loss time is this frame's `t`, and it notes whether this frame has a `gone` for it (carried away), a `drop`
   (dropped) or a `delete` with why `hand` (emptied).
4. *Linked stones*, by world id ascending: no world stone with that id: lost unless the omission is pending (above). Held: handled, and nothing else for this
   frame. A `frozen` world stone whose size is not compatible with the tray stone's frozen size: a doubt (4.6.4), cause
   `size_changed` ("its world stone changed size"), lost, and the world stone becomes unidentified (first seen now),
   made by a size change (never added for certain: the settle, step 3). Else a frozen world stone gives the tray stone
   its *frozen size*, once: the world stone's size on the first frame on which the tray stone is linked to a frozen
   world stone (the frame it was made on included; a rename keeps it). A `detected` world stone gives its place and the
   time it was last seen.
5. *Unidentified stones*: every world stone not linked, not unidentified, not held and inside the board becomes
   unidentified (first seen: this frame's `g`, `t`, `wall`; its place and size), in world order. Then, by world id
   ascending: gone from the world: dropped from the list unless its record was set aside for a brief omission; else its place (when detected) and size are updated.
6. *Renames*: each lost tray stone whose loss had no `drop`, in tray order: the unidentified stones first seen within
   3.0 s of its loss (`|first_seen.t - loss.t| <= 3.0`), of a compatible size, within 0.15 of its place. Exactly one, and no other such lost stone fits that one the same
   way: the world renamed it; the tray stone is linked to it again (its place and, when detected, the time seen are
   the world stone's; the world stone's first-seen time is kept). Sure only when it was sure (not in question), was
   lost since the last calm moment, was not carried away or emptied, and no hand mark from
   `min(loss t, first seen t) - 3.0` on lies within 0.40 of its place or of the world stone's; else a doubt (4.6.4),
   cause `found_again` ("found again, not for sure").
7. At a calm moment, *the settle*. In a later calm frame (`calm > 3`), the look work (4.6.5).

**The settle** (at each calm moment; the look work runs after step 1, 4.6.6):

1. Each tray stone that is sure or in question (4.6.4), linked, and in the last snapshot, in tray order, has a doubt
   (4.6.4) at the first of:
   its world stone's overlap is at least 0.30 ("its box overlaps another stone"); its world stone is not detected at
   two calm moments in a row ("not seen at two calm moments"); it was pushed ("it was pushed"); a tray stone of a
   compatible size that was pushed and was in the last snapshot within 0.40 of it there ("a stone next to it was
   pushed"; with looks, a push on a freed world stone next to it counts too, 4.6.3); it was handled while a stone of a compatible size appeared within 0.40 of its place now or in the snapshot
   ("a stone appeared next to it while a hand held it"; appeared = unidentified and first seen after the last calm
   moment, or linked to a tray stone that is not trusted (4.6.4) whose world stone was first seen after it).

   Step 1 takes these stones one at a time, in tray order: when it reaches a stone, the stone's presence question, if it
   has one, is settled, ends or waits first (below), and then the stone's reasons are tested. A doubt "not seen at two
   calm moments" is a *presence question* when the stone has no look chain and nothing could have changed it since it
   was last seen (below). For a stone in a presence question that is still not seen, that doubt changes nothing and does
   not count as the stone's first reason: the step's later reasons are still tested, and a doubt from one of them ends
   the presence question (4.6.4).
2. *Certain removals*, in tray order: a lost tray stone that was lost before the last calm moment or at least 3.0 s ago
   (`t - loss.t >= 3.0`), whose last place no world stone (not held) covers with margin 0.03, and that no world stone
   could be (the *could-be test*): no unidentified stone, and no world stone linked to a tray stone that is not trusted (4.6.4), of a compatible size
   that was first seen at or after (its last seen time - 3.0) or lies within 0.15 of its last place; that a hand
   touched before it was lost (a stone does not leave a tray by itself): a *hand touch* on its linked world id, at or
   after the earlier of the last calm moment before its loss and 3.0 s before it was last seen, and at or before its
   loss; and 4.6.7 does not keep it from a certain removal. A hand touch is a `lift`, `hinge`, `carry`, `place`, `drop`
   or `gone`, a `push` with a `side`, or a `delete` with why `hand` or `carried-away`. Tray fact `removed`, certain;
   why `carried away` when the world carried it away, else `missing`. A lost stone no hand touched stays lost: a rename,
   or the leaving, pairs it or reports it removed, unclear.
3. *Certain additions*, by world id ascending: an unidentified stone not made by a size change (step 4 above), detected
   at this and the previous calm moment within 0.12 of the same place, while no tray stone of a compatible size is lost, or is on the tray and not trusted
   (4.6.4), and that 4.6.7 does not keep from a certain addition, becomes a tray stone, sure (its id stamped with the
   time it was first seen). Tray fact `added`, certain, why `set down`.
4. The snapshot: the places of the linked tray stones; handled and pushed marks are cleared.

Known limits of the certain removals and of a visit's continuation (the four published recordings against the camera,
2026-11-23): of the 52 certain removals, 49 are right; the other three are stones a hand moved
and set down on the tray while the world lost their ids (dry1's tray 10, world 643; dry2's tray 47, 2311; jul30's tray
216, 14333): no world event tells them from stones a hand took away. A stone a hand took away with no hand event on its
own id stays unclear (dry2's tray 55, world 2736). A board that changes while the world's motion stays `static` ends no
stop, so the tray goes on (aug28's tray 43, 688.6 to 938.4 s). On a bare board the world can show stones that are not
there (jul30, about 3110 to 3429 s): each board that passes is a tray of its own, and those stones are on it.

Known limits of the leaving (the same check, 2026-11-23). In dry1, dry2 and aug28 every stone that left is reported
removed, certain or unclear (before the leaving's evidence rule, the pairing had passed six of them in dry1 and dry2 to
other stones); jul30's remaining misses are the camera check's own (stones on a bare board that are not there,
textureless pavers, a board that shifts). A stone that hands moved and that the world saw again under a new id, with
nothing to show it is the same stone, is removed and the new id added, both unclear: 13 of the 23 unclear removals the
check can judge are such stones (seven on dry1's tray 2), each one its new id's candidate in the open account. Three
stones of dry1 and dry2 stay linked to a world stone that the check shows is another stone, none of them sure (ten
before the evidence rule). A detection at the leaving point counts (dry1's tray 2, world 240; jul30's trays 41 and 92,
worlds 2598 and 5894: each on a paver, by the video), and so does a stone that the leaving point's world keeps, not held
and with less than 0.30 of its box under another unheld stone's (dry1's tray 2, world 281: a stone a hand set down, which
the world kept on the tray although the model first boxed it 2.4 s after the leaving point; before this rule it was in no
account).

**Presence questions.** A frame is *busy* when a world hand is not `free` (and not absent) or is `untrusted`, the frame
has a hand event, a world stone of the frame is held (`carry` or `hinge`), or the frame has a `delete` with why `hand`
or `carried-away`; it is a *push frame* when it has a `push` event (any id, with a side or not). Busy and push frames
are noted on every frame the tray takes, from its first: the arrival frame is a frame "from `s1`" of every stone it
makes. *Frames the rules could not read* are a frame of the session without a world, a jump in `g` (frames dropped), a
`gap` or `reset` event of the stream (2.4, `InterpreterCore.gap()`), a revision (2.4, step 2), and the moving frames
before a visit that continues a tray that has arrived. The first frame the tray takes after them (for that visit, its
first frame) is a busy and a push frame, and spoils every open unseen run, a presence question's included, whether its
world stone is detected or not.

A tray stone's *unseen run* starts at a calm moment at which its world stone is not detected, after one at which it was
(or after the arrival): it notes the stone's world id, its last place, the time it was last seen (`s1`) and this calm
moment's `t` (`c1`). For a stone added for certain (4.6.1, step 3 of the settle), `s1` is the time of the frame on which
its world stone was first seen (its placing, with its hand mark) until a later frame shows it: the settle that adds it
does not move `s1`. The run ends at a calm moment at which its world stone is detected, and when the stone is lost,
wherever it is lost (every later frame's steps 3 and 4, or a look's relink, 4.6.5). A busy frame or a push frame later
than `c1` *spoils* the run when the stone's world stone is in that frame's world and not detected. The run's *first
sight* is the first frame later than `c1` on which its world stone is detected while the run is not spoilt; it notes
that frame's place, whether a frame from `s1` up to it was busy or a push frame, and whether another world stone
(detected or not) of a compatible size, not held, stood within 0.12 of the stone's last place on that frame (a *crowd*).

*Nothing could have changed the stone since `s1`* when: the run is not spoilt; the stone was not handled (a `lift`,
`carry`, `hinge` or `place` on its link) and its world stone was not held at or after `s1`; no hand mark at or after
`s1` lies within 0.40 of its last place or of its place now; and no look of its world stone read after `s1`, still fresh
(4.6.3), reaches the bar (`t_id`, 4.6.5, with `n >= N_ID`) against the chain of another tray stone of a compatible size
with a chain that is sure and lost, or on the tray and in question, wherever that stone is and whatever its `since` (the
look step's pair tests do not apply: it may be on this world stone).

At the doubt "not seen at two calm moments", a stone that is sure and not in question gets a presence question (4.6.4)
when: it has no look chain; none of the step's later reasons holds on this frame (it was pushed; a stone next to it was
pushed, or a freed push; a stone appeared next to it while a hand held it); it is linked to its run's world id; and
nothing could have changed it since `s1`. Every other doubt is as before (a stone with a chain gets the question only a
look settles, 4.6.4). A presence question keeps the run it was opened with until it is settled or ends, also after that
run has ended: a busy or push frame later than `c1` on which the stone's world stone is not detected, or frames the
rules could not read, still spoil it, and the stone's next unseen run plays no part while the question is open.

At each settle, when step 1 reaches the stone (before its tests; and on the doubt's own frame right after it), and at
the leaving's step 1, a presence question **ends** when something could have changed the stone since `s1`: the stone
becomes not sure there (fact `unsure`, why "not seen at two calm moments", code `unseen`, `opened` its doubt's frame;
its line reads "open since", 4.6.9). Else it is **settled** (the question closes with no fact; the stone is sure,
`doubted` stays true) when the stone is on the tray and linked to its run's world id; its first sight came within 0.12
of its last place, with no busy frame and no push frame from `s1` up to it and no crowd; it was last seen later than
`c1` within 0.12 of that place; and no other world stone (detected or not) of a compatible size, not held, stands within
0.12 of that place on this frame. Else it waits. A later doubt "not seen at two calm moments" changes nothing; a doubt
of another cause ends it (4.6.4); when the tray leaves, it ends undecided (4.6.7, step 3). So a doubt at the leaving's
step 1 that opens a presence question and is not settled at once ends in the leaving's step 3, with the leaving point as
its `opened`: its fact reads "open since" the leaving's own clock.

A stone settled on a calm moment that does not show it (settled at its doubt, at once, or by a sight before a later calm
moment that misses it) starts its next unseen run there (`c1` is this frame), *on probation*: when the next calm moment
that shows the stone comes (or, if the tray leaves first, the leaving's step 1 when its frame shows the stone), nothing
must have changed the stone since that run's `s1`, and the sight must settle the run as it settles a presence question
(its first sight, its last sight, no crowd); else the stone has the doubt "not seen at two calm moments" there, which is
no presence question: it becomes not sure, with a plain fact (4.6.4). A stone lost while on probation fails it so. A run
on probation that reaches a second unseen calm moment is the stone's next doubt, as any run's.

Frames the rules could not read spoil the runs open when they come and nothing else: a revision that comes after the
settle of a question it would have ended changes nothing for that question (the stone stays sure, unless its next run is
on probation: the revision spoils that run, so the next calm moment that shows the stone makes it not sure; a residual:
revisions are 0 in the four published recordings). A revision of a frame the core no longer keeps (older than its
revision window, 2.4) is dropped and changes no tray. A `delete` why `carried-away` makes a busy frame but leaves no
hand mark: after the first sight it does not end the question of a stone next to it that is detected on its frame. A
stone of a compatible size that appears further than 0.12 from the stone's place with no hand reading does not stop the
settle.

Known limits of this version (found in scenes built to attack it; in the four published recordings only one occurs,
once: on jul30's tray 232 at 1:04:53.2 a stone is settled by sight while the latest look of its world stone matches
another stone's chain at 0.644, below the tray's bar (0.750) but above its gauge (`alike`, 0.634); this was not checked
against the camera frames): a stone without a look chain is settled by sight although a look of its world stone matches
another stone's chain when that other stone opens its question later in the same step or later on, when only an earlier
look matched (only the latest stored look is scored), when the match is below the full bar `t_id` or rests on fewer than
`N_ID` pairs, or when that other stone is not sure; a neighbour whose world id was deleted before the settle is no
crowd; the settle reads no size, so a world stone seen again with another size settles; a revision among the moving
frames after the tray's last frame does not spoil a run at the leaving; a held stone whose solid the rules cannot use
does not make its frame busy.

**Leaving.** When a tray leaves, its account closes on its last frame's world, with the *leaving point* as this frame
(wherever a rule reads this frame's `g`, `t` or `wall`; stored times keep their own): the latest calm frame if no hand
worked after it, else the last frame. A continuing visit can end while its latest calm point still belongs to an
earlier visit. In that case a withheld inventory frame, third or later in an otherwise quiet run, nominates the last
complete frame of that run in this visit. Keep the most recent such nomination. If no hand has worked since the
previous calm point and the visit acquired no calm point of its own, take the nominated frame as the leaving point.
Keep its world and each positively observed on-tray stone's place and linked id. Use that place only for the same
link. For a stone linked by the final settle, read its detected, non-held place from the nominated world. Without a
nomination the ordinary leaving rule applies. An unidentified stone first seen after the leaving point (its `g` later than the
leaving point's) is left out: what appears after it is not on the tray that leaves (dry2's tray 55 left empty while the
next tray's first stones came into view). The settle's step 1 runs (when the tray's last frame is its last snapshot's
own frame, a world stone not detected there is not counted a second time when nothing could have changed the stone since
its unseen run's `s1` and no busy frame and no push frame came at or after `s1`: that calm moment tested it; else it is
counted again); then the lost tray stones and the unidentified stones are paired, nearest first (ties: tray order, then
world id), compatible sizes within 1.0, and only where there is *evidence* that the world stone is the lost one: it was
first seen at or after the lost stone was last seen, less 3.0 s, and no hand mark from the earliest of the lost stone's
last sight, its loss and the world stone's first sight, less 3.0 s, lies within 0.40 of the lost stone's place or of the
world stone's (nothing could have put another stone there; with looks, 4.6.7 adds agreeing looks as evidence and rules
out a pair whose looks disagree). Each pair is linked, not sure ("matched when the tray left"), in pairing order. A pair
without evidence is never made: a stone's id never passes to a world stone that may be another stone (a hand can take a
stone away and set another one down in its place), so the lost stone is removed and the world stone added, both
unclear, and the open account (4.6.8) lists each as the other's candidate.
Then each stone still lost, in tray order: tray fact `removed`, unclear ("not found when the tray left"). Then each
unidentified stone with positive evidence at departure (below), by world id ascending: a new tray stone, not sure, tray fact `added`, unclear ("not
recognised when the tray left"). Then the tray fact `leaving`. 4.6.7 gives the leaving's whole order, with the look
work, the questions still open and the open account.

**Positive evidence at departure.** Use a detection on the last static frame. A previously unidentified stone still
listed there as undetected also counts as present when the leaving point's world (the latest calm frame's, or the
nominated frame's) shows it detected and not held: no hand worked on the tray since, so it is still there, and its place
and size are that detection's (dry1's tray 2 keeps world stone 240 this way, a stone the tray arrived with that hands had
moved; without this rule it was in no account). Failing both, it can also count as present when it meets all the
following conditions.

- Its world id was unidentified before the chosen calm departure frame, with at least two earlier positive detections
  during its uninterrupted presence in the unidentified inventory. The id was present but undetected on that calm
  frame and detected on its immediate successor while another stone had a pending identity omission.
- The two frames were continuous, with free trusted hands, no held stone and no hand activity. The successor had
  no events. Both shapes were frozen, of compatible size, and the positive centre lay within 0.12 of the preceding
  place. Overlap on the positive observation was below 0.30. The other compatible ids within 0.15 of its place were
  already neighbours on the preceding frame.
- Through the last observation of the visit, that id remained unidentified and continuously listed, the chosen
  departure point held, the media time stayed between the positive sight and 3 s after it (inclusive), and there
  was no hand work, gap, movement, disqualifying event on
  this id, new close neighbour, incompatible frozen shape, overlap of 0.30 or more, or drift beyond 0.15 from the
  positive sight. Only `confirm` and `freeze` on this id are permitted in this interval.

Failing all of these, it also counts as present when the leaving point's world keeps it (lists it, not detected), not
held, and less than `OVERLAP` (0.30) of its box lies under one other stone's box there: the overlap share of 4.6.1,
against that world's stones that are not held, kept ones included. At a calm or a nominated leaving point no hand worked
on the tray since; when hands worked after the latest calm frame, the leaving point is the tray's last frame, and there
only `not held` and the overlap stand against a hand (14 of the 63 stones below were counted at such a leaving). The world
kept the stone on the tray although the model did not box it there; its place and size are that world's. Against the
video of the four published recordings (2026-11-23), this counts 63 stones the leaving had left out: 32 stones that were
there (dry1's tray 2's world 281 among them), 2 outlines on the tray's rail, 3 second ids of stones already counted, a
stone a hand was holding that the world did not show held, and 25 boxes on jul30's bare boards that are not there. It
leaves out 4, each kept and not held at its leaving point with 0.32 to 0.48 of its box under a neighbour's: 2 stones that
were there, and 2 that a hand was holding although the world did not show them held.

If departure pairing leaves this occupant unmatched, its fact is `added` with `certain=false` and code
`not_recognised`. Its origin remains unknown. Its place and size are those of the row it was counted from (its last
detection, the positive sight, or the leaving point's world), and `left_place` stays null when there was no detection
at the leaving point. The extra observation cannot settle an identity or establish a
worker placement.

**Tray facts** (`TrayFact`; 4.6.9 adds the kind `identified`, the fields of the looks and the codes): `kind`
(`arrived`, `unsure`, `removed`, `added`, `leaving`), `tray`, `stone` (the tray
stone id or null), `world_id` (the world id it stands for now, or null), `certain` (removed and added; else null),
`why` (or null), `g`, `t`, `wall`, and for `arrived` `stones`, for `leaving` `stones` (tray stones on the tray) and
`sure` (the sure ones among them), `added` and `removed` (the tray's certain `added` and `removed` facts: a stone set
down for certain and removed unclear later still counts as added) and `unclear` (its unclear facts). `describe()`, with
`{clock}` of `t` as in 4.1:

| kind | sentence |
|---|---|
| arrived | `{clock} tray {n} arrived: {stones} stones` |
| unsure | `{clock} tray {n}: stone {id} is not sure any more ({why})` |
| removed, certain | `{clock} tray {n}: stone {id} was removed`, plus ` (carried away)` when why is `carried away` |
| removed, unclear | `{clock} tray {n}: stone {id} not found (unclear)` |
| added, certain | `{clock} tray {n}: stone {id} was set down` |
| added, unclear | `{clock} tray {n}: stone {id} not recognised (unclear)` |
| leaving | `{clock} tray {n} leaving: {stones} stones ({sure} sure), {added} added, {removed} removed, {unclear} unclear` |

**Trays and tray stones in the API** (4.6.9 adds the fields of the looks and the open account). `Tray`: `session`,
`video`, `n`, `arrived` and `leaving` (`TrayPoint {g, t, wall}`; `arrived` null until it arrives, `leaving` null while
it is on and for a tray that never arrived), `stones` (`TrayStone`s, in tray order), `facts` (its `TrayFact`s),
`window()` = `(arrived.t, leaving.t)` (null until it has left), `stone(id)`, `report()` (4.7). `TrayStone`: `id`, `world_id` (its link or
null), `status` (`on`, `lost`, `removed`), `sure`, `added` (a certain placement or an occupant whose origin could not be matched), `certain` (a removed
stone's is its removal's, an added stone's that is not removed its addition's, else null), `born` (`TrayPoint` of when
it was first seen), `place` `[x, y]` and `size` `[long, short]` (as last known; for a stone counted from the leaving
point's world, boxed or kept there (4.6.1), as that world has it), `first_place` `[x, y]` (its place
when the tray stone was made), `left_place` (`[x, y]` at the tray's leaving point, or null) and `touched` (the frame
where something last touched it, or null), the last three for the report (4.7). `TrayFact` also carries the tray's
`session` and `video`. `state.tray` is the open tray (null between trays). `interpreter.trays()` lists the trays so far,
oldest first: those that have left (the newest 256, across sessions) and the open one; `replay.trays()` lists every tray
of the recording. The core keeps only the open tray's working state; a tray that has left is its `Tray`.

#### 4.6.2 The look score

A world stone may carry a `look` (`StoneLook`): the 20.20 unit sends looks since build claude-20261120-looks1 (fixer
thin-v1, on every camera unless a catalog entry's stone model turns thin.lookOut off); the four release recordings, made
with build claude-20261122-hr4x1, carry them. A look is a band-pass texture of the stone's face, read while the stone
rests untouched, and sent only on the packet it was read on. The look score `score(A, B)` says how well look `A` agrees
with look `B`. It is a double from -1 to 1, or none. It is computed from exact integers, so every SDK gives the same
double.

- **Numbers.** A *number* here is a JSON number by its value: never a boolean or a string, and never infinite (a JSON
  number too large for a double is not one); its value is its double. A *whole number* is a number whose value is an
  integer from -2^53 to 2^53: `3` and `3.0` are both 3; `1.5` is not a whole number, and neither is 2^53 + 2.
- **Fitting `StoneLook`.** A look fits `StoneLook` when `sp` and `q` are numbers; `v`, `g`, `nu` and `nv` are whole
  numbers; `px` is an array of numbers; `at` is an object whose `cx`, `cy`, `theta`, `L` and `S` are numbers; and `d` is
  a string. This is the shape the API schema gives `StoneLook` by type; the schema also fixes `v` at 1, `nu` and `nv` at
  3 or more and `px` at two numbers, which a unit keeps to, but a look that breaks only those still fits. A look that
  does not fit is dropped by the models: the world stone holds no look (`StoneView.look` is none), and the stone and its
  frame read as they would without it. A look that fits but breaks a limit below (another `v`, a side of no cell, more
  than 4096 cells, a bad `d`) is kept by the models, and is no look to the score and the tray rules.
- **Reading a look.** A look is none (not a look) unless all of these hold:
  - it fits `StoneLook`, and `v` is 1;
  - `nu >= 1`, `nv >= 1` and `nu * nv <= 4096` (which keeps every sum below 2^53);
  - `d` is canonical base64 (RFC 4648, padded: decoding it and encoding the bytes again gives `d` back) of exactly
    `nu * nv` bytes. Its length is then `4 * ceil(nu * nv / 3)`: the SDK checks that first, so a look with a longer `d`
    is none without being decoded.

  The cells:
  - byte `j * nu + i` is cell `(i, j)` (row `j`, column `i`), in two's complement, and -128 means not read;
  - a look's `L = max(at.L, at.S)` and `S = min(at.L, at.S)`;
  - it is *near square* when `L > 0` and `(L - S) / L < 0.12`;
  - `n` is its number of read cells.

  A look that is none is ignored as if absent. It never makes the frame or the world stone unreadable.
- **B's turns**, in this order:
  - `B` as it is (`nv` rows of `nu`);
  - half round, `H[j][i] = B[nv-1-j][nu-1-i]`;
  - only when both looks are near square: a quarter round, `Q[r][c] = B[c][nu-1-r]`, and three quarters,
    `T[r][c] = B[nv-1-c][r]` (each `nu` rows of `nv`).
- **A placement** puts A's cell `(0, 0)` on row `ov`, column `ou` of a turned B. Its pairs are A's read cells whose
  cell in B exists and is read.
  - Over the pairs, as exact integers: `n` (the pairs), `sa = sum a`, `sb = sum b`, `saa = sum a*a`, `sbb = sum b*b`,
    `sab = sum a*b`.
  - Let `need = max(24, floor((min(nA, nB) + 1) / 2))`, with `nA` and `nB` the looks' read cells.
  - Its correlation is none when `n < need`. Otherwise let `da = n*saa - sa*sa` and `db = n*sbb - sb*sb` (integers).
    It is none when `da <= 0` or `db <= 0`. Otherwise it is `(n*sab - sa*sb) / sqrt(double(da) * double(db))`: the
    numerator converted to a double, and the division and square root in doubles.
- **One turn.**
  - The centred offsets are `ov0 = floor((rows of B - nv of A) / 2)` and `ou0 = floor((columns of B - nu of A) / 2)`
    (floor towards minus infinity).
  - Whole-cell shifts: `dv` from -3 to 3 (outer loop), `du` from -3 to 3 (inner loop), at placement
    `(ov0 + dv, ou0 + du)`. The turn's `top` is the first greatest correlation, at `(tv, tu)`: a later one replaces it
    only when strictly greater. With no correlation at any shift, the turn is skipped.
  - Then half-cell shifts `(hv, hu)`: `hv` from -1 to 1 (outer), `hu` from -1 to 1 (inner), not `(0, 0)`. Each is a
    half-cell copy of B with `nv` of A rows of `nu` of A cells:
    - its cell `(i, j)` is the sum of B's cells at rows `j + ov0 + tv + a` and columns `i + ou0 + tu + c`;
    - `a` is in `{0}` when `hv == 0`, `{0, 1}` when `hv == 1` and `{-1, 0}` when `hv == -1`; `c` follows `hu` the same
      way;
    - that cell is read only when all of those cells exist and are read.

    Its correlation at placement `(0, 0)` replaces `top` when strictly greater.
- **The score.** `score(A, B)` is the greatest `top` over the turns, the first one when equal. It is none when every
  turn was skipped, or when either is not a look. It is not symmetric: `score(A, B)` turns and shifts B under A.
- **The pairing.** `pairing(A, B)` is `score(A, B)` together with `n`, the pair count of the placement that gave that
  value: the whole-cell placement or half-cell copy that last set the winning turn's `top`. It is none exactly when the
  score is none.
- **Permille.** `p(A, B) = floor(score(A, B) * 1000 + 0.5)` is computed as 4.5's `fmt` computes `n`: an IEEE multiply,
  then an IEEE add, then floor. In Go that is `math.Floor(float64(s*1000) + 0.5)`; never let the multiply and the add
  fuse. It is an integer from -1000 to 1000, or none. The tray rules compare only these integers.
- **The fixture.** `fixtures/looks/looks-synthetic.json` holds made-up looks (`looks`, by name; no camera picture) and:
  - `unreadable`: the looks that are none;
  - `tray_unusable`: the looks this section reads that the tray rules do not use (4.6.3);
  - `model_none`: the looks that do not fit `StoneLook`, which the models drop;
  - `scores`: `[a, b, score, n, p]` for pairs of the other looks: `score(a, b)` as the shortest text that reads back to
    the same double, the pairing's `n`, and the permille (null: none).

  Every SDK's score, `n` and permille equal it bit for bit.

#### 4.6.3 Looks on a tray

Three of 4.6.1's numbers have names here: `NEAR` = 0.12 (an unidentified stone at the same place at two calm moments),
`HAND_R` = 0.40 (a hand mark, or a pushed neighbour, near a stone) and `LEAVE_D` = 1.0 (the leaving's pairing).

**Usable looks.** The tray rules use a world stone's look only when 4.6.2 reads it and also all of these hold:
- `sp` is 2 and `q` is 32 (whole numbers);
- `nu >= 3` and `nv >= 3`;
- `at.L > 0` and `at.S > 0`;
- at least 24 of its cells are read.

A world stone that 4.6.1 leaves out (no usable solid) has no look. The look's own `g`, `px` and the rest of `at` are not
read: a look *came on* the frame the tray rules took it from, and every "after" below compares frame `g`s. The rules
take frames with strictly increasing `g` (4.6.1: revisions and duplicates are not taken).

**The look store** belongs to the tray. It is empty when the tray opens, and runs on every frame the tray takes, from
its first frame on (before the arrival too). On each frame, in this order:
1. it forgets the world id of each event of the frame of type `push`, `lift`, `hinge`, `carry`, `place`, `drop`,
   `gone`, `delete` or `split` (the *look clearers*);
2. it forgets each world id that has no world stone in this frame;
3. it stores the looks of this frame: each world stone of the frame, in world order, that is not held (mode `carry` or
   `hinge`), lies inside the tray's board (any place before the arrival, when the tray has no board yet), and has a
   usable look. That look becomes its id's look, replacing any older one, together with:
   - this frame's `g` and `t`;
   - the stone's place and size in this frame, and whether it is `detected` in this frame;
   - *taken* false.
4. on the arrival frame, after this frame's store and before the arrival, it forgets each look that came before the first
   frame of the arrival's calm run (the frame on which `calm` became 1): hands may have worked on those stones since.

So a look stored on the frame of an event on its stone is kept. The engine reads a look only on an untouched face.

A stored look is **fresh** on a frame when all of these hold:
- its world stone is in that frame and not held;
- the stone lies within `NEAR` (0.12) of the place stored with the look;
- no hand mark (4.6.1, every later frame's step 1) with a `t` greater than the look's `t` lies within `HAND_R` (0.40)
  of that stored place.

**Chains.** Each tray stone has a chain of none, one or two looks: its *anchor* (the first) and its *latest*. A chain of
one look has that look as both.

The **chain score** of tray stone X against a look L of a world stone (L is always the first argument of `p`, whether or
not it is the newer look):
- a chain look that is L itself (the same world id and frame `g`) is not scored;
- the chain score starts as `p(L, anchor)` with its `n` (4.6.2);
- when the latest is another look, `p(L, latest)` replaces it when that is not none and the first is none, or when it is
  strictly greater.

**The gauge** belongs to the tray: `alike` (an integer or none) and `alike_n` (a count), set by 4.6.5. The tray's
identification bar is:
- `T_id = 900` (`T_ID_START`) while `alike_n < 20` (`GAUGE_MIN`);
- otherwise `T_id = max(750, alike + 100)` (`T_ID_MIN`, `GAP`).

It is read wherever it is used.

**Disturbances and lifts** apply to each tray stone. Both are kept without looks, and only look rules read them.
- It is *disturbed* on a frame by any of these:
  - v1's handled or pushed marks set on that frame;
  - a `push` event of that frame that names the world id of another tray stone on the tray, of a compatible size, when
    both stones were in the last snapshot within `HAND_R` of each other there (the disturbed stone's status now is not
    read);
  - a `push` event of that frame that names a freed world stone (4.6.5, applying, step 2) still unidentified, when the
    tray stone is of a size compatible with that world stone's unidentified record (its size and last known place as
    the previous frame left them) and was in the last snapshot within `HAND_R` of that place; it also gets the *freed
    push* mark, which the settle's step 1 doubts as a pushed neighbour (4.6.1).

  A push read after the renames (4.6.1, every later frame, step 3) disturbs as one read in step 3 does. `disturbed` is
  the `g` of its latest disturbance. The snapshot clears it, with the freed push mark and v1's handled and pushed marks.
- It is *lifted* for the rest of the tray by a `lift`, `hinge`, `carry` or `place` event on its link, or by its world
  stone being held.

#### 4.6.4 Doubts and questions

**States.** A tray stone is *sure*, *in question* or *not sure*.
- *Not sure* is final: the stone has the fact `unsure`, or was added unclear.
- *In question* means a doubt is held open for a look, or for the stone's next sight (a presence question, 4.6.1), to
  settle. Only a stone with a chain, or a stone without one in a presence question, can be in question. It is not sure
  meanwhile, but no fact has been given.
- A tray stone is *trusted* when all of these hold:
  - it is on the tray and sure;
  - `doubted` is false: it has never been in question or not sure on this tray;
  - `by_look` is false: no look decision linked it (4.6.5).

  Without looks, "trusted" is "on the tray and sure, and never in question": a stone whose presence question was settled
  is sure, but not trusted (`doubted` stays true).

**A doubt** comes wherever a reason of 4.6.1 holds (the stone becomes not sure or in question), except at the leaving's
pairing:
- the five reasons of the settle's step 1;
- every later frame's step 4, "its world stone changed size";
- step 6 (renames), "found again, not for sure";
- and the look's own doubt, "its look changed" (4.6.5).

It carries v1's why text and its cause code (4.6.9). A doubt of a stone that is not sure does nothing. Otherwise
`doubted` becomes true, and then:
- **A presence question (4.6.1), a stone without a chain that is sure and not in question:** it gets a question (the
  cause `unseen`, the why, `opened` this frame, `since` this frame's `g`) that keeps a copy of its unseen run.
- **A stone in a presence question:** a later doubt `unseen` changes nothing and does not count as the stone's first
  reason: the settle's later reasons are still tested (4.6.1). A doubt of another cause ends the presence question: the
  stone becomes not sure with the question's why, code and `opened`.
- **A stone with a chain, when the cause is not `overlap`:**
  - if it is sure, it gets a question: the cause, the why, `opened` (this frame's `g`, `t`, `wall`) and `since`
    (below), and it is in question;
  - if it is already in question, its `since` becomes the larger of the two. The cause, why and opened are kept. No
    fact.
- **Otherwise (no chain, or `overlap`):** it becomes not sure, with the fact `unsure` (why, code). If it was in
  question, the question ends there, and the fact carries the question's why, code and `opened` instead.

`since` is the first frame whose looks count as evidence for the question:
- for `pushed`, `neighbour_pushed` and `appeared`: the stone's `disturbed + 1` when it was disturbed since the last
  snapshot, else this frame's `g`;
- for `unseen`: this frame's `g`;
- for `size_changed` and `found_again`: this frame's `g + 1`;
- for `look_changed`: the `g` the changed look came on.

**A question ends** in one of three ways:
- **Settled by a look decision (4.6.5).** The stone is sure again, and no fact is given.
- **Seen again (4.6.1, presence questions).** The stone is sure again, and no fact is given.
- **Undecided.** The fact `unsure` gets the question's why, its cause as code, and `opened` its opened point, on the
  frame where the question ends. The stone is then not sure. A question ends undecided:
  - by an `overlap` doubt (above);
  - for a presence question, at a settle or the leaving's step 1 where something could have changed its stone (4.6.1),
    or at a doubt of another cause;
  - just before its stone is removed for certain (4.6.7);
  - or when the tray leaves (4.6.7).

#### 4.6.5 The look work

The look work runs:
- on the arrival frame, after the arrival;
- on every later frame with `calm >= 3`: inside the settle on a calm moment, otherwise on its own;
- when the tray leaves (4.6.7).

It has three steps, in this order.

**1. Take looks.**
- The stored looks that are fresh on this frame and not taken are taken, by world id ascending, at most 16 of them
  (`N_TAKE`). The rest wait for a later look work.
- For each look taken, in that order:
  1. **Taken:** it is marked taken.
  2. **Gauge:**
     - Its partners are the other world stones of this frame that have a fresh taken look, lie inside the board, are of
       a size compatible with this stone's, and whose place is at least `0.5 *` this stone's long side from its
       place. They are ordered by distance, then world id. Places and sizes are this frame's. The stone of the look
       taken need not lie inside the board (a look stored before the arrival may lie outside it).
     - For each of the first 2 (`GAUGE_K`): `v` is the larger of `p(this, that)` and `p(that, this)` that is not none.
     - When there is a `v`: `alike = max(alike, v)` (or `v` when `alike` is none), and `alike_n` grows by 1.
  3. **Own compare:**
     - It applies when the world stone is linked to a tray stone X that has a chain and is *untouched*: sure, not in
       question, never lifted on this tray, and not disturbed since the last snapshot. Let `s, n` be X's chain score
       against the look.
     - When `s >= T_id` and `n >= 100` (`N_ID`), the look becomes X's latest.
     - When `s` is not none, `s < 400` (`T_DIFF`) and `n >= N_ID`: X has a doubt, cause `look_changed` (why "its
       look changed"). When X was trusted (4.6.4) before this doubt, the tray becomes relinked (4.6.7).
     - Otherwise nothing happens.

**2. Anchors.** Each tray stone, in tray order, that is on the tray, has no chain, and whose world stone has a fresh
taken look:
- when it is untouched (above), its world stone was `detected` on the frame the look was stored, and its count of calm
  moments in a row not detected (`ghost`, the settle's step 1 in 4.6.1) is 0, that look becomes its anchor (and its
  latest);
- otherwise it is marked `late`.

**3. The look step.** It decides one pair at a time and runs again after each decision, until a run decides nothing.
- **Rows**, in tray order, are the tray stones with a chain that are either on the tray and in question, or lost and
  not not-sure (sure or in question). A row's `since`:
  - for an on row: its question's `since`;
  - for a lost row in question whose latest loss came from a look decision (applying, step 1 below): its question's
    `since`;
  - for any other lost row: `lost_g + 1` (the frame after its latest loss; every loss sets `lost_g` to the `g` of its
    frame), or its question's `since` when that is larger.
- **Columns**, in world order, are the world stones of this frame that meet all of these:
  - not held and inside the board;
  - with a fresh taken look;
  - unidentified, or linked to a tray stone that is in question or not sure.
- **Pairs.** The pairs of row X are the columns W that meet all of these:
  - of a size compatible with X's;
  - with `dist(X.place, W.place) <= 1.0` (`D_MATCH`);
  - whose look came on a frame with `g >= X.since`, and with a `t` at or after the tray's latest hand mark (4.6.1,
    every later frame, step 1; any look when the tray has none);
  - when X is lost and was carried away or emptied: first seen on the tray after X's loss (`first_seen.t > loss.t`,
    with an unidentified W's first-seen time, or the first-seen time of a linked W as its tray stone's world stone).

  They are taken nearest first (ties: world id), the first 4 (`K_PAIR`). The pair's score `S` and its `n` are X's chain
  score against W's look. X's place and size are the tray stone's as last known; W's are the world stone's in this
  frame.
- **Neighbours** of a column W are the tray stones on the tray with a chain, of a size compatible with W's, within 0.40
  (`D_NEIGH`) of W's place. They are taken nearest first (ties: tray order), the first 4 (`K_NEIGH`). A neighbour's
  score is its chain score against W's look.
- **Hits** of W are the distinct tray stones that score at least `T_id`, with `n >= N_ID`, against W's look: as a row
  with W among its pairs, or as a neighbour of W. W is a **twin** in this run when it has two or more hits. Those
  stones' ids join the tray's `twins`, kept until it leaves.
- **Decided.** A pair (X, W) is decided when all of these hold:
  - W is not a twin in this run;
  - `n >= N_ID`;
  - `S >= bar`;
  - `S - r >= 150` (`M_ID`) for every rival score `r` that is not none. Its rivals are:
    - the scores of X's other pairs;
    - the scores of the other rows' pairs with W;
    - the scores of W's neighbours other than X;
  - no tray stone other than X could be on W unscored (the *unscored block*): none that is not removed, has no chain, is
    of a size compatible with W's, and is linked to W, lies within `D_NEIGH` of W's place, or was disturbed since the
    last snapshot and lies within `D_MATCH` of W's place. No score rules such a stone out.

  The `bar` is `T_id` when X is linked to W now and no tray stone other than X that is not removed and has no chain is
  of a size compatible with W's and lies within `D_NEIGH` of W's place. Otherwise the bar is `max(T_id, 800)`
  (`T_FIRM`).
- **Each run** applies the decided pair with the highest `S`. Ties go to the row first in tray order, then to the
  lower world id. Then the step runs again.

**Applying** a decided pair (X, W), with L as W's stored look:
- **If X is on the tray and linked to W:** X's question ends, settled. X is sure, and L becomes its latest. No fact.
- **Otherwise**, in order:
  1. If W is linked to a tray stone Y, Y's link ends. Y is lost, as in 4.6.1 (every later frame, step 3: at its last
     place, size and last-seen time; `lost_g` is this frame's `g`), and its loss came from a look decision. `look_lost`
     is set.
     A question of Y stays.
  2. If X is on the tray, linked to W0, that link ends. When W0 is in this frame, not held and inside the board, it
     becomes unidentified (first seen on this frame, with its place and size), and gets `freed`.
  3. X is linked to W, as a rename links (4.6.1, every later frame, step 6):
     - its status is `on`;
     - its place is W's place;
     - its seen time is this frame's `t` when W is detected;
     - its world stone's first-seen time is the `t` of W's unidentified record when W was unidentified (W then leaves
       the list), else Y's;
     - carried away, dropped and emptied are cleared;
     - its place in the last snapshot becomes W's place (where the look found it).

     X's question ends, settled. X is sure, L becomes its latest, and `by_look` is set. The tray is marked *relinked*
     (4.6.7).
  4. Tray fact `identified` (4.6.9):
     - why "found again by its look" (code `look_found`) when X was lost, else "recognised by its look" (code
       `look_moved`);
     - `world_id` W, and `from_world` W0 or null;
     - `score` S;
     - `margin`: S minus the largest rival score, or null when no rival had one;
     - `bar`.

A swap of two stones that a row push left under each other's world ids gives two facts in one look work. The first
decided gives `look_moved`. The second gives `look_found`, because its link ended with the first decision.

Every decision is a function of the tray's state alone: the stores, the chains, the links and the gauge. There is no
budget. An SDK may keep each `p` it computed (keyed by the two looks' world ids and frame `g`s) and must not compute
fewer than the rules ask for.

#### 4.6.6 Every frame and the settle

| Where | What runs, in order |
|---|---|
| **Every frame the tray takes**, from its first | The look store (4.6.3). Busy and push frames are noted, and a frame after frames the rules could not read spoils every open unseen run (4.6.1, presence questions). Then 4.6.1 as written. Before the arrival nothing else runs. On the arrival frame: the store forgets the looks from before the calm run (4.6.3, step 4), then the arrival, then the look work (4.6.5). |
| **Every later frame** | 1 hand marks; 2 the leaving point. 3 events on linked ids: v1, plus disturbances and lifts (4.6.3), read with the links as they are before this step's losses; a loss sets the stone's `lost_g`; a push on a freed unidentified stone disturbs its neighbours (4.6.3); a handled stone notes the time; a loss ends the stone's unseen run; after the losses, a busy or push frame spoils the unseen runs of the linked stones not detected on it (4.6.1). 4 linked stones: v1, where a held world stone also disturbs and lifts, and "changed size" is a doubt; a held world stone notes the time; a loss ends the stone's unseen run; a detected world stone gives an unseen run its first sight (4.6.1). 5 unidentified stones: v1. 6 renames: v1, then the pushes read late (4.6.1, step 3). 7 at `calm == 3` the settle; at `calm > 3` the look work. The look work's relink (4.6.5) ends the unseen run of the stone it takes the world stone from; a stone it moves keeps its run, which no longer matches its world id. |
| **The settle** | 1 for each stone that is sure or in question, in tray order: its presence question settled, ended or waiting (4.6.1), then v1's sure checks, giving doubts and presence questions (4.6.4). 2 the look work (4.6.5). 3 certain removals (4.6.7). 4 certain additions (4.6.7). 5 the snapshot (v1), which also clears `disturbed` and the freed push marks. |
| **Leaving** | 4.6.7. |

The order inside a frame is the table's. A look that arrives on a frame with hand work is stored there, and taken at the
next look work where it is still fresh.

#### 4.6.7 Certain removals and additions, and leaving

**Relinked.** A tray becomes *relinked*, for the rest of its life, when a look takes its account where v1's could not
go:
- a look decision changes a link on it (4.6.5, applying);
- a `look_changed` doubt falls on a trusted stone (4.6.5, own compare);
- twins keep a stone from a certain removal (below).

A relinked tray makes no certain removal or addition. `by_look`, `look_lost` and `freed` are set only by a look
decision, so they come with a relinked tray.

**Certain removals.** On a relinked tray, none. Otherwise 4.6.1's rule applies (the settle's step 2), in tray order. A
stone the rule would remove whose id is in the tray's `twins` is kept instead: the tray becomes relinked, and no stone
after it is removed for certain. A stone in question that is removed for certain first ends its question undecided
(fact `unsure`), on the same frame, before the `removed` fact.

**Certain additions.** On a relinked tray, none. Otherwise 4.6.1's rule applies (the settle's step 3). It never adds a
stone made by a size change, nor one with `freed`. A stone added for certain is sure. It takes its anchor in a later
look work, like any sure stone.

**Why the certain facts are v1's.** A certain removal or addition reads only these: the links, the lost stones (their
places, sizes, times and carry marks), the unidentified stones, the frame's world, the snapshots, which tray stones are
trusted, and the places and sizes of the stones on the tray that are not trusted, with the times their world stones
were first seen. Until the tray is relinked, all of them are v1's on every frame:
- every doubt v1 gives a trusted stone, the rules with looks give on the same frame (the same tests read the same
  values), and in both the stone is then not trusted;
- every other doubt, a question and a settled question (a presence question too: its doubt is v1's, on v1's frame) fall
  on a stone that is not trusted (`doubted` stays after a settled question) and change no link, so what is trusted stays
  v1's;
- naming twins changes nothing a certain fact reads;
- the three events that would change one of these values relink the tray as they happen. A look decision moves links. A
  `look_changed` doubt of a trusted stone changes what is trusted. Twins keeping a stone from a certain removal keep it
  lost where v1 removes it.

So until the tray is relinked, its certain facts are v1's, on the same frames and in the same order; after that there are
none. A tray's certain facts with looks are the first of v1's: the maintainers' checks and every SDK's tests check this
on each tray of `trays-looks-synthetic` against its copy without looks (the maintainers' checks also check that every
one of v1's certain facts on a frame before the one the tray was relinked on is there). A look never makes a fact
certain: it can only hold back what v1 would make certain after it. That stone is then left open (unclear), found by its
look (an `identified` fact, which is never certain), or paired with a lost tray stone when the tray leaves (step 4
below: that tray stone's `unsure` fact `matched_at_leaving` and its open entry name the world id). The leaving adds only
the unidentified stones with positive departure evidence (4.6.1). A held-back addition whose world stone is gone when
the tray leaves is not in the account at all. One without positive departure evidence gets no `added` fact, but can
still be paired (step 4) or be a `world` candidate of an open entry (4.6.8).

**Leaving.** The account closes on the last frame's world with the leaving point as this frame, as in v1, without the
unidentified stones first seen after the leaving point (v1's rule). Wherever a
rule reads this frame's `g`, `t` or `wall`, the leaving reads the leaving point's: a question's `opened`, a `since` that
is this frame's `g`, a loss's `t` and `lost_g`, a freed stone's first-seen time, a stone's seen time, and the facts. Stored
times (first-seen times, `disturbed`, marks, looks) keep their own. In this order:
1. v1's settle step 1, with doubts as in 4.6.4. A question opened here has the leaving point as its `opened`;
2. the look work (4.6.5);
3. each tray stone still in question, on the tray or lost, in tray order: its question ends undecided (fact `unsure`);
4. v1's pairing of the lost and the unidentified stones (nearest first, ties tray order then world id, compatible sizes
   within 1.0, each pair only with evidence: 4.6.1, Leaving). With looks, a lost stone S and an unidentified world stone
   W whose looks agree (S's chain against W's stored look: at least `t_id` over at least `N_ID` cells) have evidence
   too, and a pair whose looks disagree (below `T_DIFF` over at least `N_ID` cells) has none, whatever the hands did.
   Each pair is linked, not sure ("matched when the tray left", code `matched_at_leaving`). This doubt is never a
   question. A stone that is already not sure gets no second fact;
5. v1's unclear removals (in tray order) and unclear additions (by world id ascending);
6. the open account (4.6.8), made while the unidentified stones not added are still listed; then that list is emptied;
7. the snapshot, and the tray fact `leaving` with `open` and `t_id` (4.6.9).

**Without looks.** On a tray whose frames carry no usable look, the store keeps nothing, no look is taken, the gauge
stays empty (`t_id` null) and no stone gets a chain. So every doubt but a presence question (4.6.1) takes 4.6.4's
"otherwise" branch: v1's `unsure` fact, with v1's why, on v1's frame, in v1's order; the only questions are presence
questions. `by_look`, `look_lost`, `freed`, `twins` and *relinked* are never set, and `doubted` is true exactly when the
stone is or was in question, or is not sure, so "trusted" is "on the tray and sure, and never in question" (4.6.4). The
look step has no rows and no columns; at the leaving, step 2 does nothing, step 3 ends the presence questions still open
(a doubt of the leaving's step 1 among them, `opened` the leaving point: 4.6.1), and step 6 only fills the open account.
The new fields change no count and no summary key; describe() adds "; open since" to the `unsure` fact of a presence
question that ends (4.6.9). `trays.txt`, the events, activities and summaries are v1's, and `open.txt` is new. All of
this state belongs to the tray, so a tray without looks gives v1's account even in a session whose other trays carry
looks.

#### 4.6.8 The open account

A tray stone is **settled** at the leaving when it is on the tray and sure, or removed for certain. Every other stone is
**open**: on the tray and not sure; removed unclear by this leaving; or added unclear by this leaving. Each open stone
gets one `TrayOpen` entry, in tray order. The list is given in both modes, with looks and without.

`TrayOpen` fields:
- `stone`: its tray stone id;
- `world_id`: its link when the account closes (after the leaving's pairing), or null;
- `kind`: `unsure`, `removed` or `added`;
- `cause`: the reason it is open, with codes per kind (below);
- `look`: why the looks could not settle it (below);
- `score`: an integer or null (below);
- `hand_near`, `seen_at_arrival`: for `added`, else null;
- `candidates`: a list of `TrayCandidate`.

**`cause`:**
- for `unsure`: the code of its `unsure` fact (4.6.9).
- for `removed` (why it was not removed for certain), the first that holds:
  1. `look_lost`;
  2. `by_look`;
  3. `twins`;
  4. `relinked`: the tray is relinked (4.6.7);
  5. `lost_late`: it was lost after the latest snapshot before the leaving, so no settle checked it;
  6. `covered`: a world stone of the last frame that is not held covers its last place, with margin 0.03;
  7. `rivals`: 4.6.1's could-be test (the settle's step 2) holds on the last frame, with the unidentified stones the
     leaving did not pair or add still listed;
  8. `no_hand`: no hand touched it before it was lost (4.6.1, the settle's step 2);
  9. `unchecked`: none of these.
- for `added` (why it was not added for certain), the first that holds:
  1. `freed`;
  2. `size_changed`: its world stone was made unidentified by a size change (4.6.1, every later frame, step 4);
  3. `relinked`: the tray is relinked (4.6.7);
  4. `doubtful`: a tray stone of a compatible size, other than the stones added unclear by this leaving, is lost or
     removed unclear by this leaving, or is on the tray and not trusted;
  5. `seen_once`: no settle listed it, or at the last settle that listed it, it had not been detected within `NEAR`
     (0.12) of one place at that calm moment and the one before;
  6. `unchecked`: none of these.

**`look`, for a tray stone's entry** (`unsure` or `removed`). Here the *last run* means the leaving's last look-step
run, the one that decided nothing. The first that holds:
1. `none`: it has no chain, and was never marked `late`;
2. `late`: it has no chain, and was marked `late`. A look of its world stone came only when it could not take an
   anchor;
3. `box`: an `overlap` doubt made it not sure;
4. `stale`: it was not a row in the last run, or it was a row with no pair. No fresh look of a world stone it could be
   came after its doubt or loss and at or after the tray's latest hand mark;
5. `tie`: in the last run, one of its pairs had `S >= bar` and `n >= N_ID` but was not decided (a rival within
   `M_ID`, a twin, or the unscored block). `score` is the greatest such `S`;
6. `low`: otherwise. `score` is its best pair `S` (first in pair order on ties), or null when all are none.

**`look`, for an `added` entry** (its world stone W), the first that holds:
1. `none`: W was not a column in the last run;
2. `tie`: some row's pair with W reached that row's bar with `n >= N_ID` but was not decided. `score` is the greatest
   such `S`;
3. `new`: otherwise. `score` is the best row pair score with W (ties: tray order), or null.

`score` is null for every other look code.

**`hand_near`**: a hand mark with a `t` from W's first-seen `t - 3.0` to its first-seen `t` lies within `HAND_R` of
W's place (W's unidentified record). **`seen_at_arrival`**: W's world id was in one of the tray's frames up to and
including its arrival frame.

**`candidates`.** Every reading the evidence leaves, ranked. Its entries are typed:
`TrayCandidate {kind: world | stone | gone | unseen | new, world_id, stone, score, why}`. A `world` entry has
`world_id`, `stone` (or null) and `score` (or null); a `stone` entry has `stone` and `score` (or null), and `world_id`
null; a `gone` entry has only `why` (or null); `unseen` and `new` have every field null. Every other field is null.

A *free* world stone is a world stone of the last frame that is not held, lies inside the board, and is not linked to a
sure tray stone. It may be detected or not: in the last frames the board is often already moving, and its boxes are not
detected.

For a tray stone's entry X, in this order:
1. when X is on the tray: its own world stone, `{world, X's link, X, S of X's pair with it in the last run or null}`;
2. the other free world stones of a size compatible with X's, within `LEAVE_D` (1.0) of X's place:
   - first those with a score in the last run (X's pairs), by score descending, then world id;
   - then the rest by distance, then world id.

   `stone` is the tray stone linked to it at the end of the leaving, or null;
3. `gone`. Its `why` is the first that holds:
   - `carried_away`, `emptied` or `dropped`, checked in this order: for a `removed` entry, when its latest loss had that
     mark (v1's marks of the loss);
   - `hand`: a hand mark at or after the moment the stone became open lies within `HAND_R` of its place. That moment is
     its latest loss for `removed`, and for `unsure` the `opened` point of its `unsure` fact (or the fact's own point
     when it has none);
   - otherwise null;
4. for `removed`: `unseen`. The world may hold no box for a stone that is still there.

For an `added` entry W, in this order:
1. the tray stones that are open at this leaving and were not added by it (not sure on the tray, or removed unclear by
   it), of a size compatible with W's, within `LEAVE_D` of W's place:
   - first those that were a row with W among their pairs in the last run, with a score, by that pair's `S`
     descending, then tray order;
   - then the rest by distance, then tray order;
2. `new`.

A sure tray stone, a stone removed for certain, and a world stone linked to a sure stone are never candidates.

**describe().**
- `TrayCandidate.describe()`:
  - a world entry is `world {world_id}`, followed by ` {milli(score)}` when it has a score;
  - a stone entry is `stone {id}`, followed by ` {milli(score)}` when it has a score;
  - `gone` is `gone`, followed by ` ({why})` when `why` is not null;
  - otherwise the kind itself (`unseen`, `new`).
- `TrayOpen.describe()` is `stone {id}: {kind} {cause}, look {look}`, followed in this order by:
  - ` {milli(score)}` when `score` is not null;
  - `, hand near` when `hand_near` is true;
  - `, seen at arrival` when `seen_at_arrival` is true;
  - `: ` and the candidates' describe() joined by ` or `.
- `milli(p)` is an integer printed with three decimals, with integers only: `-` then `milli(-p)` when `p < 0`; else
  `floor(p / 1000)`, then `.`, then `p mod 1000` zero-padded to 3 digits. So 853 is `0.853` and 1000 is `1.000`.

Examples, made up to show the form:

```text
stone 20261117T233109.5Z-2-46: unsure pushed, look low 0.612: world 46 0.612 or world 198 0.301 or world 48 or gone (hand)
stone 20261117T233109.5Z-2-80: removed rivals, look stale: world 238 or world 240 or gone (emptied) or unseen
stone 20261117T233342.0Z-2-256: added doubtful, look new 0.214, hand near: stone 20261117T233109.5Z-2-61 0.214 or new
```

#### 4.6.9 Facts, codes, describe() and the API

**Tray facts** (`TrayFact`). There is one new kind, `identified`. New fields, null where they do not apply:

| Field | Meaning |
|---|---|
| `code` | on every fact except `arrived` and `leaving`: the code of its why (table below) |
| `opened` | for `unsure`: the `TrayPoint` where its question opened, or null |
| `from_world` | for `identified`: the world id it stood for before (`look_moved`), or null |
| `score`, `margin`, `bar` | for `identified`: integers in permille (`margin` may be null) |
| `t_id` | for `leaving`: the tray's `T_id` when its account closes (after the leaving's look work), or null when the tray took no look |
| `open` | for `leaving`: the tray's `TrayOpen` list (4.6.8) |

`certain` stays null for `identified`. Such a fact is final, like every fact. It states the link a look decided, and it
is never a certain removal or addition.

**Codes.** v1's why texts are unchanged.

| Kind | Why | Code |
|---|---|---|
| unsure | its box overlaps another stone | `overlap` |
| unsure | not seen at two calm moments | `unseen` |
| unsure | it was pushed | `pushed` |
| unsure | a stone next to it was pushed | `neighbour_pushed` |
| unsure | a stone appeared next to it while a hand held it | `appeared` |
| unsure | its world stone changed size | `size_changed` |
| unsure | found again, not for sure | `found_again` |
| unsure | matched when the tray left | `matched_at_leaving` |
| unsure | its look changed | `look_changed` |
| removed, certain | carried away / missing | `carried_away` / `missing` |
| removed, unclear | not found when the tray left | `not_found` |
| added, certain | set down | `set_down` |
| added, unclear | not recognised when the tray left | `not_recognised` |
| identified | found again by its look | `look_found` |
| identified | recognised by its look | `look_moved` |
| identified | confirmed / recognised / found again by its speckle (4.6.13) | `speckle_same` / `speckle_moved` / `speckle_found` |

**describe()** gives v1's sentences, plus these:

| Kind | Sentence |
|---|---|
| identified, `look_found` | `{clock} tray {n}: stone {id} found again by its look on world stone {world_id} ({milli(score)})` |
| identified, `look_moved` | `{clock} tray {n}: stone {id} recognised by its look on world stone {world_id} ({milli(score)})` |
| identified, `speckle_*` | 4.6.13's sentences: `... by its speckle on world stone {world_id} ({milli(score)})` |
| unsure with `opened` | `{clock} tray {n}: stone {id} is not sure any more ({why}; open since {clock of opened.t})` |

Apart from these, the `trays.txt` lines are v1's. The summary (4.4) is unchanged. Its `not sure` count still counts
`unsure` facts, which on a tray with looks can differ from v1's. A settled question gives no fact. A stone whose look
changed (`look_changed`) can give one that v1 never gives. And once a tray is relinked, later facts can follow other
links than v1's: a stone found again by its look can miss v1's `matched_at_leaving`, or get a doubt v1 never gives it.
Its `added` and `removed` counts count certain facts, which are the first of v1's (4.6.7): with looks they can be lower
than v1's, and the unclear counts higher.

**API.**
- **`TrayStone`:**
  - `sure` is now the live state: false while the stone is in question, and once it is not sure;
  - `question`: null, or `TrayQuestion {cause, why, since, opened: TrayPoint}`;
  - `looks`: the frame `g`s of its chain (none, one or two);
  - `by_look` and `look_lost` (booleans), `by_speckle` (boolean) and `evidence` (4.6.13);
  - `open`: its `TrayOpen` once the tray has left, or null.

  A live client that relies on a link reads `sure`. A client that only follows facts sees each stone at most once in
  `unsure`, and sure again after it only in an `identified` fact of the leaving's speckle answer (4.6.13).
- **`TrayOpen`**, **`TrayCandidate`** and **`TrayQuestion`**, as in 4.6.8 and above, each with `describe()` where
  4.6.8 gives one.
- **`Tray`:**
  - `open`: the `leaving` fact's list, null until the tray has left;
  - `t_id`: now, or null while the tray has taken no look;
  - `check()`: 4.6.10.
- **Golden files:**
  - `<name>.trays.txt` keeps its form. Recordings with looks add `identified` lines; `unsure ... open since` lines come
    from questions, with looks or, without them, from presence questions;
  - new: `<name>.open.txt`. For every `leaving` fact, in fact order: its describe() line, followed by
    ` (bar {milli(t_id)})` when its `t_id` is not null; then one line per open entry, indented two spaces. It is
    written without looks too: then it shows v1's remainders with their codes, and every look code is `none`.

#### 4.6.10 The self-check

`Tray.check()` returns the codes it finds broken in a tray's facts and final tray stones. An empty list means the
account is consistent. A tray that has not arrived (yet, or ever) has no facts and no stones, and passes. A tray that
arrived and has not left breaks C1. The list holds each broken code once, in ascending order.

- **C1** The first fact is `arrived`, the last is `leaving`, and nothing follows `leaving`.
- **C2** Tray stone ids are unique on the tray (its number in each id keeps them apart from other trays'). Every
  fact's `stone` is a stone of this tray.
- **C3** The life of each stone:
  - an `added` fact can only be a stone's first fact;
  - a stone has at most one `unsure` fact, and after it comes nothing but a `removed` or an `identified` of the
    leaving's speckle (a `speckle_*` code, 4.6.13);
  - a stone has at most one `removed`, and nothing about it follows that;
  - an `identified` never follows `removed`, one of a look (`look_*`) never follows `unsure`, and a stone has at most
    one of the leaving's speckle.
- **C4** The final state matches the facts:
  - a stone is removed exactly when it has a `removed` fact, with the same `certain`;
  - a stone on the tray is sure exactly when it has no `unsure` fact after its `identified` of the leaving's speckle
    (if any), and was not added unclear;
  - no stone is in question.
- **C5** The counts:
  - `arrived.stones` is the number of arrival stones;
  - `leaving.stones` and `sure` count the stones on the tray at the end and the sure ones among them; `added`,
    `removed` and `unclear` count the tray's facts as 4.6.1 defines them;
  - `open` holds one entry for each open stone (4.6.8), in tray order.
- **C6** The stones on the tray have distinct world ids that are not null.
- **C7** The open entries:
  - each entry has codes from 4.6.8's lists, and a candidate list that is not empty and repeats no entry;
  - an `unsure` entry starts with its own world stone;
  - every tray stone entry holds `gone`;
  - a `removed` entry ends with `unseen`, and an `added` entry ends with `new`.
- **C8** No candidate is a sure tray stone, a stone removed for certain, or a world stone linked to a sure stone.
- **C9** Every `identified` fact has `certain` null; one of a look has `score >= bar >= 750` and a `margin` that is
  null or at least 150, one of the leaving's speckle `score >= bar` and `bar` = 300 (`SPECKLE_CLEAN`).

#### 4.6.11 Constants (with looks; 4.6.1's are unchanged)

Permille values are compared with the integer `p` of 4.6.2. The measurements behind them come from the engine's look
export (sent by the unit since build claude-20261120-looks1, 4.6.2), run over the four videos on 19 and 20 November,
before the published recordings carried looks.

| Name | Value | What it does | Why this value |
|---|---|---|---|
| `T_ID_START` | 900 | `T_id` while the tray's gauge holds fewer than `GAUGE_MIN` pairs | No pair of two different stones reached it: the highest was 0.835 one way and 0.861 both ways (jul30). |
| `T_ID_MIN` | 750 | the lowest `T_id` | Above every pair of two different stones on dry1/dry2 (0.645) and aug28 (0.680 both ways); the same untouched dry stone scored at least 0.75 in 321 of 321 cases. |
| `GAP` | 100 | `T_id = max(T_ID_MIN, alike + GAP)` | On jul30 (pavers that look alike) a tray's `alike` is 0.799-0.861, so `T_id` is about 0.90-0.96 there, above its same-paver scores (0.585-0.864). |
| `GAUGE_MIN` | 20 | gauge pairs a tray needs before `T_id` can drop | jul30's first pair of 0.75 or more came at pair 5, 7 and 13 of its three trays. |
| `GAUGE_K` | 2 | gauge partners a taken look is scored with, both ways | 1-380 gauge pairs a tray; 2 of 66 dry1 trays and 3 of 53 dry2 trays stay under 20. |
| `T_FIRM` | 800 | the bar for a link change, or with a stone without a chain near | Wrong identifications when the true stone had no look to compare: 0.62-0.78. |
| `M_ID` | 150 | the margin over every scored rival | The smallest margin of the same stone over the best other one was 0.17 (aug28), 0.21 (dry1), 0.28 (dry2). |
| `N_ID` | 100 | paired cells a decision or doubt needs | No same-stone pair paired fewer than 119 cells; different stones paired as few as 104. |
| `T_DIFF` | 400 | below this, an untouched stone's own look "changed" | The same untouched stone never scored below it on dry (0 of 321), and once on aug28 (1 of 30, 0.259). |
| `D_MATCH` | 1.0 | how far a pair reaches (4.6.1's `LEAVE_D`) | True pairs on dry: 95 % within 0.326, all within 0.539. |
| `D_NEIGH` | 0.40 | neighbours, and stones without a chain near (4.6.1's `HAND_R`) | |
| `K_PAIR` | 4 | pairs per row | The true world stone was the nearest one in 126 of 133 dry pairs, and never had more than 3 nearer. |
| `K_NEIGH` | 4 | neighbours per column | |
| `N_TAKE` | 16 | looks taken per look work | The engine sends at most 16 looks a packet (at most 5 measured). |
| usable look | 24 cells, 3 x 3 | which looks the tray rules read (4.6.2 caps a look at 4096 cells) | Engine looks hold 216-880 cells. |

**Cost bounds.** A taken look costs at most `2 * GAUGE_K + 2` = 6 scores. A pair costs at most 2 (its chain), and so
does a neighbour. A look work computes only pairs and neighbour scores that involve fresh taken looks and chains it has
not scored before.
- **Per frame**, the work is at most `6 * N_TAKE` scores for taking, plus `2 * K_PAIR` per row and `2 * K_NEIGH` per
  column for the scores that are new.
- **Per tray**, each pair of looks is scored at most once.

One score takes 6-17 ms in plain Python (the maintainers' reference implementation) and 1-1.5 ms with numpy; the
busiest frames measured needed 29 and 133 new scores.

#### 4.6.12 The unit's speckle answers (`world.speckle`)

Since build claude-20261123-speckle3 the unit compares each tray's stones between two moments by their speckle, on its
GPU, and sends the answer once, as `world.speckle` (`WorldSpeckle`), in the world of the first frame after it is ready
(in test runs on the unit 0.4 to 0.8 s after the frame that asked for it): the reference is the tray's arrival, the
later moment a calm moment of the tray (at most one a minute) or the last calm frame before the visit ended. Each
stone not held at one moment was checked at the other (`refs`: the reference's stones, checked at the later moment;
`stones`: the later moment's, checked at the reference) where that moment's stones are and at its own place (builds
claude-20261123-speckle3 and -speckle4 searched the whole tray and answered about 7 s later), with its `score` and
`second` and the world stone `at` the other moment its best place lands on; `pairs` are the stones the unit pairs (a
clean find from one lands on the other, and the other's find, when clean, lands on the first; a stone in a
contradiction, or paired twice, is in no pair). A recording whose header notes say so carries answers made offline by
the same tray reading and the maintainers' reference matcher (`device` then says so).

The trays read every answer; the tray rules use one of them, the leaving's (4.6.13): the other answers change no fact,
count, report or open account. A world fed to the trays (not a revision) whose `speckle` fits `WorldSpeckle` by value (`v` 1; `tray`, `g`s and
ids whole numbers; `t`s, `gpu_ms` and `wall_ms` numbers; `device` a string; each find's `at` a whole number or null,
its `score` and `second` both numbers or both null; `pairs` two whole numbers each) gives at most one `TraySpeckle`:

1. **Its tray.** The open tray, when it has arrived and its arrival `g` is at most `SPECKLE_NEAR` (2) above the
   answer's `ref.g`; else the tray that left last, when `ref.g` lies from `SPECKLE_NEAR` below its arrival `g` to its
   leaving point's `g`; else none (the answer gives nothing).
2. **The links at the two moments.** At the reference: the tray's links as it arrived (world id -> tray stone, right
   after the arrival made its stones) when `ref.g` is within `SPECKLE_NEAR` of the arrival's `g`, else the tray links
   before frame `ref.g` (2.4: kept for its revisions, and for a frame that came without a world too); at the later
   moment: the tray links before frame `at.g`. Only links to this tray's stones count; a frame whose links are not kept
   (not read yet, in a gap, or older than the frames kept) gives none. The links of a frame in the first 2 s of a stop
   are still those of the tray before (a tray closes only once the next stop has lasted 2 s, 4.6.1), so they give none
   for the new tray.
3. **Its stones.** First each find of `refs` whose world id is linked at the reference, as side `arrival`; then each
   find of `stones` whose world id is linked at the later moment and whose tray stone has no find yet, as side
   `later`. A `StoneSpeckle`: `stone` (the tray stone id), `side`, `score` and `second` (null: not checked), `clean`
   (`p(score) >= 300` and `p(score) >= 2 * p(second)`, with 4.6.2's `p`), `found_world` (the find's `at`), `found` (the
   tray stone linked to `found_world` at the other moment, or null), `pair` (the tray stone linked at the other moment
   to the stone's partner in `pairs`, or null). `TraySpeckle.stones` holds them in tray stone order.
4. **The tray stones.** While the tray is on, each of its stones in the answer takes its `StoneSpeckle` as
   `TrayStone.speckle` (the newest answer wins), so `trays()` and the tray of the state show it, and the `Tray` given
   when the tray leaves holds the answers read before. An answer for a tray that has left changes no `Tray`.

`TraySpeckle`: `tray` (the SDK's tray number), `session`, `video`, `g`, `t`, `wall` (the frame it came in),
`unit_tray` (the answer's own `tray`, the unit's count), `ref` and `at` (`g`, `t`), `device`, `gpu_ms`, `wall_ms`,
`stones`, and `describe()`: `tray 2: speckle of 0:22.5 and 2:24.2: 42 stones, 33 clean, 26 paired, 24 the same`
(stones, those clean, those with a pair, those paired with themselves). `update.speckle` holds the answers a frame
gave; `interpreter.speckle()` the answers so far (the newest 1024).

The golden `speckle.txt` (section 5): for every answer, `{g} {clock} ` and its `describe()`; then for each of its
stones two spaces, the stone id, its side, `score second` to 3 places (`-` when not checked), ` clean` when clean,
` found {tray stone}` (or ` found world {id}` when no tray stone stood there), ` pair {tray stone}` when it has one.

#### 4.6.13 The leaving's speckle answer, and the confidence of a change

Every tray report uses the unit's speckle answer for its tray's leaving, when there is one: the stones the unit pairs
are sure, the ones the tray rules had lost or swapped are linked again, and every change of the report carries the
probability that it happened (`confidence`). Nothing needs to be called for it: a source whose worlds carry
`world.speckle` (4.6.12) gives it; a source without answers gives the account of the rules without a leaving answer,
with the same numbers for its changes.

**The leaving's answer.** The newest answer read for the tray while it was on (4.6.12, rule 1: the open tray) whose
later moment `at.g` is within `SPECKLE_NEAR` frames of the tray's leaving point (4.6.1). The unit asks for it at the
last calm frame of the visit; the leaving point is that frame unless hands worked after it, and then no answer is the
leaving's. The answers of the published recordings arrive 0.8 to 3.8 s after their later moment and the trays close
7.6 s or more after their leaving point, so every leaving answer there is read before its tray closes.

**Its pairs.** Each pair `[c, r]` of the answer (`c` a world id at the later moment, `r` one at the reference), in the
answer's order, links a tray stone when:
- `r` is linked at the arrival (4.6.12, rule 2) to a tray stone that was not added, and that stone is on the tray or
  lost (not removed);
- `c` is a world stone of the leaving point's world (of the tray's last frame when it is not there), not held;
- neither `c` nor the stone is in an earlier such pair;
- the stone is not trusted (4.6.4: on the tray and sure, never in question or not sure on this tray, not linked by a
  look) while on another world stone than `c`, and `c` is not linked to another stone that is trusted. A stone nothing
  disturbed has not moved: on look-alike pavers a pair can join two neighbours (aug28's trays 82, 97 and 158), and
  checked against the look tracker, trusted stones were never on another stone (1,016 of 1,016).

Its clean find is `r`'s find in `refs` when clean (4.6.12, rule 3), else `c`'s find in `stones`. A pair whose clean
find has no score (no find of `c`, or one without a score) links nothing, unless its stone is sure and already on `c`
(it is confirmed, with no fact): a unit pairs only stones it found, so this is a malformed answer, and the trays read
it without failing.

**In the leaving's settle** (4.6.6, `final`):
1. The stones the answer pairs are not tested at the leaving (4.6.1's tests of sure stones: unseen, overlap, pushed,
   a stone next to it pushed, appeared): the answer settles them.
2. After the leaving's look work (4.6.5) and before what is still in question becomes not sure, the pairs link:
   - a stone already on `c` is confirmed: its question ends (no fact); a stone that was not sure is sure again, with
     the fact `identified`, code `speckle_same`;
   - any other stone is linked to `c`, sure: the stone that stood on `c` is lost (4.6.1); the world stone the moved
     stone stood on is unidentified again (freed, as a look's link frees it in 4.6.5) when it is on the board, not
     held and in no pair; the fact `identified`, code `speckle_moved` (from a world stone; `from_world` names it) or
     `speckle_found` (a lost stone), and the stone is `touched` (4.7) and `by_speckle`.
   Each of these facts holds the clean find's `score` and `margin` (`p(score) - p(second)`, or null without a
   second) in permille, `bar` = `SPECKLE_CLEAN`, and `certain` null.
3. Then the leaving goes on as before: what is still in question is not sure, lost stones are paired with unidentified
   world stones nearest first, the rest are removed unclear, unidentified world stones are added unclear (4.6.1).

**Facts and the self-check.** A stone that was not sure can be sure again, once, through the leaving's speckle:
`TrayStone.sure` is then true, and a client that follows facts sees an `identified` fact after its `unsure` (the
summary's `not sure` still counts the `unsure` fact; a report's `unsure` counts the stones not sure as the tray left). 4.6.10's
C3, C4 and C9 allow exactly that (below). `TrayStone.by_speckle` is true for every stone in one of the pairs that
link (confirmed on `c`, sure before or not, or linked to it).

| Code | Why | describe() |
|---|---|---|
| `speckle_same` | confirmed by its speckle | `{clock} tray {n}: stone {id} confirmed by its speckle on world stone {world_id} ({milli(score)})` |
| `speckle_moved` | recognised by its speckle | `{clock} tray {n}: stone {id} recognised by its speckle on world stone {world_id} ({milli(score)})` |
| `speckle_found` | found again by its speckle | `{clock} tray {n}: stone {id} found again by its speckle on world stone {world_id} ({milli(score)})` |

**The evidence of a stone**, `TrayStone.evidence`, set as the tray leaves (null before): what the leaving's answer
found of the stone at the other moment. For a stone the tray arrived with, its arrival world id's find in `refs` (is
it on the tray as it left?); for a stone added on the tray and on it as the tray left, its world id's find in
`stones` (was it on the tray at the arrival?):
- `found`: the stone is in one of the unit's pairs (4.6.12), or, in none, its find is clean. Removed stones found on
  the tray as it left lay where the world had no stone in 23 of the four recordings' 27 such removals; added stones
  found on it at the arrival, where the world had no stone yet, in 59 of 60;
- `not_found`: checked, and no find of `SPECKLE_CLEAN` or more;
- `undecided`: no leaving answer, the stone not in it or not checked, or a find of `SPECKLE_CLEAN` or more that is
  not twice its second (look-alikes). An added stone removed again is `undecided`.

**The confidence** of a change, `TrayChange.confidence`, is the number of its class in this table (`CONFIDENCE`): the
share of the four recordings' changes of that class that the maintainers' offline checks found right: their look
tracker (each stone followed by its look, forwards and backwards; 148 trays: the 60 of 19 November, mapped onto the
hr4x1 world ids by their outlines, and 88 more) or their camera check against the original video (all 52 certain
removals and 2 more trays: 150 in all); neither check's data is published. The number is
`(right + 1) / (checked + 2)`, to two places. A removal is supported by `not_found` and contradicted by `found`; an
addition too. A move (always certain) takes `MOVED_CONFIDENCE` (0.87: 19 of 21 paired moves right).

| Change | Certain | `not_found` | `undecided` | `found` |
|---|---|---|---|---|
| removed | yes | 0.98 (48 of 48) | 0.50 (1 of 2) | 0.25 (0 of 2) |
| removed | no | 0.71 (11 of 15) | 0.58 (35 of 60) | 0.09 (1 of 21) |
| added | no | 0.96 (23 of 23) | 0.52 (32 of 62) | 0.02 (0 of 50) |
| added | yes | 0.96 | 0.52 | 0.02 |

No certain addition was made in the four recordings: a certain one takes the unclear additions' numbers. The numbers are
constants, the same in every language; a client keeps the changes at or above a threshold of its own (0.90 keeps, on
dry1's tray 2, the six certain removals and nine of the thirteen additions, all fifteen right by the camera; 87 and
129, which left, and 278, which was set down, are below it with three stones that stayed under new ids).

**What it changes** (the four hr4x1 recordings, 532 trays, without the leaving answers and with them): stones not sure
as their tray left 3,978 to 2,058 (of the stones a tray arrived with that were still on it as it left, 91.1 % sure:
95.6 % on the 454 trays with a leaving answer, dry1 99.7 %, dry2 99.9 %, aug28 94.6 % and jul30 94.2 %, and 66.5 % on
the 78 without one); unclear removals 140 to 124; unclear additions 158 to 154; trays complete 261 to 284; moves 0 to
22 (stones the answer confirmed or linked again, seen at the leaving point, moved more than `MOVED` short sides). The
answers confirmed 14,222 stones; of the 4,389 the look tracker labelled, it found 4,382 the same stone and could not
confirm the other 7 (3 it found still on the tray but on no world stone, 4 it took to have left; our camera check has
one of those 4, dry1's 88, still in place). Most stones still not sure are on trays whose hands worked after their
last calm frame (851 of 1,439 on jul30), where no answer is the leaving's, or are look-alike pavers the answer leaves
undecided. On dry1's tray 2 (without its leaving answer: 15 removed, 17 added, 25 not sure), the answer links six
stones the rules had lost (107, 118, 119 and 120, found again) or put on other world stones (106 and 116, recognised),
and confirms the others it pairs: 11 removed, 13 added, 8 moved, 1 not sure.

### 4.7 Tray reports (simple mode)

Simple mode, the quickest way to use the SDK: for each tray, which stones were removed, which were added and which
moved, when and where, and whether that is the tray's whole account. Everything else is advanced mode: hands, world ids and the
reasons (2.4, 4.2, 4.6), for research and for correcting a report when it is not complete.

A report is made from its tray alone, its facts and its final tray stones, once the tray has left.
- `tray.report()` gives it, null for a tray that has not left or never arrived;
- `replay.tray_reports()` gives one for every tray of a recording that arrived, in tray order (consumes the file);
- `interpreter.tray_reports()` yields one as each tray leaves: when the next tray arrives, the session changes, or the
  frames end.

**`TrayReport`**: `session`, `video`, `tray` (the tray's `n`), `arrived` and `left` (the `arrived` and `leaving`
facts' points, `TrayPoint`), `stones` (the tray stones it arrived with), `removed`, `added` and `moved` (lists of
`TrayChange`), `unclear` (the leaving fact's unclear facts), `unsure` (the stones on the tray as it left that are not
sure, other than those added unclear), `complete`, `describe()`.

**`TrayChange`**: `kind` (`removed`, `added` or `moved`), `stone` (the tray stone's id), `at` (a `TrayPoint`, or
null), `certain`, `code`, `place`, `size` (the tray stone's), `distance` and `confidence` (the probability that the
change happened, 4.6.13). `place` is the stone's final place on the
tray, in the world's scene units (x right and y up as the camera sees the tray), for matching a report with another
system that looks at the trays: for a removal, where the stone was last seen before it was taken (the tray stone's
place as last known); for an addition or a move, its place as the tray left: its `left_place` when it was seen at the
leaving point, else where it was last seen, or, for a stone counted because the leaving point's world kept it (4.6.1,
positive evidence at departure), its place in that world.
- `removed`: one change for each `removed` fact, in fact order: `at`, `certain` and `code` are the fact's
  (`carried_away`, `missing` or `not_found`), `distance` null.
- `added`: one change for each `added` fact, in fact order, in the same way (`set_down` or `not_recognised`).
- `moved`: one change for each tray stone the tray arrived with (`added` false) that is on the tray as it left
  (`status` on), sure and not in question, seen at the leaving point (`left_place` not null), touched (`touched` not
  null), and that moved more than `MOVED` times its short side (`size[1]`) once the tray's own shift is taken out, in
  tray order: `at` and `code` null, `certain` true, `place` its `left_place`. A stone that is not sure is left out: the
  stone at its place may be another one, and the report counts it as not sure instead. A stone not seen at the
  leaving point is left out: its place is older than the tray's shift. A stone nothing touched is left out: a stone
  on a tray moves only when something moves it, and an outline the world refines, or a box it slides, is not a move.
  The shift `(mx, my)` is the median of `left_place[0] - first_place[0]`, and of `left_place[1] - first_place[1]`,
  over the half of the sure stones seen at the leaving point (touched or not) that moved least: sorted by
  `dist(first_place, left_place)`, ties in tray order, the first `ceil(n / 2)` of the `n` (of an even count the median
  is the mean of the two middle values). `distance = round3(dist((first_place[0] + mx, first_place[1] + my),
  left_place))`, and the stone moved when the unrounded distance is above `MOVED * size[1]`. Without such stones
  nothing moved.
- `complete` is true when `unclear` and `unsure` are both 0 (the leaving fact's `unclear == 0` and `sure == stones`):
  every change is then certain and no stone is open. When it is false, the
  tray's facts and its open account (`tray.open`, 4.6.8) say what is open and why.

`MOVED` = 0.75. Without looks, a stone that a hand pushed, or that the world lost and found again, is not sure, so the
recordings of 17 and 18 November, made without looks (508 trays), report no stone moved: the moves a looser rule found
there were outlines the world refined while nobody touched the stone (0.53 of a short side at most), stones last seen
before the tray's own shift at the leaving point (up to 0.10 scene units on dry1's tray 59), and stones the world had
swapped (dry1's tray 2, checked against the camera frames). With looks, a pushed stone that a later look of its own
settles is sure again, and its move is reported; the pushed and found-again stones of the synthetic trays move 1.4 to
2.3 short sides. The four hr4x1 recordings have 532 departure reports, and none reports a moved stone. When a visit
went on with half of its first frame's world ids seen, three did, all on the bare boards that pass under jul30's
camera from about 3110 to 3429 s (0.146, 0.186 and 0.272 scene units, leaving at 3177.4, 3296.8 and 3419.4 s):
stones the world showed on one bare board, linked to those it showed on the next.

`TrayStone.first_place` is its place when the tray stone was made: at the arrival for the stones the tray arrived
with, as it was set down or as the tray left for an added one. `TrayStone.left_place` is its place at the tray's
leaving point when the stone was on the tray and seen (its world stone detected) in that frame. The SDK reads the detection from the selected grid frame even when another frame has the
same media time. It uses the calm frame, or the tray's last frame when hands worked after its last calm
frame. The field is null if the stone was undetected there or the tray is still open. A stone newly linked or added in the closing settle takes its detected, non-held world position at that same
leaving point if available. `TrayStone.touched` is the frame (`g`) where
something last touched it on this tray: a hand event, a hold or a push on its world stone, a push on a stone of its
size next to it (the same disturbances as 4.6.4), or a link to another world stone (a rename, a match, a look); null
when nothing did.

**describe()**: a first line, then one line for each change indented two spaces, removed first, then added, then
moved; lines joined with `\n`, none after the last.
- first line: `tray {n}{wall}, {clock(arrived.t)} to {clock(left.t)}: {R} removed, {A} added, {M} moved`, then,
  when it is not complete, `, not complete: {unclear} unclear, {unsure} not sure` without the parts that are 0;
  `{wall}` is ` ({iso})` when `arrived.wall` is not null, `iso` the wall time in UTC to the tenth of a second as
  `stamp()` rounds it, `2026-11-17T23:31:09.5Z`;
- removed: `{clock(at.t)} removed {stone} from {where}`, then ` ({fmt(confidence, 2)})` when it is certain, else
  ` (unclear, {fmt(confidence, 2)})`;
- added: `{clock(at.t)} added {stone} at {where}`, then the same;
- moved: `moved {stone} {fmt(distance, 2)} to {where} ({fmt(confidence, 2)})`;
- `{where}` is the change's place, `({coord(place[0])}, {coord(place[1])})`, where `coord(v)` is `fmt(v, 2)`, or
  `0.00` when that gives `-0.00`: `(0.68, -1.04)`.

The golden `<name>.reports.txt` holds every report of `replay.tray_reports()`, each describe() followed by `\n`.

## 5. Fixtures and golden files

`fixtures/` (the same in every SDK):

- `recordings/*.ndjson.gz`: short excerpts of recordings in the recording format (section 6), redacted (of the 20.20
  unit; aug28's two of a replay of its model and build on a Mac, as their headers' `recorded_from` says), and
  synthetic recordings labelled so in their headers: revisions, trays, trays with made-up looks
  (`trays-looks-synthetic`, 4.6.3-4.6.10) next to the same frames without a look (`trays-looks-synthetic-nolooks`),
  and presence questions (`trays-presence-synthetic`, `trays-presence-looks-synthetic`,
  `trays-presence-attacks-synthetic`, `trays-presence-attacks-looks-synthetic`, 4.6.1: each tray's end state, which
  stones end sure and which not sure, is in its golden `trays.txt` and `open.txt`).
- `looks/looks-synthetic.json`: made-up looks and their look scores by the maintainers' reference implementation
  (4.6.2).
- `damaged/`: recordings with lines readers ignore (section 6, 2.3 rule 9), each next to a JSON file of what a replay
  of it gives (the maintainers' generator writes both; every SDK's tests replay and stream them).
- `frames/*.json`: single full frames (all five layers, redacted, for codec tests).
- `api/*.json`: real replies of every GET operation, and real error replies, redacted like the recordings (no face
  joints, person masks or depth; the observed 3-D surface lies flat on the board).
- `golden/<name>.events.txt`, `<name>.activities.txt`, `<name>.trays.txt`, `<name>.open.txt`,
  `<name>.tray-stones.txt`, `<name>.reports.txt`, `<name>.speckle.txt`, `<name>.summary.json`, `<name>.summary.txt`:
  the output of the
  maintainers' reference interpreter for each recording (`trays.txt`: `describe()` of every tray
  fact, one per line; `open.txt`: every leaving with its open account, 4.6.9; `tray-stones.txt`: `{g} {type}
  {stone_id} {tray_stone}` of every event with a tray stone, in event order, a revision's events included, 2.4;
  `reports.txt`: every tray report, 4.7; `speckle.txt`: every speckle answer read, 4.6.12).
  Every SDK's tests run `Replay` over each recording and compare all nine exactly (text files byte for byte, the JSON
  after parsing), and check that every tray's `check()` (4.6.10) is empty.
- `MANIFEST.json`: names, sha256, provenance (build, session, g range).

The four complete recordings have golden summaries too. Use the matching recording release for the opt-in tests
(`PDIGGER_FACTORY_RECORDINGS=<dir>`). Scheduled CI uses the downloads in section 13.

## 6. Recording format (`pfr1`)

A recording is NDJSON (optionally gzip). Line 1 is the header:
`{"recording": "pfr1", "video": "dry1", "source": {catalog entry}, "build": "...", "model": "...", "layers": [...],
"redacted": [...], "recorded_from": "...", "recorded_at": "ISO time", "frames": N, "g_first": .., "g_last": ..,
"sessions": [...], "notes": "..."}`. Every other line is either a Frame exactly as the API sent it (it has `cursor` and
`g`; backfilled layers merged in, `missing` then lists only layers still missing), or a side event
`{"sse": "clock" | "worker" | "gap" | "reset", "data": {...}, "recv": epoch}` in the order received.

Readers read bytes that are not UTF-8 as U+FFFD (as many for a bad sequence as their decoder gives: one in Python, Rust
and TypeScript, one a byte in Go), strip whitespace from both ends of a line as their language does (TypeScript also a
byte order mark there, but not U+0085), and read each line by its keys. The first line that is not blank is the header
when it is an object with `recording` that decodes: `recording` a string and, when there, `name`, `video`, `build`,
`api`, `model`, `backend`, `recorded_from`, `recorded_at` and `notes` strings, `frames`, `g_first` and `g_last` whole
numbers, `layers`, `redacted` and `sessions` arrays and `complete` an object. Nothing else in the line keeps it from
being the header: a reader leaves out a member it cannot hold. Every reader leaves out a `source` that is no catalog
entry (an object with `id` and `proxy` strings, `fps` a number, `grid_step` a whole number and `proxy_wh` and
`native_wh` arrays, and its other fields, when there, of their types). Go and Rust, whose header models are typed, also
leave out a `layers` or `redacted` that is not an array of strings and a `sessions` that is not an array of whole
numbers, which Python and TypeScript keep as they are; Go also a `complete`, or a recorder's count (`backfilled_layers`,
`frames_still_missing`, `holes_filled`, `frames_lost`), that does not fit its model, which the others keep as they are.
Otherwise the recording has no header: a first line with `recording` that does not decode is ignored (never a frame,
whatever its other keys), and a first line without `recording` is read like the others. A line with `sse` is a side
line, which decodes when `sse` is a string, `recv` (when there) a number and `data` of its event's shape (2.3 rule 9); a
line with `g` and `cursor` is a frame, which decodes as a frame event does. Readers ignore the lines they do not
understand: blank lines, lines that are not JSON (a line of bytes that are not UTF-8 is read as U+FFFD first, so it is
ignored only when it is then not JSON or does not decode), JSON that is not an object, a frame or side line that does
not decode, a side line of an event they do not know, a header that does not decode, and any other line (one with
`recording` after the first line and neither `sse` nor both `g` and `cursor`, say). TypeScript ends a replay with
`decode` on a line over 64 MiB, as it ends a stream (2.3 rule 1). A file that cannot be read to its end (a cut gzip
file, a broken download) is an error instead, and gives no final update (2.5).

Redacted (public recordings): face keypoints (joints 0-4 and 69) are null in `raw.person.joints`, `overlay.joints` and
`scene.skeleton.world`; appearance masks are removed (`raw.maps.human`, `raw.person.mask`, `raw.person.alpha`,
`overlay.regions.human`, `overlay.mask.label`, `overlay.mask.alpha`); depth textures are removed (`raw.depth.q`,
`scene.surface.q`). The header's `redacted` lists them. Models make these fields optional; decoders return null/None for
an absent map.

## 7. Codec helpers (low level)

- `decode_u8_map(b64, rows, cols)` → rows×cols u8 (row-major) — overlay maps; `decode_zlib_map(b64, rows, cols)` — sip1
  maps (base64 of zlib); `decode_bitset(b64, n)` → n booleans, LSB-first within each byte.
- `depth_log_z(q, lo, hi, a, b)`: `logZ = a*(lo + q/255*(hi-lo)) + b`, `Z = exp(logZ)`.
- `decode_f32le(b64)`, `decode_u16le(b64)` → surface positions (xyz triplets) and triangle indices.
- `Joint` from `[u, v, vis, x, y, z]` or null; `StoneItem` from `[u, v, w, h, score, X, Y, Z, w_m, h_m, yaw]`.
- Coordinates: `uv_to_px(u, v, W, H)` (`px = u*W - 0.5`), `px_to_uv`; `scene_to_three([x, y, z])` → `[x, z, -y]`;
  `quat_to_yaw`.
- Topology helpers: bones, wrist and tip joint indices from `getTopology`.

## 8. Tests

- Unit tests run in Docker with no network: `docker build -t pdigger-factory-sdk-<lang>-test -f Dockerfile.test .`
  then `docker run --rm --network none pdigger-factory-sdk-<lang>-test` (or `make test`, which does both). The image
  pins the toolchain and dependencies.
- Coverage 100 %, enforced by the test command (it fails below 100): Go statements (`go test -coverprofile`, a check
  script over `go tool cover -func`), Python lines and branches (`pytest --cov --cov-branch --cov-fail-under=100`),
  Rust lines and functions (`cargo llvm-cov --fail-under-lines 100 --fail-under-functions 100`), TypeScript lines,
  branches, functions, statements (vitest + v8 coverage, thresholds 100). Exclusions only where code cannot run in a
  container (opening a native window, a GPU), each marked in the source with the reason and listed in `TESTING.md`.
- Tests use the injectable transport / fake server (`testing` module) with fixture data; time and randomness are
  injected (no real sleeps over 50 ms in unit tests).
- Golden tests: Replay over every `fixtures/recordings/*` must equal `fixtures/golden/*` exactly, with every tray's
  `check()` empty. Look tests: every SDK's look score, `n` and permille equal `fixtures/looks/looks-synthetic.json` bit
  for bit, and its models drop exactly the looks listed in `model_none`, with their frames still read. Tray tests: every
  tray of `trays-looks-synthetic` that left checks clean; on each of its trays the certain facts are the first of those
  of `trays-looks-synthetic-nolooks` (4.6.7); each self-check code (C1-C9) is found on an account broken on purpose; and
  a stone in question while its tray is on has `sure` false and its `question` set (that live tray breaks C1 and C4).
- Integration tests (opt-in, not in the Docker unit run): `PDIGGER_FACTORY_URL` → read-only checks against a live
  server (observe=1 streams, dry_run=1 controls, never a real control); `PDIGGER_FACTORY_RECORDINGS` → Replay over the
  four complete recordings, compared with their golden summaries.

## 9. CI/CD (GitHub Actions, per repository)

- `ci.yml` on push and pull request: lint (Go vet + staticcheck/golangci-lint; ruff + mypy --strict; clippy -D warnings
  + rustfmt; eslint + tsc --noEmit + prettier check), the Docker unit tests (the same `Dockerfile.test`), docs build.
- `release.yml` on tags `v*`: tests again, then publish: Go — a GitHub release and a `proxy.golang.org` fetch; Python —
  build sdist + wheel, publish with PyPI trusted publishing (`pypa/gh-action-pypi-publish`, environment `pypi`); Rust — a
  dry run of the workspace, the viewer binaries on a draft GitHub release, then `cargo publish` (with
  `CARGO_REGISTRY_TOKEN`) of the crates not on crates.io yet, `pdigger-factory-sdk` and then `pdigger-factory-viz`, and
  the release made public; TypeScript —
  `npm publish --provenance --access public` with `NPM_TOKEN`.
- `integration.yml` (manual and weekly): the opt-in recording tests with the published recordings.
- Actions pinned to major versions; `dependabot.yml` for the ecosystem and for actions.

## 10. Docs and pictures (each repository)

- `README.md`: one-paragraph what it is (the two modes: simple mode, one report per tray, and advanced mode, the detail
  underneath); install; a quickstart of simple mode (the reports of a published recording, and from a unit as each tray
  leaves); a 10-line quickstart that follows the shared session, whatever it shows (a recording or a plant camera), and
  prints human-readable events; the same with a replay of a published recording; the levels underneath with a short
  example each; error handling; async notes; links to the Swagger demo (https://factory.pdigger.com/developers/api/) and
  the other languages; the parity table; licence.
- `docs/`: `concepts.md` (shared session, sources and the live cameras, frames and layers, cursors, revisions,
  coordinates, template gauge), `interpreter.md` (events, activities, text, summary), `streams.md`, `low-level.md`,
  `replay.md`, `testing.md`, `viz.md` (TS, Rust).
- Pictures in `docs/img/` (checked in): the architecture diagram (the same in every SDK), a picture of the quickstart's
  output, and for TS and Rust screenshots of the visualisation helpers on a recording. Pictures are made from real
  recordings, never mocked; the docs say which recording and frame.
- API reference generated from doc comments (godoc, pdoc, rustdoc, TypeDoc) in CI.

## 11. Visualisation helpers

**TypeScript (`pdigger-factory-sdk/viz`, three.js peer dependency):**
- `SceneView`: builds and updates a `THREE.Group` from a `Scene3D` (render-ready) or a world frame: board plane,
  stones (rect = box; dogbone = extruded dogbone outline; colours from topology; held/uncertain styles), skeleton
  (bones as line segments from topology, null joints skipped), wrist rings, the observed surface mesh (from `vertices`),
  the focus path; scene → three.js axes (`[x, y, z]` → `[x, z, -y]`); camera presets `source` (from the catalog
  camera K/R/t), `three`, `top`; `dispose()`.
- `OverlayCanvas`: draws an `Overlay2D` (`draw=primitives` or shapes) on a 2-D canvas context scaled to the canvas.
- `EventFeed`: renders `describe()` lines of events and activities into a DOM element, newest first, with hand colours.
- `attachToClient(view, client|replay)`: drives a view from an Interpreter or Replay; for a client, from an
  Interpreter of its own that streams the layers the views draw (world, cards, scene, overlay) unless told otherwise.
- `TrayReportView`: a tray's report (4.7) as one `THREE.Group`, two `SceneView`s side by side, the tray as it arrived
  and as it left (`show(tray, before, after)`, with the worlds at its two points). `reportMarks(tray)` colours each
  stone in `REPORT_COLORS` (removed red, added blue, moved violet, sure green, not sure amber; an unclear removal or
  addition translucent, a stone not on the tray grey), a dashed red outline marks each removed stone's final place on
  the after side, and `labels()` gives the removed, added and moved stones' labels (their ids after the tray's number:
  the world's id when first seen, with `-2` for a second stone first seen under it in the same tenth of a second) at
  their top centres, for HTML labels.
- Testable in Node without WebGL: geometry and scene graph tests, a fake 2-D context that records calls.

**Rust (`pdigger-factory-viz`, egui):** reuse the UI/UX components of https://github.com/storytold/texturecraft
(MIT OR Apache-2.0): its egui theme and panel/dock layout and the `craft-ui` widgets it uses (icon buttons, panels),
with attribution in `NOTICE`. If a component is only available as a git dependency, vendor the needed source with its
licence header so the crate stays publishable, or mark the crate `publish = false` (the core crate must stay
publishable). Provide: `OverlayView` (egui painter of Overlay2D), `SceneView` (orbit camera, painter projection of
stones/skeleton/board, no GPU needed), `EventFeed`, `HandCards`, `ReportView` (a tray's report (4.7) as a picture,
as the TypeScript `TrayReportView` draws it: the tray as it arrived and as it left, side by side, from above, each
stone in `REPORT_COLORS` by `report_marks(tray)`, the removed, added and moved stones labelled with their ids after the
tray's number, a dashed red outline where each removed stone was, a legend and the report's text), and `ViewerApp`
(eframe app: a fixed split layout in the Craft style with the video-space overlay, 3-D, events and hands; follows a
client, streaming the world, cards, scene and overlay layers, or plays a replay file, whose header's source gives
the video size when the frames carry no overlay layer; its Reports button lists the trays that left and shows a
tray's `ReportView` in place of the four views; binary `pdigger-factory-viewer`).
Widget logic is tested headless (egui `Context::run` and the shapes it produces); only the `run_native` window glue is
excluded from coverage.

## 12. The `testing` module

For users' own unit tests and for the SDK's tests. Same capabilities in every language:

- `FakeFactory(recording=path | frames, replies=dir | map)`: an in-process server or transport (Python: an `httpx`
  transport; Go: an `http.RoundTripper` and an `httptest`-style server; Rust: a transport trait object and an optional
  local server; TS: a `fetch` implementation) that answers the v2 API:
  - `GET` operations from recorded replies (`fixtures/api` layout: `INDEX.json` + files) where given, otherwise
    synthesised from the recording (catalog from the header's `source` entry, session state from its clock lines,
    `frames/{g}`, `world`, `world/events`, `world/stones/{id}` from its frames);
  - `frames/stream` (SSE and NDJSON) and `raw/stream` over the recording's frames, honouring `layers`, `after`,
    `Last-Event-ID`, `limit` and `max_s` (ends the stream after `limit` frames; time is not simulated), with the
    recording's clock/worker lines as side events;
  - `frames` (long-poll) from the recording;
  - controls: validated like the server (`dry_run` honoured), applied to the fake's state (a select or seek starts a
    new fake session; no clock runs), errors in the server's shape and codes;
  - fault injection: an error reply for the next N requests of a route, a dropped connection after K events, a `gap`
    or `reset` event, a delay hook (no real sleeping by default);
  - a live camera, `cam-live` (with `live`): listed after the recording, shaped as a plant camera (`kind: camera`,
    `hold` 3, no media), and shown by the session at the start, already live. It sends the recording's frames as one
    session: `g` counts every camera frame from 0 (the warm-up's included), `t` is the arrival since the session
    started, from 0.5 s. A select of it starts a session as the unit does: `connecting` for 0.5 s, `warming` while the
    first 3 s of frames warm the interpreter up (they are never released), then `live`, 0.25 s behind the camera
    (`lag`); each phase bumps `revision`. The phases follow the fake's clock, and a stream or long-poll that comes
    earlier waits for them. Each released frame has a picture (a small JPEG naming its frame); a seek in the camera is
    409 `not_seekable` (field `video`), a select with a time 400 `not_seekable` (field `time`), its media 404.
- Everything deterministic; no network, no real clock (the fake's clock moves only when slept on).

## 13. Published recordings

The four complete recordings (aug28, jul30, dry1, dry2; every frame the server interpreted, from the start of each
video to its end; dry1 recorded on the 20.20 unit, the other three in a replay on a Mac of the same model and build, as
each header's `recorded_from` says) are published at `https://factory.pdigger.com/developers/data/` as
`<video>.world.ndjson.gz` (world and cards layers) and `<video>.full.ndjson.gz` (all five layers, redacted), listed in
`recordings.json` with sizes, sha256 and their golden summaries. `Replay.open(url)` streams them.
They were recorded before the unit sent speckle answers (4.6.12); their worlds carry answers made afterwards, as each
header's `notes` say: the unit's own tray reading of build claude-20261123-speckle6 over the recording's worlds asked
for them, the maintainers' reference matcher answered by its region check on the original video (`device`
`reference matcher, CPU, offline`), and each answer is in the world of the first frame 0.6 media seconds after the
frame that asked (the unit answers a calm moment 0.4-0.8 s later): dry1 98 answers, dry2 82, aug28 224, jul30 359. The
fixture excerpts cut from them carry the answers of their frames.
