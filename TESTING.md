# Testing

## Unit tests (Docker, no network, 100 % coverage)

```sh
make test
```

`make test` builds two test images, from pinned Node 26 and Node 22 bases, and installs the lockfile dependencies with
`npm ci` in each. It then runs `npm run check` in each, one after the other, in a container with networking disabled
(`make test-26` or `make test-22` runs one; CI runs both). The checks run in this order.

1. `tsc --noEmit` over the sources, tests and examples (strict, `noUncheckedIndexedAccess`);
2. `eslint` (typescript-eslint, type-checked rules) and `prettier --check`;
3. `vitest run --coverage`: every unit, golden, example and docs test, with V8 coverage over `src/`; the thresholds are
   100 % of lines, branches, functions and statements, and the run fails below them;
4. the build (`tsc -p tsconfig.build.json`);
5. the declarations in consumer projects (`npm run typecheck:consumer`, `test/consumer/`): the built package imported by
   its name and type-checked with `skipLibCheck` off as a browser or Deno project (lib ES2022 and DOM, no Node types), a
   Node project (`@types/node`, no DOM) and an ESNext project with the three.js helpers;
6. the API reference (TypeDoc).

Outside Docker: `npm ci`, then `npm run check` (everything) or `npm test` (the tests with coverage).

**Coverage exclusions: none.** Nothing in `src/` needs a window, a GPU or a network, so every line and branch runs in
the container: the viz helpers build their three.js scene graphs without WebGL and draw on a recording 2-D context.

## What the tests cover

| File | |
|---|---|
| `test/golden.test.ts` | `Replay` over every `fixtures/recordings/*` (eighteen: nine excerpts and nine synthetic ones, `revisions-synthetic`, `trays-synthetic` for the tray rules the real excerpts never reach, `trays-looks-synthetic` with its copy without looks, and the four of the presence questions, `trays-presence-synthetic`, `trays-presence-looks-synthetic`, `trays-presence-attacks-synthetic` and `trays-presence-attacks-looks-synthetic`, and `trays-speckle-synthetic` for the unit's speckle answers): events, each event's tray stone (a revision's too), activities, tray facts, open accounts, the speckle answers and the summary text byte for byte equal to `fixtures/golden/*`, the summary JSON equal after parsing, the tray facts also from `replay.trays()`; the async replay of the file and the synchronous replay in memory |
| `test/unit/text.test.ts`, `core.test.ts` | the sentences, numbers and clock of the contract; the Interpreter's state machine (moves, bursts, order, revisions, sessions, summary) |
| `test/unit/trays.test.ts` | trays and tray stones as values (their JSON too), ids without a clock and the stamps, the events' tray stones and the state's open tray, the trays the core keeps, `trayFacts()` on a live interpreter (a loop stopped inside a frame leaves the rest), a summary without trays, every fact's sentence |
| `test/unit/trays-presence.test.ts` | the presence questions (SDK-DESIGN.md 4.6.1) on the four presence recordings: how each of their trays ends, as their generator made it; a stone held in question and settled at once, on probation or not at all; what ends a question (a hand at work, a stone held or taken by a hand, a push, a stone of its size near its place, a look of another open stone, a revision, a frame without a world, a jump in `g`, a `gap` or `reset` line of a recording or a live stream, `InterpreterCore.gap()`); side lines that do not decode; the leaving's own frame; a stone with a look chain never held in question; and, on edited copies of the recordings, the rules no tray of them decides alone: probation after a settle by an earlier sight, the first and last sight within 0.12 of the stone's place, a hand event with both hands free, frames the rules could not read inside a static stop not yet taken, a lift of a stone read far from its places, a look read before the stone was last seen, a look no longer fresh, a look like a stone that is sure and not in question, the leaving's own frame with a look against, a freed push next to the stone, and a stream item of a kind this version does not know (ignored) |
| `test/unit/interpreter.test.ts` | the Interpreter on a client: shared streams (an iteration joins at its first `next()`; back-pressure waits for the slowest consumer, an iterator never read holds nobody up), `waitFor`, timeouts and aborts (also inside an update), backfill, the long-poll transport, reconnects, the final update of a stream that ended (events, activities and tray facts equal to the golden files on every fixture recording), the state read on every connect (wall times on a 20.20-like fake), the observe defaults, the client's set of open Interpreters, `using`; `SessionClock` with the worker's hold, `lastState`, the controls; a camera: a seek and a time refused locally (the state read first when none is known), `untilLive()` through the phases on the fake's clock and its `live_timeout`, and again after a play (a new warm-up after a break), the phases as a stream's clock items and a long-poll's, `picture()` |
| `test/unit/streams.test.ts`, `sse.test.ts` | resume with `Last-Event-ID`, `limit` counted and `maxS` timed by the SDK against a fake that holds finished streams open, the idle watchdog, gaps and resets (resuming in the new boot), revisions and duplicates, backfill timing, the long-poll, raw packets (repeats dropped per boot: after a restart whose cursors start below the old ones the new boot's packets follow, over SSE and NDJSON, and through a restart of the fake); the SSE and NDJSON parsers (the last event id moves only on dispatch), the byte count |
| `test/unit/api.test.ts`, `transport.test.ts` | all 32 operations against the fake and the fixtures' real replies; a camera listed after the recordings, with no media, its seek refused and a picture per frame (`not_retained`, `session_gone` before a recording's 404); endless media refused (a reply with neither a length nor ranges closed at once), a 416 keeping its size; timeouts, retries, backoff, `Retry-After`, error mapping |
| `test/unit/codec.test.ts`, `inflate.test.ts`, `recording.test.ts`, `internal.test.ts` | the decoders on real frames; the gzip/zlib inflater; recording files, URLs (an error reply's fields, a download that breaks off) and streams, and how lines are classified; helpers |
| `test/unit/damaged.test.ts` | `fixtures/damaged`, the same in every SDK: every line a reader skips and every event that does not decode (SDK-DESIGN.md section 6 and 2.3 rule 9) replayed from a file and from bytes, the header cases, and the events streamed live (frames, the Interpreter's updates, `waitFor`) and as raw packets, with the frames, wall times and final update its JSON files give |
| `test/unit/fake.test.ts` | `FakeFactory` itself: routes, validation (the `Origin` and `dry_run` checks too), recorded and synthesised replies, streams, faults (a restart: a new boot, cursors from 1, open streams broken, one reset), the 20.20-like `connect: "newest"` and `atLimit: "hold"`; the camera of the unit's build live3: shaped as the spec's plant camera and sized like the recording, the select and seek checks in the unit's order and words, a session on a manual clock (nothing released before live, a stream waiting for each phase, the picture's headers) and on the fake's own clock (`advance()`, `now`, `livePhase`; a stream or a long-poll moving it on to each phase, and following a new program), a pause at the live edge, a play that connects again and warms up after a break, every change a clock event at its own time, the frames' numbering (`i`, the raw packet, the overlay, cursors after the recording's), the newest 64 pictures, the picture checks in the unit's order, no world before a frame, a seek to a recording (its hold, the recordings' rate), the catalog's default, appended clock events, the status counts, a recording without a header; the clock's start (the recording's time, else the fake's epoch) |
| `test/unit/viz.test.ts`, `test/browser-example.test.ts` | `SceneView` graphs from real frames, `OverlayCanvas` calls on a recording context, `EventFeed` in happy-dom, `attachToClient`; the example page's code |
| `test/examples.test.ts` | runs every file of `examples/` against `FakeFactory` (the global `fetch` replaced; no network) and checks what it prints |
| `test/docs.test.ts` | every code sample of `README.md` and `docs/` is a region of a tested example (`node scripts/snippets.mjs` fills them), relative links resolve, no page has an unfilled template placeholder (an `ALL_CAPS_NAME` outside code), and the quickstart picture shows what the quickstart prints |
| `test/serve.test.ts` | the example page's static server: request paths map to files inside the package only (`..`, encoded separators, siblings and malformed escapes are refused), on a server bound to 127.0.0.1 (the loopback, which `--network none` keeps) |

No unit test waits on real time: the client and the fake take a `Clock` (`InstantClock`, `ManualClock`), randomness is
seeded, and the one example that paces in real time runs on fake timers. The 60 s test timeout only catches a hang.

## Integration tests (opt-in)

Not part of `make test`; they need a unit or the published recordings, and never run against anything by default.

`make integration` runs them in the test image with the network on. Set `PDIGGER_FACTORY_URL` (an address the
container can reach: an IP address, since `.local` names do not resolve inside Docker), `PDIGGER_FACTORY_RECORDINGS`
(a folder, mounted read-only), or both:

```sh
PDIGGER_FACTORY_URL=http://192.0.2.20:8120 make integration
PDIGGER_FACTORY_RECORDINGS=$PWD/recordings make integration
```

The `npm run test:integration` commands below do the same in your own environment.

### A unit, read-only

```sh
PDIGGER_FACTORY_URL=http://factory-orin.local:8120 npm run test:integration -- test/integration/unit.test.ts
```

Every stream is an `observe=1` stream (not a viewer) and every control is sent with `dry_run=1` (validated, not
applied): nothing moves the shared session. The checks: the meta operations, the sources and the live cameras (or
`live_unavailable`), a dry-run watch of a camera and its pictures (or a recording's `not_found`), the session clock, frames as an observer and an Interpreter over them, the long-poll, frames, the
world, events, a stone, both render operations, a raster, and the dry-run controls.

### The published recordings

```sh
mkdir recordings && cd recordings
curl -fsSLO https://factory.pdigger.com/developers/data/recordings.json
for v in dry1 dry2 aug28 jul30; do for f in $v.world.ndjson.gz $v.summary.json $v.summary.txt; do
  curl -fsSLO https://factory.pdigger.com/developers/data/$f; done; done
cd .. && PDIGGER_FACTORY_RECORDINGS=$PWD/recordings npm run test:integration -- test/integration/recordings.test.ts
```

Every `<video>.world.ndjson.gz` in the folder is replayed, so one recording is enough. Its sha256 is checked against
`recordings.json` when that is there, and its summary (JSON and text) is compared with the golden summary beside it (or
in `fixtures/golden/complete/`). The `integration` workflow runs this
weekly and on demand; it also takes a unit's URL for the read-only checks.

## Node 18, Deno and Bun

The dev tools need Node 20 or newer, the package itself Node 18. `scripts/smoke.mjs` (after `npm run build`) imports
the built package by its name, replays every fixture recording against its golden files and runs an Interpreter on the
fake, with no network. CI runs it on Node 18, Deno 2 and Bun 1:

```sh
npm run build
node scripts/smoke.mjs
deno run --allow-read --allow-env scripts/smoke.mjs
bun scripts/smoke.mjs
```

## The try-it image

`make image-check` builds the `Dockerfile` image and checks it with no network: the quickstart follows the fake and
prints the golden events of `joined-mid-move`, and the viz page's static server serves the page, the package, three.js
and a fixture recording. CI runs it.

## Workflows

The workflows are checked with actionlint in Docker. In a clone (a git repository) the plain command finds them; in a
copy without `.git`, name the files:

```sh
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest .github/workflows/ci.yml \
  .github/workflows/release.yml .github/workflows/integration.yml
```

## Pictures

`npm run pictures` redraws `docs/img/quickstart-output.svg` (the quickstart's first lines on the fixture recording
`joined-mid-move`, video dry1, grid frames 399 to 420) and the screenshots `docs/img/viz-example*.png` (the example page
on `dry1-0296-0306-full`, stopped at grid frame 1512) with a local headless Chrome (`CHROME=/path/to/chrome`). They are
made from the fixture recordings, never mocked; `test/docs.test.ts` checks the quickstart picture's text.

## Fixtures

`fixtures/` and `spec/` are shared by the four languages; do not change them here: open an issue.
