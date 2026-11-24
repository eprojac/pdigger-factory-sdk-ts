# The Interpreter

Use the interpreter to follow a hand movement, trace a stone or explain a tray report. Events describe what the unit
saw in a frame. Activities group events into moves and pushes. A recording produces the same results as the live
frame sequence. [Interpreter rules](../spec/SDK-DESIGN.md#4-interpreter-rules-golden-tested).

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

## Options

| Option | Default | |
|---|---|---|
| `layers` | `["world", "cards"]` | add `overlay` or `scene` if you also draw |
| `observe` | the client's (`false`) | `true`: not a viewer (`observe=1`); an idle worker then interprets nothing unless someone else watches |
| `backfill` | `true` | hold frames whose world is late and read it back, so the core sees every frame in order |
| `transport` | `"sse"` | `"poll"`: the long-poll, where streamed responses do not get through |
| `after`, `lastEventId` | the newest frame | start after a cursor, or resume from an event id |
| `highWaterMark` | 256 | updates buffered per consumer before the stream waits for the slowest one |
| `maxReconnects` | no limit | consecutive failed reconnects before the iterations fail |
| `resume` | `true` | `false`: the iterations end when the server ends the stream |
| `idleTimeoutMs` | the client's (30 s) | close and resume a connection that sent something and then nothing this long; 0: never |
| `onDecodeError` | none | called with the `decode` error of a stream event that does not decode; the event is skipped and the interpreter goes on |
| `core` | | options of the `InterpreterCore`: `trackPoints` (512), `trackStones` (4096), `traysKept` (256 trays that have left; 0 keeps every one) |

One Interpreter is one stream. `updates()`, `events()`, `activities()`, `trayFacts()` and `waitFor()` are consumers of
it; a consumer joins at its first `next()` (a `for await` does that at once, so an iterator you made but never read
holds nothing open), the stream opens with the first and closes when the last leaves, or with `interpreter.close()` (or
`using`).
The client holds an Interpreter only while its stream is open: `factory.close()` stops those, and one whose consumers
have left is garbage like any object. `interpreter.state`, `interpreter.summary()`, `interpreter.worker` and
`interpreter.sessionState` are there between updates.

Back-pressure: the consumers of one Interpreter share its stream, so the stream goes at the pace of the slowest. Each
may have `highWaterMark` updates (256) waiting; when one has more, the stream stops reading until it catches up, for
every consumer. Leave a loop you no longer read (`break`, `return()`, its `signal`), and give consumers that go at
their own pace an Interpreter each (each is a viewer stream of its own).

Loops can follow one another: `waitFor`, then `events()`, `activities()`, `trayFacts()` or `updates()`, and so on. A
later loop goes on where the last one stopped and misses nothing in between: it first yields the rest of the frame the
last loop stopped in (the events, activities and tray facts that loop did not yield; after `waitFor`, the events after
the match and all of that frame's activities and tray facts), then the frames after it (the stream resumes after the
last frame fed, while the unit still holds it).

After every connect and reconnect the Interpreter reads the shared state (`GET /session`): the unit sends a `clock`
event only when the state changes, none on connect, and without the state events have no wall time. The state goes
to `interpreter.sessionState` and to the client's `factory.session.lastState`.

A stone's path: `interpreter.track(id)` is the one this interpreter saw (from its frames, oldest first, the newest
`core.trackPoints`), without a request; `await interpreter.serverTrack(id)` asks the unit for its own since the session
began (`getStone`: the newest 512 points, 2-D and 3-D).

## Updates

Each frame gives an `Update`: `frame`, `events` (new events of this frame, in world order), `activities` (completed by
this frame), `trayFacts` (the [tray facts](#trays-and-tray-stones) it made; after a session change, first those of the
old session's tray leaving), `state` (after this frame), and `isRevision`, `isDuplicate`, `isBackfill`. A replay ends
with a final update (`isFinal`, `frame` null) carrying what `end()` closed, and so does an Interpreter whose stream
ends (with `resume: false`, when the server ends it): open moves come as `interrupted`, open push bursts closed, and the
open tray leaves (its facts are the update's `trayFacts`). An iteration you leave yourself, or end with `close()`, gets
no final update, and neither does one whose stream fails (it throws): call `interpreter.end()` for what is still open, as that final update, or `interpreter.finish()` for
its activities alone (the open tray's facts then go to `interpreter.trays()`). `events()`, `activities()` and
`trayFacts()` stop at once when their `signal` aborts, also in the middle of an update.

`state` is an `InterpreterState`: `session`, `video`, `g`, `t`, `wall`, `stones` (id to the stone's newest view: mode,
family, shape, side, outline, solid, detected, uncertain, source, placed), `hands.left` and `hands.right` (`state` free,
touch, grasp, hinge or carry; the `stone` held; the hand card's title), `board`, `stats`, `openMoves`, `tray` (the open
[tray](#trays-and-tray-stones) with its tray stones, null between trays), and the counters.

## Events

An event is what the world says happened in a frame: `type` (the wire name), `g`, `t`, `wall`, `session`, `video`,
`stoneId`, `hand` (left, right, both or null), `why`, `into`, `source`, `stone` (its view in this frame), `trayStone`,
and `describe()`, which is `"{clock} {sentence}"`. `stoneId` is the world's id, which the engine's tracker can rename
and reuse; `trayStone` is the SDK's own id of the stone that world id stood for on the open tray before this frame,
also for an event of a revision (null when it stood for none), the one to keep ([trays](#trays-and-tray-stones)):

| type | sentence |
|---|---|
| `new` | `stone 72 appears`, or `stone 72 appears (found in the image)` |
| `confirm` | `stone 72 is confirmed` |
| `freeze` | `stone 72 gets its final shape` |
| `push` | `Left hand pushes stone 72`; `stone 72 is pushed along its row` (why `course`); `stone 72 is reseated` (why `reseat`) |
| `lift`, `hinge`, `carry` | `Right hand lifts stone 72`, `... tips stone 72 up on its edge`, `... carries stone 72` |
| `place`, `drop`, `gone` | `... places stone 72`, `... drops stone 72`, `... takes stone 72 out of view` |
| `delete` | `stone 72 is removed (no longer seen)`, with the reason in words |
| `split` | `stone 72 splits into 80 and 81`, `stone 72 is trimmed` |
| anything else | `stone 72: <type>` |

`Both hands` takes the plural (`Both hands push stone 90`), a missing side is `A hand`, a missing id prints `?`. The
clock is `M:SS.s` below an hour and `H:MM:SS.s` from one.

## Activities

Events joined into human-scale actions (lines from the golden files of the fixture recordings), both with `kind`, `hand`, `start` and `end` (`g`, `t`, `wall`), `duration`,
`session`, `video` and `describe()`.

**Move** (`kind: "move"`): one stone taken and put somewhere. It opens on a `lift` or `hinge` and closes on `place`
(outcome `placed`), `drop` (`dropped`), `gone` (`carried_away`) or `delete` (`removed`); a session change or the end
closes it as `interrupted`. It records `from` and `to` (scene positions), `distance` (in x, y, 3 decimals), `carried`,
`tipped`, and `partial` (a stream joined in the middle of the move).

```text
21:17.8 Right hand moves stone 2660 0.84 units in 4.0 s
0:36.3 Right hand tips stone 117 and sets it down (0.2 s)
2:01.3 Left hand drops stone 250 after 1.6 s
1:20.2 Left hand takes stone 155 away (0.0 s) (joined mid-move)
1:19.2 Left hand is still holding stone 155 (0.6 s so far)
```

**Push burst** (`kind: "push"`): a hand pushing stones about. Pushes of one side less than 1.0 s apart join one burst;
`stones` are the ids pushed (ascending), `pushes` the count.

```text
0:20.5 Both hands push stones 86, 90 and 94 (6 pushes in 0.6 s)
21:16.2 Right hand pushes stones 2640, 2641, 2643, 2649 and 2653 (10 pushes in 1.4 s)
```

Within a frame, events come first in world order, then the activities that frame closed, sorted by end, start, moves
before pushes, stone and hand. Activities closed before a frame's events (stale bursts, a session change) come before
them.

## Waiting for an event

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

`waitFor` takes a type, several types, or a predicate. With `timeout` (milliseconds on the client's clock) it rejects
with a `TimeoutError`; when the stream ends first, with a `stream_closed` error; when its `signal` aborts, with the
signal's reason.

## Trays and tray stones

The tracker assigns a **world ID** to a detection. When a hand pushes a row of similar stones, the tracker can
assign a new ID to a familiar stone or keep an ID at a position now occupied by a different stone. Use the **tray
stone ID** to follow one physical stone across frames. The SDK never reuses it.

For example, `20261122T023847.0Z-1-117` identifies a stone first seen at 02:38:47 UTC on tray 1 under world ID 117.
Without a wall clock the prefix is `s{session}t{media time}`. If two stones receive the same world ID on the same
tray within the same tenth of a second, the later IDs end in `-2`, `-3` and so on.

The SDK tracks two kinds of uncertainty. **Sure** describes a stone’s identity. **Certain** describes a fact, such
as a removal. The SDK keeps every fact it has emitted. When the departure speckle check resolves an earlier `unsure`
fact, it adds an `identified` fact to the history.

### When the SDK records a change

- **Arrival and departure.** A tray must stop for at least two seconds. Arrival is the first calm frame with all
  stones confirmed and no new stone for five frames. A calm frame requires both hands to be free for three
  consecutive frames, with no hand event or stone creation, deletion or split. Departure uses the last calm frame
  unless a hand worked after it, in which case it uses the last frame.
- **Identity.** A push, an overlap, a missing detection or a similar stone near a held stone can put an identity in
  doubt. A stone missing at two calm moments may regain its identity if it reappears in place and nothing could have
  swapped it. The SDK also checks tracking gaps, hand activity, nearby stones and appearance. A stone with an
  appearance history follows the separate matching rules.
- **Removal and addition.** A certain removal requires recent hand contact. For a stone that disappears on the tray,
  the SDK also checks that a calm frame shows its position empty and that no tracked stone could be the missing
  stone. An addition is certain when a new stone stays in place across two calm moments and no similar-sized stone
  is missing or uncertain.
- **Matching at departure.** The SDK links a missing stone to a nearby detection when the two match by speckle or
  appearance, or when no hand could have swapped them. Otherwise it records the possible removal and addition as
  unclear.

The [tray rules](../spec/SDK-DESIGN.md#461-the-tray-rules) give the exact conditions, distance limits and
exceptions.

Some of the facts of `dry1-0018-0153`, a busy tray of dry1, at 0:38.7 and 0:45.5 (`interpreter.trayFacts()`,
`fact.describe()`):

```text
0:38.7 tray 1: stone 20261122T023847.0Z-1-105 is not sure any more (a stone next to it was pushed)
0:38.7 tray 1: stone 20261122T023847.0Z-1-126 is not sure any more (a stone next to it was pushed)
0:45.5 tray 1: stone 20261122T023847.0Z-1-97 is not sure any more (it was pushed)
0:45.5 tray 1: stone 20261122T023847.0Z-1-117 was removed
0:45.5 tray 1: stone 20261122T023847.0Z-1-127 was removed
```

The departure fact counts confirmed set-downs under `added`. The five unclear removals and the thirteen possible
additions in this report make its 18 `unclear`; the speckle check as the tray left settled all but one of the stones the
worker pushed. The final two facts show the last possible addition and the departing count.

```text
2:24.0 tray 1: stone 20261122T024126.9Z-1-284 not recognised (unclear)
2:24.0 tray 1 leaving: 44 stones (30 sure), 0 added, 6 removed, 18 unclear
```

| Fact (`kind`) | Sentence |
|---|---|
| `arrived` | `{clock} tray {n} arrived: {stones} stones` |
| `unsure` | `{clock} tray {n}: stone {id} is not sure any more ({why})` |
| `removed`, certain | `{clock} tray {n}: stone {id} was removed`, with ` (carried away)` when a hand took it out of view |
| `removed`, unclear | `{clock} tray {n}: stone {id} not found (unclear)` |
| `added`, certain | `{clock} tray {n}: stone {id} was set down` |
| `added`, unclear | `{clock} tray {n}: stone {id} not recognised (unclear)` |
| `identified` | `{clock} tray {n}: stone {id} confirmed by its speckle on world stone {world id} ({score})`; `recognised` or `found again` in place of `confirmed` when the stone was on another world stone or lost; `recognised by its look` (or `found again by its look`) for a look's link |
| `leaving` | `{clock} tray {n} leaving: {stones} stones ({sure} sure), {added} added, {removed} removed, {unclear} unclear` |

A `TrayFact` has `kind`, `tray`, `session`, `video`, `stone` (the tray stone's id, null for arrived and leaving),
`worldId` (the world id it stands for now, null when none), `certain` (for removed and added), `why`, `g`, `t`, `wall`,
the counts of arrived and leaving (`stones`, `sure`, `added`, `removed`, `unclear`), `describe()`, `clock` and
`toJSON()` (snake case: `world_id`). `interpreter.trays()` lists the trays so far (those that have left, the newest
`traysKept` = 256, and the open one) and `replay.trays()` every tray of a recording. A `Tray` has `session`, `video`,
`n`, the points `arrived` and `leaving` (`g`, `t` and `wall`; null until it has arrived, and while it is on), `stones`
(`TrayStone`: `id`, `worldId`, `status` `on`, `lost` or `removed`, `sure`, `added`, `certain`, `born`, `place`, `size`),
its `facts`, `window()` (`[arrived.t, leaving.t]`, null until it has left) and `stone(id)`. The two points are the ones
to jump between: on the shared session, `factory.session.seek(point.t, { video: tray.video })` shows one
([replay](replay.md#trays)).

### Report fields

Call `tray.report()` after a tray leaves. Use `interpreter.trayReports()` for a live stream of reports or
`replay.trayReports()` for a recording. For an in-memory replay, `trayReportsSync()` is also available.

| Fields | Meaning |
| --- | --- |
| `session`, `video`, `tray` | Source session, video and tray number. |
| `arrived`, `left`, `stones` | Arrival and departure points, and the number of stones at arrival. |
| `removed`, `added`, `moved` | Changes in each category. Each carries a stone ID, time, certainty, reason code, position, size, distance and confidence as applicable. |
| `unclear`, `unsure`, `complete` | Counts of unclear changes and other retained stones with uncertain identities. A report is complete when both counts are zero. |

A move requires a known stone identity, evidence that the stone was touched, and a detection at departure. After
compensating for the motion of the tray itself, the displacement must exceed 0.75 times the stone’s shorter side.
Use `JSON.stringify(report)` for the report data.

`tray.open` is the open account of the tray's leaving (`TrayOpen`, SDK-DESIGN 4.6.8: for each stone left open, the
readings the evidence still allows; null until the tray has left), and `TrayFact.code` gives each fact's reason as a
code (`carried_away`, `pushed`, `not_recognised`, ...). A tray stone also has `firstPlace`, `leftPlace` and `touched`,
which the report reads, and `question` while it is held in question; with the stones' looks, a fact may be
`identified` and a tray stone carries `looks`, `byLook`, `lookLost` and `open`; with the unit's speckle check,
`speckle`, `bySpeckle` and `evidence` (below).

### Confidence

Confidence estimates how often a reported change of this kind is correct. The maintainers checked 150 trays across
four recordings against the video. Each table entry uses `(right + 1) / (checked + 2)` for that group of changes.
[Calibration method](../spec/SDK-DESIGN.md#4613-the-leavings-speckle-answer-and-the-confidence-of-a-change).

For a removal, the evidence says whether the surface pattern of the stone was found at **departure**. For an
addition, it says whether that stone was already visible at **arrival**.

| Change | Certain | not found | undecided | found |
|---|---|---|---|---|
| removed | yes | 0.98 | 0.50 | 0.25 |
| removed | no | 0.71 | 0.58 | 0.09 |
| added | yes or no | 0.96 | 0.52 | 0.02 |

A move is `MOVED_CONFIDENCE`, 0.87. The numbers are constants (`CONFIDENCE`, by kind, `certain` or `unclear`, and
evidence), the same in every language, so a client keeps the changes at or above a threshold of its own: at 0.90,
dry1's tray 2 (the fixture's tray 1) keeps its six certain removals and nine of its thirteen additions, all fifteen
right by the camera check.

### The unit's speckle check

The unit compares the grain on each stone’s surface at arrival with its appearance in a later image. Since build
`claude-20261123-speckle3` it sends each GPU comparison once in `world.speckle`. The published recordings include
comparisons computed after capture. [Camera measurements](BEHAVIOUR-20.20.md#8-the-speckle-answers).

The SDK uses the last calm frame to reconcile identities at departure. Clean matches can confirm a stone in place or
recover it under a new world ID. If a hand worked after the last calm frame, the departure comparison is unavailable
and the report uses undecided evidence.

Reading the answers yourself is advanced mode: to look into an unclear change, to check a tray by hand, or for rules of
your own. The interpreter reads each answer (SDK-DESIGN 4.6.12) as a tray's (`TraySpeckle`): `update.speckle` holds the
answers a frame gave, `interpreter.speckle()` the answers so far (the newest 1024) and a replay's `updates()` every
answer of a recording, and while the tray is on, each of its stones in the answer takes its part as `speckle`
(`StoneSpeckle`). As the tray leaves, `TrayStone.bySpeckle` says the leaving's answer paired the stone, and
`TrayStone.evidence` what it found of it at the other moment (`found`, `not_found` or `undecided`: a look-alike, or a
stone it did not check). An answer at another moment, or a score below the clean bar, is for you to weigh: the tray
rules use only the leaving's clean finds. The last answer for the first tray of the fixture recording `dry1-0018-0153`
(tray 2 of the published dry1), as `describeSpeckleTxt()` writes it, begins:

```text
732 2:26.0 tray 1: speckle of 0:22.5 and 2:24.2: 42 stones, 30 clean, 26 paired, 24 the same
  20261122T023847.0Z-1-84 arrival 0.632 0.112 clean found 20261122T023847.0Z-1-84 pair 20261122T023847.0Z-1-84
```

and, further down:

```text
  20261122T023847.0Z-1-104 arrival 0.481 0.090 clean found 20261122T023847.0Z-1-104 pair 20261122T023847.0Z-1-104
  20261122T023847.0Z-1-105 arrival 0.102 0.079 found world 193
  20261122T023847.0Z-1-106 arrival 0.706 0.102 clean found world 266
  20261122T023847.0Z-1-107 arrival 0.720 0.115 clean found 20261122T023847.0Z-1-106 pair 20261122T023847.0Z-1-106
```

Stones 84, in question since 2:18.8, and 104, pushed at 2:09.6, are the same stones at the leaving, so they stay sure;
105, removed at 1:05.4, is found nowhere clean; 107, which the world had lost, is found and paired on world stone 191,
where the SDK had linked tray stone 106, and 106 on world stone 266, which no tray stone stood for. As the tray leaves,
the SDK links them so: 107 found again on 191, 106 recognised on 266 (a camera check of this tray: 39 of its stones
right, none wrong). A `StoneSpeckle` has `stone`, `side` (`"arrival"`: the stone as it was at the arrival, checked at
the later moment; `"later"`: the other way), `score` and `second` (null: not checked), `clean` (a score of at least
0.300 and at least twice the second), `found` (the tray stone at the other moment that its best place lies on, null when
none; `foundWorld` the world stone), `pair` (the tray stone the answer pairs it with, or null) and `same` (paired with
itself). A `TraySpeckle` has `tray`, `session`, `video`, `g`, `t` and `wall` (the frame it came in), `unitTray` (the
answer's own tray number, the unit's count), `ref` and `at` (the two moments: `g` and `t`), `device`, `gpuMs`, `wallMs`,
`stones`, `stone(id)`, `describe()` and `toJSON()`.

### Reading the dry1 report

The fixture `dry1-0018-0153` contains tray 2 of the full dry1 recording. The excerpt numbers it tray 1. A worker
straightened the rows and several stones briefly lost their tracker IDs. The SDK counted 42 stones at arrival and 44
at departure, matching the video count at departure.

| Change | What the report recorded | What the maintainers found in the video |
| --- | --- | --- |
| Removed | Six certain and five unclear | All six certain removals were correct. Of the five unclear removals, 87 and 129 left. Stones 121, 128 and 130 stayed. |
| Added | Thirteen unclear | Ten were set down and three (151, 246 and 249) arrived on the tray. At a 0.90 threshold, nine additions and six removals remain. All fifteen were correct. The filter also drops a genuine addition (278). |
| Moved | Eight | The SDK measured displacements of 0.33 to 0.43 scene units after accounting for the tray’s own movement. Each move has a confidence of 0.87. |

The unit’s departure comparison confirmed eight uncertain identities, found four missing stones and matched two to
different world IDs. Stone 98 remained uncertain. In the report, `18 unclear` counts changes. The separate
`1 not sure` counts that remaining identity.

A removal gives the last observed position. An addition or move gives the departure position when observed. For a
stone the world model retained without a detection at departure, the report can use its position in that model.
Stone 281 is an example. The worker set it down about six seconds before departure.

### Limits of the camera evidence

A complete report accounts for the stones visible to the model. If the model detects a stone in an empty slot at
arrival, a later occupant can inherit that ID. If the model loses sight of a stone permanently, the SDK can report a
removal even though the stone stayed. In a separate video check, three of 52 certain removals across the four
recordings were stones a hand had moved on the tray.

At departure the SDK excludes an unseen stone that is held, or whose box overlaps a free stone’s box by at least 30%
of its own area. On a busy tray, similar stones can also remain unresolved if hands worked after the final calm
frame. For the evidence behind any individual change, inspect its tray facts and the departure comparison.

## Summary

`interpreter.summary()` (and `replay.summary()`) is a `Summary` with `describe()` and `toJSON()`. The JSON has exactly
the keys of the contract (frames, frames with and without a world, revisions, sessions, first and last `g` and `t`,
media seconds, gaps, event counts by type, moves by outcome with mean duration and distance, push bursts by hand,
stones, trays, and seconds per hand state), with numbers rounded to 3 decimals. The text, for the fixture recording
`dry1-0000-0130` (the first 130 s of dry1):

```text
frames: 632 (with world 632, without 0, revisions 0)
media: 2:09.6, sessions 1, gaps 1
stones: last 40, max 49, confirmed 40
moves: 9 (placed 5, dropped 2, carried away 2, removed 0, interrupted 0, partial 0, carried 6), mean 1.4 s, 0.18 units
push bursts: 51 (left 25, right 16, both 10), pushes 456
events: new 276, confirm 119, freeze 99, push 533, lift 9, hinge 4, carry 6, place 5, drop 2, gone 2, delete 76, split 3, other 0
trays: 2 (arrived 2), stones at arrival 83, added 0 (+14 unclear), removed 6 (+9 unclear), not sure 37
left hand: free 0:54.0, touch 0:52.4, grasp 0:17.2, hinge 0:00.4, carry 0:02.4
right hand: free 1:08.0, touch 0:09.4, grasp 0:38.8, hinge 0:00.6, carry 0:09.6
```

## Without I/O

`InterpreterCore` is the state machine itself: `feed(frame)` returns the `Update`, `gap()` tells it that the stream
dropped frames (a `gap` or `reset` event), `end()` closes what is open (as the final update; `finish()` returns its
activities), `summary()` counts and `trays()` gives the trays. The client's Interpreter and `Replay` both feed one; you
can feed frames from anywhere.
