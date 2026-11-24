import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The fixtures directory of this repository (a string path: DOM test environments replace the global URL). */
export const FIXTURES = `${join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures")}/`;

export const fixture = (rel: string): string => `${FIXTURES}${rel}`;

/** Every recording name in fixtures/recordings (without .ndjson.gz). */
export function recordingNames(): string[] {
  return readdirSync(fixture("recordings"))
    .filter((f) => f.endsWith(".ndjson.gz"))
    .map((f) => f.slice(0, -".ndjson.gz".length))
    .sort();
}

export const recordingPath = (name: string): string => fixture(`recordings/${name}.ndjson.gz`);

export function readText(rel: string): string {
  return readFileSync(fixture(rel), "utf8");
}

export function readJson<T = unknown>(rel: string): T {
  return JSON.parse(readText(rel)) as T;
}

export function readBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fixture(rel)));
}
