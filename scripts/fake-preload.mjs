// `node --import ./scripts/fake-preload.mjs <example>` runs an example against FakeFactory instead of a unit: the
// global fetch becomes the fake's, serving fixtures/recordings/$FAKE_RECORDING (default dry1-0000-0130) and the
// recorded replies of fixtures/api. Nothing leaves the process.
import { FakeFactory } from "pdigger-factory-sdk/testing";

const fixtures = new URL("../fixtures/", import.meta.url).pathname;
const recording = process.env.FAKE_RECORDING ?? "dry1-0000-0130";
const fake = await FakeFactory.fromFixtures(fixtures, recording);
globalThis.fetch = fake.fetch;
process.env.PDIGGER_FACTORY_URL ??= "http://fake.factory";

// At the end of the recording the fake holds its streams open, as a unit does, but in this process nothing more can
// arrive: end there instead of letting Node report an unsettled top-level await (exit code 13).
process.on("beforeExit", () => {
  if (fake.streams === 0) return;
  console.error(`(end of the fixture recording ${recording}: the fake unit has nothing more to send)`);
  process.exit(0);
});
