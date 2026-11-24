# Start here: one report per tray

The SDK has two modes. Simple mode is for the people who run the line: for each tray, which stones were taken off, which
were put on and which moved, when and where, and whether that is the tray's whole account. Advanced mode is the detail underneath,
for research and for the moments a report is not complete: the hands' events and activities, every tray fact with its
reason, the frames and one call per API operation. Start in simple mode; switch to advanced mode only when you need
more.

This tutorial reads the reports of a recording, offline, turns them into data, looks at the details behind a report
that is not complete, and then follows a unit. Its code is
[examples/tutorial-reports.ts](../../examples/tutorial-reports.ts), and the live step is
[examples/quickstart-reports.ts](../../examples/quickstart-reports.ts).

## 1. One report per tray

Install the SDK (see [the tutorials' start](README.md#before-you-start)) and take a recording: the fixture
`fixtures/recordings/dry1-0018-0153.ndjson.gz` is dry1 from 0:18 to 2:33, where a tray arrives with 42 stones and a
worker takes stones off, sets others down and pushes the rest into place. Any published recording works the same, as
a path or a URL.

<!-- snippet: examples/tutorial-reports.ts#reports -->
```ts
const replay = await Replay.open(source); // streamed, gzip or not
for (const report of await replay.trayReports()) {
  console.log(report.describe());
}
```

The report of dry1-0018-0153's tray:

```text
tray 1 (2026-11-22T02:38:47.0Z), 0:22.5 to 2:24.0: 11 removed, 13 added, 8 moved, not complete: 18 unclear, 1 not sure
  0:45.5 removed 20261122T023847.0Z-1-117 from (0.68, -1.06) (0.98)
  0:45.5 removed 20261122T023847.0Z-1-127 from (1.14, -1.24) (0.98)
  0:59.4 removed 20261122T023847.0Z-1-126 from (0.35, -1.29) (0.98)
  1:05.4 removed 20261122T023847.0Z-1-105 from (0.49, -0.82) (0.98)
  1:23.6 removed 20261122T023847.0Z-1-112 from (-0.11, -0.84) (0.98)
  1:23.6 removed 20261122T023847.0Z-1-125 from (-0.09, -1.26) (0.98)
  2:24.0 removed 20261122T023847.0Z-1-87 from (0.02, -0.17) (unclear, 0.71)
  2:24.0 removed 20261122T023847.0Z-1-121 from (0.33, -1.27) (unclear, 0.71)
  2:24.0 removed 20261122T023847.0Z-1-128 from (0.56, -1.29) (unclear, 0.71)
  2:24.0 removed 20261122T023847.0Z-1-129 from (0.74, -1.29) (unclear, 0.71)
  2:24.0 removed 20261122T023847.0Z-1-130 from (0.87, -1.27) (unclear, 0.71)
  2:24.0 added 20261122T023943.4Z-1-151 at (0.16, -1.26) (unclear, 0.52)
  2:24.0 added 20261122T024104.0Z-1-177 at (0.02, -0.82) (unclear, 0.96)
```

These are its first fourteen lines; eleven more additions and its eight moves follow. The first line is the tray: its
number, its arrival on the unit's clock (UTC), when it arrived and left in the recording, and the counts. Then one line
per change, each ending with its confidence: how likely it is to be right, from how often changes of its kind were right
on 150 trays of the four complete recordings checked against their video (step 2 keeps the likely ones). The first six
removals are certain, each made at a calm moment some seconds after the world lost its stone, once its place had stayed
empty; the unit's speckle check of the tray, part of every report, finds none of them on the tray as it left, so each is
0.98. The other five removals and the additions were made as the tray left (unclear): 0.71 for a stone the check finds
nowhere on the tray as it left, 0.96 for an addition it finds nowhere on the tray as it arrived, 0.52 where it cannot
tell. The camera check (the maintainers' offline test, not published, that matches each stone's speckle in the
recording's video, the tray as it arrived against the tray as it left) confirms all six certain removals, and every
stone that left is in the report: the other two (87 and 129) are among the five unclear removals. The worker pushed most
of the other stones while squaring the rows up: the world lost some of them and saw them again under new ids, and the
speckle check finds them again as the tray leaves (step 3), so only one stone is still not sure. A hand can also take a
stone away and set another one down in its place, so the SDK links a lost stone to a new world id only with evidence
that it is the same stone (the speckle check, their looks, or no hand near either); without it, the lost stone is
removed and the new one added, both unclear, and the stone's id never goes to another stone. Of the thirteen unclear
additions, ten are stones the worker set down and three came in on the tray. Each change gives the stone's final place
on the tray, in the world's scene units: where a removed stone was before it was taken, where an added or moved stone
sits as the tray leaves, for matching the report with another system that looks at the trays. A stone is reported moved
only when the SDK is sure it is the same stone, saw it as the tray left and something touched it on the tray, and it
moved more than three quarters of its short side once the tray's own shift is taken out; here eight did, 0.33 to 0.43
scene units, and a move is 0.87 likely. `not complete` says the report is not the tray's whole account: 18 changes are
unclear and 1 other departing stone has an uncertain identity. Complete means complete as far as the world sees. A stone
the model stops seeing for good while it stays on the tray is removed: for certain when a hand touched it just before,
else unclear (3 of the 52 certain removals in a camera check of the four complete recordings, each one a stone a hand
had moved). A box seen on an empty slot at the arrival becomes a tray stone. A stone the world does not have as the tray
leaves is not in the account. Nor is one it keeps there without a box while a hand holds it, or with 30 % or more of its
box under the box of a stone no hand holds (none here: the camera counts 44 stones as the tray leaves, and so does the
account) ([interpreter.md](../interpreter.md)).

## 2. The same reports as data

A report is also data for a database, an MES or a spreadsheet: one row per tray, with the changes at or above a
threshold of your own.

<!-- snippet: examples/tutorial-reports.ts#rows -->
```ts
const THRESHOLD = 0.9; // keep the changes at least this likely to be right
for (const report of await replay.trayReports()) {
  const row = {
    tray: report.tray,
    arrived: report.arrived.wall, // UTC epoch seconds (null when the unit's clock is not known)
    left: report.left.wall,
    removed: report.removed.filter((change) => change.confidence >= THRESHOLD).map((change) => change.stone),
    added: report.added.filter((change) => change.confidence >= THRESHOLD).map((change) => change.stone),
    moved: report.moved.map((change) => change.stone),
    unclear: report.unclear,
    complete: report.complete,
  };
  console.log(JSON.stringify(row)); // JSON.stringify(report) has every field
}
```

Each change (`TrayChange`) has the stone's id, the point it happened at (frame `g`, media time `t`, wall clock), whether
it is certain, its `confidence`, its code (`carried_away`, `missing` or `not_found` for a removal; `set_down` or
`not_recognised` for an addition), and the stone's place and size; a moved stone also has how far it moved. At 0.9 the
row of dry1-0018-0153's tray keeps its six certain removals and nine of its thirteen additions, all fifteen right by the
camera check, and every move. The confidence is a constant per kind of change and what the speckle check found
([interpreter.md](../interpreter.md#confidence) has the table), so a threshold means the same in every language and on
every unit. The stone ids are the SDK's own: one per stone, never reused, so a row can be joined with the stones of the
next station.

## 3. When a report is not complete: the details

Advanced mode says why. Every tray fact names a stone, a moment and a reason:

<!-- snippet: examples/tutorial-reports.ts#details -->
```ts
for (const tray of await replay.trays()) {
  const report = tray.report();
  if (report === null || report.complete) continue;
  for (const fact of tray.facts) {
    console.log(fact.describe()); // 0:30.1 tray 1: stone 20261122T023847.0Z-1-94 is not sure any more (it was pushed)
  }
}
```

A complete report is skipped: it has no unclear change and no stone that is not sure, so there is nothing to look
behind.

In dry1-0018-0153, 21 stones stopped being sure, each pushed or next to a pushed stone while the worker squared the
rows up. The first facts after the arrival:

```text
0:22.5 tray 1 arrived: 42 stones
0:30.1 tray 1: stone 20261122T023847.0Z-1-89 is not sure any more (a stone next to it was pushed)
0:30.1 tray 1: stone 20261122T023847.0Z-1-93 is not sure any more (a stone next to it was pushed)
0:30.1 tray 1: stone 20261122T023847.0Z-1-94 is not sure any more (it was pushed)
```

As the tray leaves, the unit's speckle check settles most of them: it confirms eight stones that were not sure, finds
four that the world had lost and recognises two on other world stones (the number is the speckle match's score):

```text
2:24.0 tray 1: stone 20261122T023847.0Z-1-89 confirmed by its speckle on world stone 89 (0.566)
2:24.0 tray 1: stone 20261122T023847.0Z-1-93 confirmed by its speckle on world stone 93 (0.712)
2:24.0 tray 1: stone 20261122T023847.0Z-1-94 confirmed by its speckle on world stone 94 (0.627)
2:24.0 tray 1: stone 20261122T023847.0Z-1-95 confirmed by its speckle on world stone 95 (0.681)
2:24.0 tray 1: stone 20261122T023847.0Z-1-102 confirmed by its speckle on world stone 102 (0.562)
2:24.0 tray 1: stone 20261122T023847.0Z-1-107 found again by its speckle on world stone 191 (0.720)
2:24.0 tray 1: stone 20261122T023847.0Z-1-109 confirmed by its speckle on world stone 205 (0.684)
2:24.0 tray 1: stone 20261122T023847.0Z-1-103 confirmed by its speckle on world stone 210 (0.677)
2:24.0 tray 1: stone 20261122T023847.0Z-1-97 confirmed by its speckle on world stone 218 (0.767)
2:24.0 tray 1: stone 20261122T023847.0Z-1-119 found again by its speckle on world stone 230 (0.634)
2:24.0 tray 1: stone 20261122T023847.0Z-1-118 found again by its speckle on world stone 231 (0.584)
2:24.0 tray 1: stone 20261122T023847.0Z-1-116 recognised by its speckle on world stone 238 (0.759)
2:24.0 tray 1: stone 20261122T023847.0Z-1-120 found again by its speckle on world stone 240 (0.598)
2:24.0 tray 1: stone 20261122T023847.0Z-1-106 recognised by its speckle on world stone 266 (0.706)
```

What is still open then is reported: three stones in question are not sure any more, and two of them, with three
others, are not found; thirteen occupants are not recognised:

```text
2:24.0 tray 1: stone 20261122T023847.0Z-1-87 is not sure any more (it was pushed; open since 0:45.5)
2:24.0 tray 1: stone 20261122T023847.0Z-1-98 is not sure any more (a stone next to it was pushed; open since 0:45.5)
2:24.0 tray 1: stone 20261122T023847.0Z-1-121 is not sure any more (it was pushed; open since 1:05.4)
2:24.0 tray 1: stone 20261122T023847.0Z-1-87 not found (unclear)
2:24.0 tray 1: stone 20261122T023847.0Z-1-121 not found (unclear)
```

The departure fact counts confirmed set-downs under `added` and groups the five unclear removals and the thirteen
uncertain additions under `unclear`. The camera counts 44 stones on the departing tray, and so does the account: one of
its additions, world 281, is a stone a hand set down six seconds before, which the world kept on the tray although the
model had not boxed it yet. Last:

```text
2:24.0 tray 1: stone 20261122T024126.9Z-1-284 not recognised (unclear)
2:24.0 tray 1 leaving: 44 stones (30 sure), 0 added, 6 removed, 18 unclear
```

How the speckle check works, and how to read its answers yourself, is in
[interpreter.md](../interpreter.md#the-units-speckle-check).

`tray.open` goes one step further: for every stone left open, the readings the evidence still allows (which world
stone it may be, or gone), as [SDK-DESIGN.md 4.6.8](../../spec/SDK-DESIGN.md#468-the-open-account) describes.
These are the cases to look at, or to settle by hand: the facts name the stones and the moments.

## 4. Follow a unit, live

The same report comes from a unit as each tray leaves: when the next tray arrives, the session changes or the frames
end.

<!-- snippet: examples/quickstart-reports.ts#follow -->
```ts
const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
for await (const report of factory.interpreter().trayReports()) {
  console.log(report.describe()); // JSON.stringify(report) is the same as data, for your MES or ERP
}
```

Run it with `node examples/quickstart-reports.ts --follow` (`PDIGGER_FACTORY_URL`, else http://factory-orin.local:8120).
Without a unit, `node --import ./scripts/fake-preload.mjs examples/quickstart-reports.ts --follow` runs it against the
SDK's fake unit, as the tests do ([testing.md](../testing.md)).

## Next

- [High level](01-high-level.md): what the hands did, as sentences and as data, and the trays fact by fact.
- [Low level](02-low-level.md): one call per API operation, the frames and the model's maps.
- [Live cameras](03-live-cameras.md): select a plant camera and follow it.
- [TypeScript](04-typescript.md): async iterables, Node, Deno, Bun and the browser, the fake unit as a `fetch`.
