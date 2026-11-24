/**
 * Replay without await: a recording read into memory iterates synchronously; and the same pass paced in real time.
 *
 *     node examples/replay-sync.ts fixtures/recordings/joined-mid-move.ndjson.gz
 */
import { Replay, fmt } from "pdigger-factory-sdk";

const path = process.argv[2] ?? "fixtures/recordings/joined-mid-move.ndjson.gz";

// #region sync
const replay = await Replay.load(path); // the whole recording in memory: the ...Sync methods work
for (const activity of replay.activitiesSync()) console.log(activity.describe());
const summary = replay.summarySync();
console.log(JSON.stringify(summary.toJSON().moves));
// #endregion sync

// #region pace
// frames at their media times, here twice as fast (a 4.2 s excerpt takes about 2.1 s)
const started = Date.now();
let frames = 0;
for await (const frame of replay.frames({ pace: "realtime", speed: 2 })) frames += frame.world ? 1 : 0;
console.log(`${frames} frames with a world in ${fmt((Date.now() - started) / 1000, 1)} s`);
// #endregion pace
