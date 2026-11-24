# Read your first tray report

<a id="start-here-one-report-per-tray"></a>

A worker sorts a tray of 42 stones in the bundled `dry1-0018-0153` recording. Use it to read the tray totals, export
a row of data and investigate an uncertain removal. You can do the first three steps on your laptop.

Follow the [installation steps](../../README.md#install) to get the SDK and its example recordings. Run the commands
below from the clone after `npm ci` and `npm run build`.

<a id="1-one-report-per-tray"></a>

## 1. Run the example

```sh
node examples/tutorial-reports.ts fixtures/recordings/dry1-0018-0153.ndjson.gz
```

For `dry1-0018-0153`, the report starts with these two lines.

```text
tray 1 (2026-11-22T02:38:47.0Z), 0:22.5 to 2:24.0: 11 removed, 13 added, 8 moved, not complete: 18 unclear, 1 not sure
  0:45.5 removed 20261122T023847.0Z-1-117 from (0.68, -1.06) (0.98)
```

The first line gives the arrival time in UTC, followed by the arrival and departure times in the recording. The next
lines identify individual stones. For example, the SDK last saw the stone whose tray ID ends in `-117` at
`(0.68, -1.06)` before its removal. The final number, `0.98`, is the estimated probability that this removal
happened.

The SDK reports 11 removals. It marks six as certain and five as unclear. The 13 additions are also unclear, which
accounts for the `18 unclear` in the header. One other stone’s identity is still uncertain (`1 not sure`).

<a id="2-the-same-reports-as-data"></a>

## 2. Export the changes

The [tutorial program](../../examples/tutorial-reports.ts) writes one JSON row per tray. It keeps removals and
additions with a confidence of at least `0.9`, and includes every move. For this tray that gives six removals, nine
additions and eight moves.

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

Use `JSON.stringify(report)` for the complete report data. Filtering rows for export does not change the original
report’s `complete`, `unclear` and `unsure` fields.
[Confidence scores by change type](../interpreter.md#confidence).

<a id="3-when-a-report-is-not-complete-the-details"></a>

## 3. Look up an uncertain change

For an incomplete report, the example prints the facts for that tray. Each fact gives the time, the stone ID when
available, and the reason the SDK recorded it. Here is the first stone whose identity became uncertain in
`dry1-0018-0153`.

```text
0:22.5 tray 1 arrived: 42 stones
0:30.1 tray 1: stone 20261122T023847.0Z-1-89 is not sure any more (a stone next to it was pushed)
```

A push can make two similar stones hard to tell apart. At departure, the unit compares their surface patterns
(speckle) with the arrival image. Inspect `tray.open` to see which identities are still possible for a stone.
[How the speckle check works](../interpreter.md#the-units-speckle-check) ·
[Worked example for this tray](../interpreter.md#reading-the-dry1-report).

<a id="4-follow-a-unit-live"></a>

## 4. Read reports live

Point the [live report example](../../examples/quickstart-reports.ts) at your factory unit. The interpreter returns
the report when it closes the tray, which can happen when the next tray arrives, the session changes or the stream
ends.

```sh
PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/quickstart-reports.ts --follow
```

To try this with a simulated unit, see the [testing guide](../testing.md).

## Next

[Follow hand movements and tray events](01-high-level.md) or [choose another tutorial](README.md).
