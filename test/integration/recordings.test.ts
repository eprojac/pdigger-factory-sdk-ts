/**
 * Opt-in: Replay over the complete published recordings in a folder, compared with their golden summaries.
 * Download any of https://factory.pdigger.com/developers/data/ (`<video>.world.ndjson.gz`, with `<video>.summary.json`,
 * `<video>.summary.txt` and `recordings.json` if you like) into a folder, then
 * PDIGGER_FACTORY_RECORDINGS=<folder> npm run test:integration. Every `<video>.world.ndjson.gz` there is replayed.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Replay } from "pdigger-factory-sdk";

const dir = process.env.PDIGGER_FACTORY_RECORDINGS?.trim() || undefined;
const SUFFIX = ".world.ndjson.gz";
const VIDEOS =
  dir && existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(SUFFIX))
        .map((f) => f.slice(0, -SUFFIX.length))
        .sort()
    : [];

interface Listing {
  recordings: { video: string; files: Record<string, { sha256: string }> }[];
}

describe.skipIf(!dir)(`the complete recordings in ${dir ?? "(PDIGGER_FACTORY_RECORDINGS not set)"}`, () => {
  const folder = dir ?? "";
  const listing = existsSync(join(folder, "recordings.json"))
    ? (JSON.parse(readFileSync(join(folder, "recordings.json"), "utf8")) as Listing)
    : null;

  it("finds recordings to replay", () => {
    expect(VIDEOS, `no <video>${SUFFIX} in ${folder}`).not.toEqual([]);
  });

  it.each(VIDEOS)("%s: the summary equals the golden one", async (video) => {
    const file = join(folder, `${video}${SUFFIX}`);
    const sha = listing?.recordings.find((r) => r.video === video)?.files.world?.sha256;
    if (sha) expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(sha);
    const golden = (ext: string): string => {
      const beside = join(folder, `${video}.summary.${ext}`);
      return readFileSync(
        existsSync(beside) ? beside : join("fixtures", "golden", "complete", `${video}.summary.${ext}`),
        "utf8",
      );
    };
    const replay = await Replay.open(file);
    const summary = await replay.summary();
    expect(summary.toJSON()).toEqual(JSON.parse(golden("json")));
    expect(summary.describe()).toBe(golden("txt"));
  });
});
