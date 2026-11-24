import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { FactoryClient } from "pdigger-factory-sdk";
import { seededRandom, type ClientOptions } from "pdigger-factory-sdk";
import { FakeFactory, InstantClock, settle, type FakeFactoryOptions } from "pdigger-factory-sdk/testing";
import { FIXTURES, recordingPath } from "./fixtures.js";

/** A fake of a fixture recording with the fixture replies. */
export function fixtureFake(recording = "dry1-0000-0130", options: FakeFactoryOptions = {}): Promise<FakeFactory> {
  return FakeFactory.fromFixtures(FIXTURES, recording, options);
}

/**
 * Makes the fake's next `count` `GET /session` replies the state its fixture recording `recording` starts with (its
 * first clock line), as the unit answered a viewer that joined when the recording began. The fake answers that state
 * itself only until a stream or a long-poll has played past the recording's later clock lines, and from then on the
 * state in force there: on a recording whose clock changed on the way (dry1's rate goes from 0.8 to 0.74 and 0.75 in
 * its first 23 s), a later Interpreter on the same fake, which plays the recording from its start again but reads that
 * newest state on connect, gives other wall times, and so other tray stone ids, than a replay. A recording without a
 * clock line changes nothing.
 */
export function joinAtStart(fake: FakeFactory, recording: string, count: number): void {
  const text = gunzipSync(readFileSync(recordingPath(recording))).toString("utf8");
  const line = text.split("\n").find((l) => l.startsWith('{"sse":"clock"'));
  if (line === undefined) return;
  const { server_now: serverNow, ...state } = (JSON.parse(line) as { data: Record<string, unknown> }).data;
  fake.failNext("getSession", count, { body: { server_now: serverNow, state } });
}

/** A client of a fake that never sleeps for real and has deterministic jitter. */
export function clientOf(fake: FakeFactory, options: ClientOptions = {}): FactoryClient {
  return fake.client({ clock: new InstantClock(), random: seededRandom(7), ...options });
}

/** Collects at most `n` items of an async iterable. */
export async function take<T>(it: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  if (n <= 0) return out;
  for await (const x of it) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

/** Collects every item of an async iterable. */
export async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** The rejection of a promise (fails the test when it resolves). */
export async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

/** Lets the event loop turn until `done()` holds (at most `turns` macrotask turns, then it fails). */
export async function until(done: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !done(); i++) await settle();
  if (!done()) throw new Error("the condition did not come true");
}
