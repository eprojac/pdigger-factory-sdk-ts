// Regenerates the viz screenshots in docs/img from the viz example (examples/browser) on a fixture recording, with a
// local headless Chrome (CHROME=/path/to/chrome to choose one). Only 127.0.0.1 is contacted.
//
//   npm run build && node scripts/screenshots.mjs
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "../examples/browser/serve.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const chrome =
  process.env.CHROME ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

/** The shots: recording, the frame the replay stops at, the 3-D camera preset. */
export const SHOTS = [
  { file: "viz-example.png", recording: "dry1-0296-0306-full", until: 1512, camera: "source" },
  { file: "viz-example-three.png", recording: "dry1-0296-0306-full", until: 1512, camera: "three" },
];

// the server runs in this process: Chrome must be run asynchronously, or the page could not load
const run = (args) => promisify(execFile)(chrome, args, { maxBuffer: 64 << 20 }).catch((err) => err);
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/examples/browser/`;
const profile = mkdtempSync(join(tmpdir(), "pdigger-factory-sdk-ts-chrome-"));
const common = [
  "--headless=new",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  `--user-data-dir=${profile}`,
  "--window-size=1600,440",
  "--virtual-time-budget=30000",
];
try {
  for (const s of SHOTS) {
    const url = `${base}?recording=/fixtures/recordings/${s.recording}.ndjson.gz&pace=none&until=${s.until}&camera=${s.camera}`;
    const dom = await run([...common, "--dump-dom", url]);
    const done = /data-done="([^"]*)"/.exec(dom.stdout)?.[1];
    const status = /<span id="status">([^<]*)<\/span>/.exec(dom.stdout)?.[1];
    if (!done || done === "error") throw new Error(`${s.file}: the page did not finish (${status ?? dom.message})`);
    const out = join(root, "docs", "img", s.file);
    const shot = await run([...common, `--screenshot=${out}`, url]);
    if (shot instanceof Error) throw new Error(`${s.file}: chrome failed: ${shot.message}`);
    console.log(`${s.file}: ${status} (${done} updates)`);
  }
} finally {
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
