/**
 * The first tutorial (docs/tutorials/00-start-here.md) in one program, offline: one report per tray, the same reports
 * as data, and the details behind a report that is not complete. Any recording works: a path, or an http(s) URL such
 * as https://factory.pdigger.com/developers/data/dry1.world.ndjson.gz.
 *
 *     node examples/tutorial-reports.ts fixtures/recordings/dry1-0018-0153.ndjson.gz
 */
import { Replay } from "pdigger-factory-sdk";

const source = process.argv[2] ?? "fixtures/recordings/dry1-0018-0153.ndjson.gz";

// #region reports
const replay = await Replay.open(source); // streamed, gzip or not
for (const report of await replay.trayReports()) {
  console.log(report.describe());
}
// #endregion reports

// #region rows
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
// #endregion rows

// #region details
for (const tray of await replay.trays()) {
  const report = tray.report();
  if (report === null || report.complete) continue;
  for (const fact of tray.facts) {
    console.log(fact.describe()); // 0:30.1 tray 1: stone 20261122T023847.0Z-1-94 is not sure any more (it was pushed)
  }
}
// #endregion details
