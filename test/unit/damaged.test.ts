// fixtures/damaged: recordings and streams with lines and events that do not decode (SDK-DESIGN.md section 6, 2.3
// rule 9). Every SDK replays and streams them and gets what their JSON files say.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FactoryError, Update } from "pdigger-factory-sdk";
import { Replay } from "pdigger-factory-sdk";
import { all, clientOf, fixtureFake } from "../helpers/fake.js";
import { fixture, readBytes, readJson } from "../helpers/fixtures.js";

interface Expected {
  header: { name: string; source: boolean } | null;
  updates: number[];
  summary: { frames: number; sessions: number };
  walls: number[];
  final_activities: string[];
  wait_for: { type: string; g: number };
  stream: { events: { id: string; event: string; data: string }[]; frames: number[]; decode_errors: number };
  packets: { events: { id: string; event: string; data: string }[]; g: number[]; decode_errors: number };
}

const EXPECTED = readJson<Expected>("damaged/lines.json");
const HEADERS = readdirSync(fixture("damaged"))
  .filter((f) => f.startsWith("header-") && f.endsWith(".ndjson"))
  .sort();

function checkUpdates(updates: Update[]): void {
  const frames = updates.slice(0, -1);
  const final = updates[updates.length - 1] as Update;
  expect(frames.map((u) => u.frame?.g)).toEqual(EXPECTED.updates);
  frames.forEach((u, k) => expect(u.state.wall).toBeCloseTo(EXPECTED.walls[k] as number, 6));
  expect(final.isFinal).toBe(true);
  expect(final.activities.map((a) => a.describe())).toEqual(EXPECTED.final_activities);
}

const sse = (events: { id: string; event: string; data: string }[]) => ({
  body: events.map((e) => `id: ${e.id}\nevent: ${e.event}\ndata: ${e.data}\n\n`).join(""),
  contentType: "text/event-stream",
});

describe("damaged recordings", () => {
  it("replays every good line and skips every damaged one, from a file, bytes and memory", async () => {
    const replay = await Replay.open(fixture("damaged/lines.ndjson"));
    expect(replay.header?.name).toBe(EXPECTED.header?.name);
    checkUpdates(await all(replay.updates()));
    const summary = await replay.summary();
    expect([summary.frames, summary.sessions]).toEqual([EXPECTED.summary.frames, EXPECTED.summary.sessions]);
    const bytes = Replay.fromBytes(readBytes("damaged/lines.ndjson"));
    checkUpdates([...bytes.updatesSync()]);
    expect([...bytes.framesSync()].map((f) => f.g)).toEqual(EXPECTED.updates);
    expect((await all(bytes.frames())).map((f) => f.g)).toEqual(EXPECTED.updates);
  });

  it.each(HEADERS)("takes the header from the first line only when it decodes: %s", async (name) => {
    const want = readJson<{ header: Expected["header"]; updates: number[] }>(
      `damaged/${name.replace(/ndjson$/, "json")}`,
    );
    for (const replay of [
      await Replay.open(fixture(`damaged/${name}`)),
      Replay.fromBytes(readBytes(`damaged/${name}`)),
    ]) {
      const h = replay.header;
      expect(h === null ? null : { name: h.name, source: h.source !== undefined }).toEqual(want.header);
      expect((await all(replay.updates())).flatMap((u) => (u.frame ? [u.frame.g] : []))).toEqual(want.updates);
      expect((await all(replay.frames())).map((f) => f.g)).toEqual(want.updates); // the frames read the header too
    }
    expect([...Replay.fromBytes(readBytes(`damaged/${name}`)).framesSync()].map((f) => f.g)).toEqual(want.updates);
  });
});

describe("damaged streams", () => {
  it("skips every event that does not decode, live: frames, the interpreter and waitFor", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    const factory = clientOf(fake);
    const skipped: FactoryError[] = [];
    const onDecodeError = (e: FactoryError): void => void skipped.push(e);
    fake.failNext("streamFrames", 1, sse(EXPECTED.stream.events));
    const items = await all(factory.streams.frames({ resume: false, onDecodeError }));
    expect(items.flatMap((i) => (i.kind === "frame" ? [i.frame.g] : []))).toEqual(EXPECTED.stream.frames);
    expect(skipped.map((e) => e.code)).toEqual(Array<string>(EXPECTED.stream.decode_errors).fill("decode"));
    skipped.length = 0;
    fake.failNext("streamFrames", 1, sse(EXPECTED.stream.events));
    checkUpdates(await all(factory.interpreter({ resume: false, onDecodeError }).updates()));
    expect(skipped).toHaveLength(EXPECTED.stream.decode_errors);
    fake.failNext("streamFrames", 1, sse(EXPECTED.stream.events));
    const found = await factory.interpreter({ resume: false }).waitFor(EXPECTED.wait_for.type, { timeout: 5000 });
    expect(found.g).toBe(EXPECTED.wait_for.g); // past every event that does not decode
  });

  it("skips every packet that does not decode", async () => {
    const fake = await fixtureFake("dry1-0296-0306-full");
    const factory = clientOf(fake);
    const skipped: FactoryError[] = [];
    fake.failNext("rawStream", 1, sse(EXPECTED.packets.events));
    const items = await all(factory.streams.rawPackets({ resume: false, onDecodeError: (e) => void skipped.push(e) }));
    expect(items.flatMap((i) => (i.kind === "packet" ? [i.packet.g] : []))).toEqual(EXPECTED.packets.g);
    expect(skipped).toHaveLength(EXPECTED.packets.decode_errors);
  });
});
