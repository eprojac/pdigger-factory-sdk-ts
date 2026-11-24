/**
 * Sources and the shared session: what the unit can show (recordings, and live cameras listed after them by serial),
 * the session's clock, and a watch sent as a dry run. Read-only: the dry run changes nothing.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/sources.ts
 */
import { FactoryClient, fmt, isFactoryError } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");

// #region sources
for (const source of await factory.sources()) {
  const length = source.duration === null ? "live" : `${Math.round(source.duration)} s`;
  console.log(`${source.id}: ${source.title} (${source.kind}, ${length}, seekable: ${source.seekable})`);
}

const live = await factory.live().catch((err: unknown) => {
  if (isFactoryError(err, "live_unavailable")) return null; // a unit that lists recordings only
  throw err;
});
console.log(live === null ? "this unit lists no camera" : `live camera: ${live.title} (${live.station})`);

// the session's clock maps media time to the server's and this machine's wall clock
const clock = await factory.session.clock({ samples: 3 });
const t = clock.mediaTimeNow();
console.log(`the session plays ${clock.state.video}, now at ${fmt(t, 1)} s of media (live: ${clock.isLive})`);
const local = clock.localWallOf(t); // null only for a rate of 0
console.log(`that moment on this machine's clock: ${local === null ? "-" : new Date(local * 1000).toISOString()}`);
// #endregion sources

// #region dry-watch
const target = live ?? (await factory.sources())[0]; // the first camera, or else the first recording
if (target !== undefined) {
  const would = await factory.session.watch(target, { dryRun: true }); // the unit checks it; nothing changes
  console.log(`watching ${target.id} would start session ${would.session} at ${fmt(would.anchor_media, 1)} s`);
}
// #endregion dry-watch
