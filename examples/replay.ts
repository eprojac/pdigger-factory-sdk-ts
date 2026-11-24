/**
 * Replay: the same Interpreter over a recording, offline. A published recording
 * (https://factory.pdigger.com/developers/data/) or a local file, `.ndjson` or `.ndjson.gz`.
 *
 *     node examples/replay.ts fixtures/recordings/dry1-0000-0130.ndjson.gz
 */
// #region replay
import { Replay } from "pdigger-factory-sdk";

const replay = await Replay.open(process.argv[2] ?? "https://factory.pdigger.com/developers/data/dry1.world.ndjson.gz");
console.log(`${replay.header?.name ?? "recording"}: ${replay.header?.frames ?? "?"} frames of ${replay.header?.video}`);

for await (const update of replay.updates()) {
  for (const event of update.events) console.log(event.describe());
  for (const activity of update.activities) console.log(`  -> ${activity.describe()}`);
}
console.log((await replay.summary()).describe());
// #endregion replay
