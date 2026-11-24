# Replay

`Replay` runs the Interpreter over a recording: no unit, no network unless the recording is a URL.

<!-- snippet: examples/replay.ts#replay -->
```ts
import { Replay } from "pdigger-factory-sdk";

const replay = await Replay.open(process.argv[2] ?? "https://factory.pdigger.com/developers/data/dry1.world.ndjson.gz");
console.log(`${replay.header?.name ?? "recording"}: ${replay.header?.frames ?? "?"} frames of ${replay.header?.video}`);

for await (const update of replay.updates()) {
  for (const event of update.events) console.log(event.describe());
  for (const activity of update.activities) console.log(`  -> ${activity.describe()}`);
}
console.log((await replay.summary()).describe());
```

## Opening a recording

| | |
|---|---|
| `Replay.open(source)` | a local path (Node, Deno, Bun), an HTTP(S) URL (or a relative URL in a browser), bytes (`Uint8Array`, `ArrayBuffer`), or a byte stream; reads the header now and streams the rest (bytes in 64 KiB pieces, gzip inflated as it goes), so a 100 MB recording is never held as lines |
| `Replay.load(source)` | the whole recording in memory: the `...Sync` methods work too |
| `Replay.fromBytes(bytes)`, `Replay.fromText(text)`, `Replay.fromLines(lines)` | from memory, synchronously; lines may be NDJSON strings or parsed objects. `fromBytes` inflates gzip whole with the built-in inflater (about 15 MB/s): for small recordings; `open(bytes)` streams |

`.ndjson` and `.ndjson.gz` are both read (gzip is detected by its magic and decompressed with `DecompressionStream`, else
Node's zlib, else a built-in inflater). `replay.header` is the recording's header (its first line that is not blank,
when that has `recording` and decodes; else null): the video, its catalog entry, the build, the layers, what was
redacted, the frame range.

A recording that cannot be read is a `FactoryError`: `transport` when a URL gives no reply or its download breaks off,
the API's code (from its error body, else from the status, as for every request, with its `retryMs`, `waiting` and
`headers`) for an error reply, `decode` for gzip data that is corrupt or ends early. Then there is no final update. A
success without a body (204) is an empty recording. A local file that cannot be opened rejects with the platform's own
error (Node's `ENOENT`, say), as an abort rejects with its `AbortError`.

## Passes

Each of `frames()`, `updates()`, `events()`, `activities()`, `trayFacts()` and `trays()` is a fresh pass over the
recording: a path or URL is read again, bytes are read again, a recording in memory is iterated again, and a byte stream
can be read once (use `Replay.load()` to keep it). `updates()` ends with a final update (`isFinal`, `frame` null)
carrying the activities that `end()` closed (moves still open at the end are `interrupted`) and the facts of the last
tray leaving. `summary()` gives the summary of the last complete pass, or makes one. `replay.core` is the
`InterpreterCore` of the newest pass. Each has a `...Sync` twin for recordings in memory (`traysSync()`,
`trayFactsSync()`, ...). `frames()` gives the frames only, without the side lines (the clock, and the `gap` and `reset`
lines whose dropped frames end the trays' presence questions), so for the rules use the other passes (with the `core`
options of `Replay.open()`) rather than feeding an `InterpreterCore` of your own from `frames()`.

<!-- snippet: examples/replay-sync.ts#sync -->
```ts
const replay = await Replay.load(path); // the whole recording in memory: the ...Sync methods work
for (const activity of replay.activitiesSync()) console.log(activity.describe());
const summary = replay.summarySync();
console.log(JSON.stringify(summary.toJSON().moves));
```

## Trays

`trays()` makes a pass that keeps every tray of the recording (the live interpreter keeps the newest 256 that have left)
and returns them, oldest first: each with its tray stones, whose ids are never reused, its facts, and two points, where
it had arrived and settled and where it was about to move out ([trays and tray
stones](interpreter.md#trays-and-tray-stones)). `tray.window()` is the media span between them, the one to replay or to
show ([examples/tray-points.ts](../examples/tray-points.ts)):

<!-- snippet: examples/tray-points.ts#trays -->
```ts
const trays = await (await Replay.open(source)).trays(); // every tray, with its two points
for (const tray of trays) {
  const window = tray.window();
  if (window === null) continue; // a stop that never settled
  console.log(`tray ${tray.n}: arrived ${clock(window[0])}, leaving ${clock(window[1])}`);
  for (const stone of tray.stones) {
    if (stone.status === "removed" && stone.certain === true) console.log(`  removed: ${stone.id}`);
  }
}
```

On the shared session a seek shows a point to every viewer; a dry run only checks it:

<!-- snippet: examples/tray-points.ts#seek -->
```ts
const tray = trays.find((t) => t.n === show && t.window() !== null);
if (tray !== undefined) {
  const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
  for (const t of tray.window() ?? []) {
    // a dry run: the unit checks the seek and answers what it would show; nothing moves
    const would = await factory.session.seek(t, { video: tray.video ?? undefined, dryRun: true });
    console.log(`seek to ${clock(t)} would show ${would.video} from ${clock(would.anchor_media)}`);
  }
  factory.close();
}
```

For the excerpt `dry1-0018-0153` and tray 1 it prints:

```text
tray 1: arrived 0:22.5, leaving 2:24.0
  removed: 20261122T023847.0Z-1-105
  removed: 20261122T023847.0Z-1-112
  removed: 20261122T023847.0Z-1-117
  removed: 20261122T023847.0Z-1-125
  removed: 20261122T023847.0Z-1-126
  removed: 20261122T023847.0Z-1-127
seek to 0:22.5 would show dry1 from 0:22.5
seek to 2:24.0 would show dry1 from 2:24.0
```

## Pacing

With `pace: "realtime"` the async passes wait so that frames come at their media times, divided by `speed`. The wait
goes through `clock` (default the system clock), so a test passes `ManualClock` or `InstantClock` and never sleeps.

<!-- snippet: examples/replay-sync.ts#pace -->
```ts
// frames at their media times, here twice as fast (a 4.2 s excerpt takes about 2.1 s)
const started = Date.now();
let frames = 0;
for await (const frame of replay.frames({ pace: "realtime", speed: 2 })) frames += frame.world ? 1 : 0;
console.log(`${frames} frames with a world in ${fmt((Date.now() - started) / 1000, 1)} s`);
```

## The recording format

`pfr1` is NDJSON, optionally gzipped. Line 1 is the header; every other line is a frame exactly as the API sent it (with
`cursor` and `g`; late layers merged in, `missing` listing only layers still missing), or a side event
`{"sse": "clock" | "worker" | "gap" | "reset", "data": {...}, "recv": epoch}` in the order received. Clock lines give
the `wall` times. Bytes that are not UTF-8 read as U+FFFD, and readers skip the lines they do not understand
(SDK-DESIGN.md section 6): blank lines, lines that are not JSON (`NaN` and `Infinity` are not), JSON that is not an
object, frame and side lines that do not decode (a field of SDK-DESIGN.md 2.3 rule 9 missing, null or of the wrong
type: a `g` that is not a whole number, a frame whose `world` is no object, a clock line whose `recv` is not a number),
side lines of events the SDK does not know, and any other line. The header is the first line that is not blank, when
it has `recording` and decodes (a `source` that does not decode is left out of it); otherwise the recording has none,
and a header line further down is skipped like any other line. So a file that is no recording at all replays as
nothing (no frames, no error). `fixtures/damaged` holds a line of each kind; `test/unit/damaged.test.ts` replays them.

## Published recordings

The four complete recordings of 22 November (aug28, jul30, dry1, dry2, every frame interpreted, from the start of each
video to its end: dry1 recorded on the 20.20 unit with build `claude-20261122-hr4x1`, and dry2, aug28 and jul30 the
same model's outputs replayed on a Mac through the interpreter of the same build, as each header's `recorded_from`
says) are at https://factory.pdigger.com/developers/data/ as `<video>.world.ndjson.gz` (world and cards layers) and
`<video>.full.ndjson.gz` (all five layers, redacted), listed in `recordings.json` with sizes, sha256 and their golden
summaries. `Replay.open(url)` streams them; the opt-in test in [TESTING.md](../TESTING.md#the-published-recordings)
replays all four and compares their summaries.

The fixtures in `fixtures/recordings/` are nine short excerpts of the four videos and nine synthetic recordings that
say so in their headers (`revisions-synthetic`, `trays-synthetic`, `trays-looks-synthetic` and its copy without looks,
the four of the presence questions: `trays-presence-synthetic`, `trays-presence-looks-synthetic`,
`trays-presence-attacks-synthetic` and `trays-presence-attacks-looks-synthetic`, and `trays-speckle-synthetic` for the
unit's speckle answers). Of the excerpts, `dry1-0000-0130`,
`dry1-0018-0153`, `dry1-0296-0306-full` and `dry2-pause-seek` were recorded on the 20.20 unit with build
`claude-20261122-hr4x1`; `joined-mid-move` and `session-change-mid-move` are composed from the unit's recordings
(`session-change-mid-move` joins a dry1 excerpt to `dry2-0582-0600`); `dry2-0582-0600` is kept from build
`claude-20261114-int17` on purpose, for its 13 frames without a world (recorded before backfill existed), which cannot
be made again; and aug28's two, `aug28-1270-1300` and `aug28-1276-1284-full`, come from the replay on a Mac. Each
header's `recorded_from` and [fixtures/MANIFEST.json](../fixtures/MANIFEST.json) say where each came from.
