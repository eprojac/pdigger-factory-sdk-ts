/**
 * A consumer of the built package (dist/, imported by its name through "exports"), type-checked as an application
 * checks it, with `skipLibCheck` off (`npm run typecheck:consumer`, after `npm run build`): the core and the testing
 * module. The configs here are a browser or Deno project (lib ES2022 and DOM, no Node types), a Node project
 * (`@types/node`, no DOM) and an ESNext one; viz.ts adds the three.js helpers.
 */
import { FactoryClient, Replay, isFactoryError, type FactoryEvent, type Update } from "pdigger-factory-sdk";
import { FakeFactory, InstantClock } from "pdigger-factory-sdk/testing";

export async function firstLift(url: string): Promise<FactoryEvent | null> {
  const factory = new FactoryClient(url);
  const interpreter = factory.interpreter();
  try {
    return await interpreter.waitFor("lift", { timeout: 60_000, signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    if (isFactoryError(err, "stream_closed")) return null;
    throw err;
  } finally {
    interpreter[Symbol.dispose]();
    await factory[Symbol.asyncDispose]();
  }
}

export async function sentences(bytes: Uint8Array): Promise<string[]> {
  const out: string[] = [];
  const replay = await Replay.open(bytes);
  for await (const u of replay.updates()) {
    const update: Update = u;
    for (const e of update.events) out.push(e.describe());
    for (const a of update.activities) out.push(a.describe());
  }
  return out;
}

export async function againstTheFake(lines: readonly string[]): Promise<string> {
  const fake = new FakeFactory(lines);
  const factory = fake.client({ clock: new InstantClock() });
  const push = await factory.interpreter().waitFor("push");
  fake.injectReset("boot2");
  fake.close();
  return `${push.describe()} (${fake.boot})`;
}
