# Tutorials

Five short tutorials take you from simple mode, one report per tray, through advanced mode to drawing a frame by hand.
Every piece of code in them is a region of a program in [examples/](../../examples), and the tests run each program
against the fixture recordings and the SDK's fake unit, so the code runs as it is shown.

| Tutorial | What you build |
| --- | --- |
| [Start here](00-start-here.md) | simple mode: one report per tray (the stones removed, added and moved, when and where, and whether that is all of it), the same reports as data, the details behind a report that is not complete, and the reports of a unit, live |
| [High level](01-high-level.md) | advanced mode: what the hands did, as sentences and as data: activities, trays and the stones taken off them, the summary, a stone's path; replayed offline, then followed live |
| [Low level](02-low-level.md) | advanced mode: one call per API operation: health and speed, the model, a stone and the focus, frames and the model's maps, draw lists, stones and hands drawn by hand, a frame's image data, the streams |
| [Live cameras](03-live-cameras.md) | advanced mode: the shared session's sources, a plant camera selected, warmed up and followed, and its pictures |
| [TypeScript](04-typescript.md) | what is particular to this SDK: async iterables, Node, Deno, Bun and the browser, the three.js views, the fake unit as a `fetch`, errors |

## Before you start

- Node 18 or newer, Deno 2 or Bun 1, and the SDK. Until the package is on npm, build it from this repository and
  install the tarball into your project (`npm install github:eprojac/pdigger-factory-sdk-ts` does not work yet: the
  repository has no built `dist/`):

  ```sh
  git clone https://github.com/eprojac/pdigger-factory-sdk-ts
  cd pdigger-factory-sdk-ts && npm ci && npm run build && npm pack
  cd ../your-project && npm install ../pdigger-factory-sdk-ts/pdigger-factory-sdk-0.1.0.tgz
  ```

- To run the tutorials' programs as they are, work in the clone after `npm ci && npm run build`, with a Node that runs
  TypeScript files directly (22.18 and later, or 23.6 and later): `node examples/tutorial-reports.ts`.
- For the first two tutorials, nothing else: they replay recordings, offline, such as the fixture recordings in
  `fixtures/recordings/` or the published ones at https://factory.pdigger.com/developers/data/.
- For the live steps, a unit: set `PDIGGER_FACTORY_URL` to it (the examples ask http://factory-orin.local:8120 by
  default). Without one, run them against the SDK's fake unit, which serves `fixtures/recordings/$FAKE_RECORDING` with
  the recorded replies of `fixtures/api`:
  `FAKE_RECORDING=dry1-0296-0306-full node --import ./scripts/fake-preload.mjs examples/tutorial-low-level.ts 1510`
  (the default recording, dry1-0000-0130, has no raw packets). For a camera, use
  `FakeFactory.create({ recording, live: true })` as in the live-camera tutorial ([testing.md](../testing.md)).

The unit interprets one source at a time for everybody: a recording or a live camera, on one shared session. A
control (select, seek, play, pause, focus) changes what every viewer sees, so the tutorials send dry runs, which the
unit checks without applying them; only the live-camera tutorial really selects a camera.

The same tutorials, step for step, are in the other languages:
[Go](https://github.com/eprojac/pdigger-factory-sdk-go/tree/main/docs/tutorials),
[Python](https://github.com/eprojac/pdigger-factory-sdk-python/tree/main/docs/tutorials) and
[Rust](https://github.com/eprojac/pdigger-factory-sdk-rust/tree/main/docs/tutorials).
