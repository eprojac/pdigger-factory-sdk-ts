# Tutorials

Start with a tray report. The later tutorials show how to read the events and frames behind it.

| Tutorial | What you’ll do |
| --- | --- |
| [Read a tray report](00-start-here.md) | Read the changes, export a row and investigate uncertainty. |
| [Follow the interpreter](01-high-level.md) | Follow hand movements, get tray facts and trace a stone. |
| [Read individual frames](02-low-level.md) | Inspect model maps, draw stones and hands, and read a frame image. |
| [Watch a live camera](03-live-cameras.md) | Select a camera, wait for warm-up and read its pictures. |
| [Use the TypeScript SDK](04-typescript.md) | Cancel reads with AbortSignal and use the optional three.js views. |

## Before you start

Follow the [installation steps](../../README.md#install) to get the SDK and its example recordings. Run the commands
below from the clone after `npm ci` and `npm run build`.

The replay steps use the bundled files in `fixtures/recordings/`. You can also
[download longer recordings](https://factory.pdigger.com/developers/data/).

For the live steps, set `PDIGGER_FACTORY_URL` to the unit’s base URL. To run the low-level example on a fixture, use
`FAKE_RECORDING=dry1-0296-0306-full node --import ./scripts/fake-preload.mjs examples/tutorial-low-level.ts 1510`.
The [testing guide](../testing.md) also shows how to simulate a camera.

A unit has one shared session. Selecting a camera, seeking or changing playback affects everyone watching. The
live-camera tutorial selects a real source. The other control examples use dry runs.

The same tutorials are available in
[Python](https://github.com/eprojac/pdigger-factory-sdk-python/tree/main/docs/tutorials) ·
[Go](https://github.com/eprojac/pdigger-factory-sdk-go/tree/main/docs/tutorials) ·
[Rust](https://github.com/eprojac/pdigger-factory-sdk-rust/tree/main/docs/tutorials).
