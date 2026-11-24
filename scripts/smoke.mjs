// A runtime check of the built package (dist/, imported by its name) on the runtime in use: CI runs it on Node 18, the
// oldest supported, where the dev tools of the unit tests do not run, and on Deno and Bun. Every fixture recording
// replays to its golden files, and an Interpreter follows FakeFactory. No network.
//
//   npm run build && node scripts/smoke.mjs
//   deno run --allow-read --allow-env scripts/smoke.mjs
//   bun scripts/smoke.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Replay, VERSION } from "pdigger-factory-sdk";
import { FakeFactory, InstantClock } from "pdigger-factory-sdk/testing";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const golden = (name, part) => readFileSync(`${fixtures}golden/${name}.${part}`, "utf8");
let failed = 0;

for (const file of readdirSync(`${fixtures}recordings`)
  .filter((f) => f.endsWith(".ndjson.gz"))
  .sort()) {
  const name = file.slice(0, -".ndjson.gz".length);
  const replay = await Replay.open(`${fixtures}recordings/${file}`);
  const events = [];
  const activities = [];
  for await (const u of replay.updates()) {
    for (const e of u.events) events.push(`${e.describe()}\n`);
    for (const a of u.activities) activities.push(`${a.describe()}\n`);
  }
  const summary = await replay.summary();
  const ok =
    events.join("") === golden(name, "events.txt") &&
    activities.join("") === golden(name, "activities.txt") &&
    summary.describe() === golden(name, "summary.txt") &&
    JSON.stringify(summary.toJSON()) === JSON.stringify(JSON.parse(golden(name, "summary.json")));
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${events.length} events, ${activities.length} activities`);
}

const fake = await FakeFactory.fromFixtures(fixtures, "joined-mid-move");
const factory = fake.client({ clock: new InstantClock() });
const gone = await factory.interpreter().waitFor("gone", { timeout: 10_000 });
console.log(`ok   interpreter on the fake: ${gone.describe()}`);
factory.close();
fake.close();

const runtime = globalThis.Deno
  ? `Deno ${globalThis.Deno.version.deno}`
  : globalThis.Bun
    ? `Bun ${globalThis.Bun.version}`
    : `Node ${process.versions.node}`;
console.log(`pdigger-factory-sdk ${VERSION} on ${runtime}: ${failed === 0 ? "ok" : `${failed} failed`}`);
process.exitCode = failed === 0 ? 0 : 1;
