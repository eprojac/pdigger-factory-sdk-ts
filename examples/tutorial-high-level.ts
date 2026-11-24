/**
 * The high-level tutorial (docs/tutorials/01-high-level.md) in one program, offline: a recording's activities, its
 * trays and the stones removed from them, and from one pass its summary and a stone's path. Any recording works: a
 * path, or an http(s) URL such as https://factory.pdigger.com/developers/data/dry1.world.ndjson.gz.
 *
 *     node examples/tutorial-high-level.ts fixtures/recordings/dry1-0018-0153.ndjson.gz
 */
import { Replay, clock } from "pdigger-factory-sdk";

const source = process.argv[2] ?? "fixtures/recordings/dry1-0018-0153.ndjson.gz";
const stone = Number(process.argv[3] ?? 155);

// #region activities
const replay = await Replay.open(source); // streamed, gzip or not: only the interpreter's state is in memory
for await (const activity of replay.activities()) {
  console.log(activity.describe()); // 1:19.2 Left hand takes stone 155 away (1.0 s)
}
// #endregion activities

// #region moves
for await (const activity of replay.activities()) {
  if (activity.kind !== "move") continue; // a hand moving one stone; the other activities are bursts of pushes
  const took = activity.duration === null ? "still open" : `${activity.duration.toFixed(1)} s`;
  const at = clock(activity.start.t);
  console.log(`${at} stone ${activity.stoneId}: ${activity.hand} hand, ${activity.outcome}, ${took}`);
}
// #endregion moves

// #region tray-facts
for await (const fact of replay.trayFacts()) {
  console.log(fact.describe()); // 0:22.5 tray 1 arrived: 42 stones
}
// #endregion tray-facts

// #region trays
for (const tray of await replay.trays()) {
  const window = tray.window();
  if (window === null) continue; // a stop that never settled
  const [arrived, leaving] = window;
  const gone = tray.stones.filter((s) => s.status === "removed" && s.certain);
  console.log(`tray ${tray.n}: ${clock(arrived)} to ${clock(leaving)}, ${gone.length} stones removed for certain`);
}
// #endregion trays

// #region one-pass
for await (const update of replay.updates()) void update; // one pass: the events, activities and facts of each frame
const core = replay.core; // that pass's interpreter: its state, its summary, and every stone's path
if (core !== null) {
  console.log(core.summary().describe());
  const path = core.track(stone); // where the stone was, frame by frame (scene units)
  const [first, last] = [path[0], path.at(-1)];
  if (first && last) console.log(`stone ${stone}: ${path.length} points from ${clock(first.t)} to ${clock(last.t)}`);
}
// #endregion one-pass
