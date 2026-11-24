/**
 * The Interpreter in more detail: updates (events, activities, state), the summary so far, and waiting for an event.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/interpreter.ts
 */
import { FactoryClient } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");

// #region updates
const interpreter = factory.interpreter(); // world and cards layers; counts as a viewer; backfills late worlds
let frames = 0;
for await (const update of interpreter.updates()) {
  for (const activity of update.activities) {
    console.log(activity.describe());
    if (activity.kind === "move" && activity.distance !== null) {
      console.log(`  stone ${activity.stoneId} ${activity.outcome}, ${activity.distance} units from where it was`);
    }
  }
  if (++frames === 600) break; // 600 grid frames: two minutes of media
}
const { left, right } = interpreter.state.hands;
console.log(`hands now: left ${left.state} (${left.card}), right ${right.state} (${right.card})`);
console.log(interpreter.summary().describe());
interpreter.close();
// #endregion updates

// #region wait
// the first right-hand lift, within two minutes (on the client's clock), as an event with its wall time
const lift = await factory.interpreter().waitFor((e) => e.type === "lift" && e.hand === "right", { timeout: 120_000 });
const at = lift.wall === null ? "no wall time" : new Date(lift.wall * 1000).toISOString(); // the unit's clock
console.log(`${lift.describe()} (stone ${lift.stoneId}, ${at})`);

// any of several types; a signal stops the wait (and the stream) early
const placed = await factory.interpreter().waitFor(["place", "drop"], { signal: AbortSignal.timeout(120_000) });
console.log(placed.describe());
factory.close();
// #endregion wait
