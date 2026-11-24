/**
 * Test helpers (SDK-DESIGN.md section 12), for your own unit tests and the SDK's: {@link FakeFactory}, an in-process
 * fake of the API as a `fetch` implementation, and clocks that never sleep for real.
 *
 * ```ts
 * import { FakeFactory, InstantClock } from "pdigger-factory-sdk/testing";
 *
 * const fake = await FakeFactory.create({ recording: "fixtures/recordings/dry1-0000-0130.ndjson.gz" });
 * const factory = fake.client({ clock: new InstantClock() });
 * const ev = await factory.interpreter().waitFor("lift");
 * ```
 *
 * A live camera (`live: true`, {@link LIVE_CAMERA}) connects, warms up and goes live on the fake's clock, as the 20.20
 * unit's build live3 does. On a clock you give the fake, give the client the same one, so that `untilLive()` moves it;
 * without a `clock` option the fake's own clock stands still, except that a stream or a long-poll waiting for the
 * camera's next phase moves it on, and so does `fake.advance(seconds)`.
 *
 * ```ts
 * const fake = await FakeFactory.create({ recording, live: true, clock: new InstantClock() });
 * const factory = fake.client({ clock: fake.clock });
 * await factory.session.watch(await factory.live());
 * await factory.session.untilLive(); // connecting, warming (3 s of frames), then live
 * ```
 *
 * @module
 */
export {
  CONNECT_S,
  FakeFactory,
  KEEP_PICTURES,
  LIVE_CAMERA,
  LIVE_LAG_S,
  type FakeFactoryOptions,
  type FakeReply,
  type FakeRequest,
  type LateLayers,
} from "./fake.js";
export { InstantClock, ManualClock, settle } from "./clock.js";
export { TINY_PNG, TOPOLOGY } from "./data.js";
export { seededRandom } from "../internal/random.js";
