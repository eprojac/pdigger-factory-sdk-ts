import { describe, expect, it } from "vitest";
import {
  Replay,
  describeOpenTxt,
  describeSpeckleTxt,
  type FactoryEvent,
  type Tray,
  type TrayFact,
  type TrayReport,
  type TraySpeckle,
} from "pdigger-factory-sdk";
import { readBytes, readJson, readText, recordingNames, recordingPath } from "./helpers/fixtures.js";

/** The golden `tray-stones.txt` form: `{g} {type} {stone_id} {tray_stone}` for every event with a tray stone. */
const trayStones = (events: Iterable<FactoryEvent>): string =>
  [...events]
    .filter((e) => e.trayStone !== null)
    .map((e) => `${e.g} ${e.type} ${e.stoneId} ${e.trayStone}\n`)
    .join("");

/** The golden `reports.txt` form: every tray report's describe(), then a newline (4.7). */
const reports = (rs: Iterable<TrayReport>): string => [...rs].map((r) => `${r.describe()}\n`).join("");

/**
 * Replay over every fixture recording must equal the golden files exactly (section 5), the tray facts and the open
 * accounts of the trays that left too (4.6).
 */
describe("golden files", () => {
  const names = recordingNames();
  it("finds the fixture recordings", () => {
    expect(names.length).toBeGreaterThanOrEqual(6);
  });
  for (const name of names) {
    describe(name, () => {
      it("matches events, activities, tray facts, open accounts, speckle answers and summary (async replay)", async () => {
        const replay = await Replay.open(recordingPath(name));
        let events = "";
        let activities = "";
        const facts: TrayFact[] = [];
        const all: FactoryEvent[] = [];
        const answers: TraySpeckle[] = [];
        for await (const u of replay.updates()) {
          for (const e of u.events) events += `${e.describe()}\n`;
          for (const a of u.activities) activities += `${a.describe()}\n`;
          facts.push(...u.trayFacts);
          all.push(...u.events);
          answers.push(...u.speckle);
        }
        expect(describeSpeckleTxt(answers)).toBe(readText(`golden/${name}.speckle.txt`)); // 4.6.12
        const summary = await replay.summary();
        expect(events).toBe(readText(`golden/${name}.events.txt`));
        expect(trayStones(all)).toBe(readText(`golden/${name}.tray-stones.txt`)); // each event's tray stone
        expect(activities).toBe(readText(`golden/${name}.activities.txt`));
        expect(facts.map((f) => `${f.describe()}\n`).join("")).toBe(readText(`golden/${name}.trays.txt`));
        expect(describeOpenTxt(facts)).toBe(readText(`golden/${name}.open.txt`));
        expect(summary.describe()).toBe(readText(`golden/${name}.summary.txt`));
        expect(JSON.parse(JSON.stringify(summary.toJSON()))).toEqual(readJson(`golden/${name}.summary.json`));
      });
      it("matches with the synchronous in-memory replay", () => {
        const replay = Replay.fromBytes(readBytes(`recordings/${name}.ndjson.gz`));
        const all = [...replay.eventsSync()];
        const events = all.map((e) => `${e.describe()}\n`).join("");
        expect(trayStones(all)).toBe(readText(`golden/${name}.tray-stones.txt`));
        const activities = [...replay.activitiesSync()].map((a) => `${a.describe()}\n`).join("");
        expect(events).toBe(readText(`golden/${name}.events.txt`));
        expect(activities).toBe(readText(`golden/${name}.activities.txt`));
        expect(replay.summarySync().toJSON()).toEqual(readJson(`golden/${name}.summary.json`));
        const facts = [...replay.trayFactsSync()].map((f) => `${f.describe()}\n`).join("");
        expect(facts).toBe(readText(`golden/${name}.trays.txt`));
        const answers = [...replay.updatesSync()].flatMap((u) => u.speckle);
        expect(describeSpeckleTxt(answers)).toBe(readText(`golden/${name}.speckle.txt`));
      });
      it("keeps every tray fact in the trays of the recording", async () => {
        const kept = (trays: readonly Tray[]): string =>
          trays.flatMap((t) => t.facts.map((f) => `${f.describe()}\n`)).join("");
        const replay = await Replay.open(recordingPath(name));
        expect(kept(await replay.trays())).toBe(readText(`golden/${name}.trays.txt`));
        expect(kept(Replay.fromBytes(readBytes(`recordings/${name}.ndjson.gz`)).traysSync())).toBe(
          readText(`golden/${name}.trays.txt`),
        );
      });
      it("gives the golden tray reports (async, sync, and from each tray)", async () => {
        const replay = await Replay.open(recordingPath(name));
        expect(reports(await replay.trayReports())).toBe(readText(`golden/${name}.reports.txt`));
        const mem = Replay.fromBytes(readBytes(`recordings/${name}.ndjson.gz`));
        expect(reports(mem.trayReportsSync())).toBe(readText(`golden/${name}.reports.txt`));
        const each = mem.traysSync().flatMap((t) => (t.report() === null ? [] : [t.report() as TrayReport]));
        expect(reports(each)).toBe(readText(`golden/${name}.reports.txt`));
      });
    });
  }
});
