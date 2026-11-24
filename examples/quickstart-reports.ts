/**
 * Simple mode: one report per tray, which stones were removed, which were added and which moved, when and where, and whether
 * that is the tray's whole account. A recording needs no unit; `--follow` gives the same report from a unit as each
 * tray leaves (PDIGGER_FACTORY_URL, else http://factory-orin.local:8120).
 *
 *     node examples/quickstart-reports.ts fixtures/recordings/dry1-0018-0153.ndjson.gz
 *     node examples/quickstart-reports.ts --follow
 */
import { FactoryClient, Replay } from "pdigger-factory-sdk";

const source = process.argv[2] ?? "https://factory.pdigger.com/developers/data/dry1.world.ndjson.gz";

if (source !== "--follow") {
  // #region reports
  const replay = await Replay.open(source);
  for (const report of await replay.trayReports()) {
    console.log(report.describe());
  }
  // #endregion reports
} else {
  // #region follow
  const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
  for await (const report of factory.interpreter().trayReports()) {
    console.log(report.describe()); // JSON.stringify(report) is the same as data, for your MES or ERP
  }
  // #endregion follow
}
