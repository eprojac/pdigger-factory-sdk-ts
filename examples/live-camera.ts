/**
 * Watch a plant camera live: select it for the shared session, wait out its warm-up, then print what happens.
 *
 * Selecting a camera changes what every viewer of the unit sees (the page follows the session). The unit connects to
 * the camera, runs the interpreter on its first 3 seconds of frames to warm it up, and then shows it live. Give a
 * camera's serial to watch that one; stop it with Ctrl-C.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/live-camera.ts [serial]
 */
import { FactoryClient, fmt } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
const serial = process.argv[2];

// #region live
const camera = serial === undefined ? await factory.live() : await factory.source(serial); // the first camera, or that
await factory.session.watch(camera); // connecting, then warming up on the camera's first 3 s
const state = await factory.session.untilLive();
const lag = state.live?.lag ?? 0;
console.log(`${camera.id} (${camera.title}) is live: session ${state.session}, ${fmt(lag, 2)} s behind the camera`);

const picture = await factory.session.picture(); // the JPEG the newest frame was interpreted from
console.log(`frame g ${picture.g}: a ${picture.jpeg.length}-byte JPEG`);

for await (const event of factory.interpreter().events()) {
  const at = event.wall === null ? "--:--:--" : new Date(event.wall * 1000).toISOString().slice(11, 19);
  console.log(`${at} UTC  ${event.describe()}`); // on a camera, the wall time is the timestamp that matters
}
// #endregion live
