/**
 * The trays of a recording: when each had arrived and settled, and when it was about to move out, with the stones
 * removed from it for certain. Then one tray on the shared session: its two points as dry runs (a real seek moves the
 * one session for every viewer).
 *
 * The tray stones carry the SDK's own ids, one per stone and never reused, so "stone X was removed" holds over time;
 * the world's ids are the engine tracker's, which renames stones and reuses ids.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/tray-points.ts      # dry1 (published), tray 2
 *     PDIGGER_FACTORY_URL=… node examples/tray-points.ts fixtures/recordings/dry1-0018-0153.ndjson.gz 1
 */
import { FactoryClient, Replay, clock } from "pdigger-factory-sdk";

const source = process.argv[2] ?? "https://factory.pdigger.com/developers/data/dry1.world.ndjson.gz";
const show = Number(process.argv[3] ?? 2);

// #region trays
const trays = await (await Replay.open(source)).trays(); // every tray, with its two points
for (const tray of trays) {
  const window = tray.window();
  if (window === null) continue; // a stop that never settled
  console.log(`tray ${tray.n}: arrived ${clock(window[0])}, leaving ${clock(window[1])}`);
  for (const stone of tray.stones) {
    if (stone.status === "removed" && stone.certain === true) console.log(`  removed: ${stone.id}`);
  }
}
// #endregion trays

// #region seek
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
// #endregion seek
