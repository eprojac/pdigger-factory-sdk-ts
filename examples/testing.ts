/**
 * Testing your own code without a unit: `FakeFactory` answers the API from a recording, deterministically, and
 * `InstantClock` makes every wait (backoff, backfill, timeouts) pass at once. With `live: true` it also has a live
 * camera that connects, warms up and goes live on the fake's clock.
 *
 *     node examples/testing.ts
 */
// #region testing
import { FakeFactory, InstantClock } from "pdigger-factory-sdk/testing";

const fake = await FakeFactory.create({ recording: "fixtures/recordings/dry1-0000-0130.ndjson.gz" });
const factory = fake.client({ clock: new InstantClock() });

const lift = await factory.interpreter().waitFor("lift");
console.log(lift.describe());

// fault injection: the next getWorld answers 503 once; the client retries after retry_ms
fake.failNext("getWorld", 1, { status: 503, body: { error: "busy", code: "world_unavailable", retry_ms: 250 } });
const world = await factory.api.getWorld();
console.log(
  `world at frame ${world.g} after ${fake.requests.filter((r) => r.operationId === "getWorld").length} requests`,
);
factory.close();
fake.close();
// #endregion testing

// #region camera
const withCamera = await FakeFactory.create({
  recording: "fixtures/recordings/dry1-0000-0130.ndjson.gz",
  live: true,
  clock: new InstantClock(),
});
const viewer = withCamera.client({ clock: withCamera.clock }); // one clock: untilLive() moves the fake's
await viewer.session.watch(await viewer.live()); // connecting
const live = await viewer.session.untilLive(); // warming on the first 3 s of frames, then live
console.log(`${live.video} is live, ${live.live?.lag} s behind the camera`);
const picture = await viewer.session.picture(); // the newest frame's camera picture
console.log(`frame ${picture.g} has a ${picture.jpeg.length}-byte picture`);
viewer.close();
withCamera.close();
// #endregion camera
