# High level: what the hands did

The interpreter turns the unit's frames into what a person would say happened at the work area: events
(`1:19.2 Left hand lifts stone 155`), activities (a hand moving one stone, or a burst of pushes), the state of both
hands, the stones in view, and the trays that pass through. It is the same interpreter for a recording replayed
offline and for a unit followed live, and all four languages give the same sentences for the same frames.

This tutorial replays a recording first, so it needs no unit, and then follows one. Its code is
[examples/tutorial-high-level.ts](../../examples/tutorial-high-level.ts) and, for the live steps, the examples they
name.

## 1. Replay a recording: the activities

Install the SDK (see [the tutorials' start](README.md#before-you-start)) and take a recording: the fixture
`fixtures/recordings/dry1-0018-0153.ndjson.gz` is dry1 from 0:18 to 2:33, where a tray arrives with 42 stones, the
hands take some off and push the others into place. Any published recording works the same, as a path or a URL.

<!-- snippet: examples/tutorial-high-level.ts#activities -->
```ts
const replay = await Replay.open(source); // streamed, gzip or not: only the interpreter's state is in memory
for await (const activity of replay.activities()) {
  console.log(activity.describe()); // 1:19.2 Left hand takes stone 155 away (1.0 s)
}
```

The first activities of dry1-0018-0153:

```text
0:20.5 Both hands push stones 86, 90 and 94 (6 pushes in 0.6 s)
0:20.3 Right hand pushes stones 89, 90, 94, 95 and 109 (13 pushes in 1.6 s)
0:21.9 Left hand pushes stone 86 (1 push)
```

Run it yourself with `node examples/tutorial-high-level.ts fixtures/recordings/dry1-0018-0153.ndjson.gz`.

## 2. The same activities as data

A sentence is for people; your program reads the fields. An activity of kind `move` is one stone moved by one hand,
with where it went (`outcome`: placed, dropped, carried away, removed, or interrupted when the recording or the session
ended first); the other kind is `push`, a burst of pushes.

<!-- snippet: examples/tutorial-high-level.ts#moves -->
```ts
for await (const activity of replay.activities()) {
  if (activity.kind !== "move") continue; // a hand moving one stone; the other activities are bursts of pushes
  const took = activity.duration === null ? "still open" : `${activity.duration.toFixed(1)} s`;
  const at = clock(activity.start.t);
  console.log(`${at} stone ${activity.stoneId}: ${activity.hand} hand, ${activity.outcome}, ${took}`);
}
```

In dry1-0018-0153 that is nine moves: stone 155 carried away by the left hand at 1:19.2 (in 1.0 s), stone 106 carried
away by the right hand at 1:25.6, five placed (stone 102 twice) and two dropped.

## 3. Trays, and the stones taken off them

The world's stone ids belong to the engine's tracker, which renames stones and reuses ids. For trays the SDK keeps
ids of its own, one per stone and never reused, so that "this stone was removed" stays true over time. Its tray facts
say what happened to each tray and its stones:

<!-- snippet: examples/tutorial-high-level.ts#tray-facts -->
```ts
for await (const fact of replay.trayFacts()) {
  console.log(fact.describe()); // 0:22.5 tray 1 arrived: 42 stones
}
```

The first removals from dry1-0018-0153's tray:

```text
0:45.5 tray 1: stone 20261122T023847.0Z-1-117 was removed
0:45.5 tray 1: stone 20261122T023847.0Z-1-127 was removed
```

and its last fact, as it moves out: `2:24.0 tray 1 leaving: 44 stones (30 sure), 0 added, 6 removed, 18 unclear`.

A tray also has two points to jump to: when it had arrived and settled, and its last calm frame before it moved out.
`window()` gives both, and each tray stone says whether it was removed, and whether that is certain:

<!-- snippet: examples/tutorial-high-level.ts#trays -->
```ts
for (const tray of await replay.trays()) {
  const window = tray.window();
  if (window === null) continue; // a stop that never settled
  const [arrived, leaving] = window;
  const gone = tray.stones.filter((s) => s.status === "removed" && s.certain);
  console.log(`tray ${tray.n}: ${clock(arrived)} to ${clock(leaving)}, ${gone.length} stones removed for certain`);
}
```

For dry1-0018-0153: tray 1 from 0:22.5 to 2:24.0, with 6 stones removed for certain.

## 4. One pass, and its core

Each loop above is a pass of its own over the file. After a pass, `replay.core` is that pass's interpreter: ask it
for its summary, its state, or the path of any stone of the world.

<!-- snippet: examples/tutorial-high-level.ts#one-pass -->
```ts
for await (const update of replay.updates()) void update; // one pass: the events, activities and facts of each frame
const core = replay.core; // that pass's interpreter: its state, its summary, and every stone's path
if (core !== null) {
  console.log(core.summary().describe());
  const path = core.track(stone); // where the stone was, frame by frame (scene units)
  const [first, last] = [path[0], path.at(-1)];
  if (first && last) console.log(`stone ${stone}: ${path.length} points from ${clock(first.t)} to ${clock(last.t)}`);
}
```

The summary of dry1-0018-0153 begins:

```text
frames: 676 (with world 676, without 0, revisions 0)
media: 2:14.6, sessions 1, gaps 0
stones: last 42, max 49, confirmed 42
moves: 9 (placed 5, dropped 2, carried away 2, removed 0, interrupted 0, partial 0, carried 6), mean 1.4 s, 0.18 units
```

and stone 155's path has 5 points, from 1:15.6 to 1:19.8.

## 5. Follow a unit, live

The same interpreter follows the unit's shared session, whatever it shows: a recording it plays, or a live camera.
[examples/quickstart.ts](../../examples/quickstart.ts) prints every event as it happens:

<!-- snippet: examples/quickstart.ts#quickstart -->
```ts
import { FactoryClient } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
const state = await factory.session.state();
console.log(`following ${state.video}, session ${state.session}`);

for await (const event of factory.interpreter().events()) {
  console.log(event.describe()); // e.g. "21:17.8 Right hand lifts stone 2660"
}
```

The stream resumes by itself when the connection drops, holds a frame whose world came late until it is read back,
and gives every event its wall time from the session's clock. To follow the activities and then read the hands and
the summary, [examples/interpreter.ts](../../examples/interpreter.ts) does this:

<!-- snippet: examples/interpreter.ts#updates -->
```ts
const interpreter = factory.interpreter(); // world and cards layers; counts as a viewer; backfills late worlds
let frames = 0;
for await (const update of interpreter.updates()) {
  for (const activity of update.activities) {
    console.log(activity.describe());
    if (activity.kind === "move" && activity.distance !== null) {
      console.log(`  stone ${activity.stoneId} ${activity.outcome}, ${activity.distance} units from where it was`);
    }
  }
  if (++frames === 600) break; // 600 grid frames: two minutes of media
}
const { left, right } = interpreter.state.hands;
console.log(`hands now: left ${left.state} (${left.card}), right ${right.state} (${right.card})`);
console.log(interpreter.summary().describe());
interpreter.close();
```

and to wait for one event, with a timeout or a signal:

<!-- snippet: examples/interpreter.ts#wait -->
```ts
// the first right-hand lift, within two minutes (on the client's clock), as an event with its wall time
const lift = await factory.interpreter().waitFor((e) => e.type === "lift" && e.hand === "right", { timeout: 120_000 });
const at = lift.wall === null ? "no wall time" : new Date(lift.wall * 1000).toISOString(); // the unit's clock
console.log(`${lift.describe()} (stone ${lift.stoneId}, ${at})`);

// any of several types; a signal stops the wait (and the stream) early
const placed = await factory.interpreter().waitFor(["place", "drop"], { signal: AbortSignal.timeout(120_000) });
console.log(placed.describe());
factory.close();
```

## 6. Show a tray on the shared screen

Every viewer of the unit sees the same session. To show a tray there, seek to one of its points.
[examples/tray-points.ts](../../examples/tray-points.ts) asks the unit with dry runs, which it checks and does not
apply; leave out `dryRun: true` to really move the session for everybody.

<!-- snippet: examples/tray-points.ts#seek -->
```ts
const tray = trays.find((t) => t.n === show && t.window() !== null);
if (tray !== undefined) {
  const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
  for (const t of tray.window() ?? []) {
    // a dry run: the unit checks the seek and answers what it would show; nothing moves
    const would = await factory.session.seek(t, { video: tray.video ?? undefined, dryRun: true });
    console.log(`seek to ${clock(t)} would show ${would.video} from ${clock(would.anchor_media)}`);
  }
  factory.close();
}
```

## 7. Test your program without a unit

`FakeFactory` answers the whole API from a recording as a `fetch`, with no server and no real clock
([examples/testing.ts](../../examples/testing.ts)):

<!-- snippet: examples/testing.ts#testing -->
```ts
import { FakeFactory, InstantClock } from "pdigger-factory-sdk/testing";

const fake = await FakeFactory.create({ recording: "fixtures/recordings/dry1-0000-0130.ndjson.gz" });
const factory = fake.client({ clock: new InstantClock() });

const lift = await factory.interpreter().waitFor("lift");
console.log(lift.describe());

// fault injection: the next getWorld answers 503 once; the client retries after retry_ms
fake.failNext("getWorld", 1, { status: 503, body: { error: "busy", code: "world_unavailable", retry_ms: 250 } });
const world = await factory.api.getWorld();
console.log(
  `world at frame ${world.g} after ${fake.requests.filter((r) => r.operationId === "getWorld").length} requests`,
);
factory.close();
fake.close();
```

## Next

- [Low level](02-low-level.md): the operations under the interpreter, one call each.
- [Live cameras](03-live-cameras.md): select a plant camera and follow it.
- The reference: [interpreter.md](../interpreter.md) (every event, activity, tray fact and the summary),
  [replay.md](../replay.md) (paced and synchronous replays, the recording format) and [testing.md](../testing.md).
