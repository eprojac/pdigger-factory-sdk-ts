/**
 * Quickstart: follow the shared session of a unit (a plant camera live, or a recording) and print what happens on the
 * line as sentences. Stop it with Ctrl-C.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/quickstart.ts
 */
// #region quickstart
import { FactoryClient } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
const state = await factory.session.state();
console.log(`following ${state.video}, session ${state.session}`);

for await (const event of factory.interpreter().events()) {
  console.log(event.describe()); // e.g. "21:17.8 Right hand lifts stone 2660"
}
// #endregion quickstart
