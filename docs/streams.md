# Streams

Use a frame stream for a camera overlay, a feed of scene geometry or your own frame-by-frame analysis. Choose
server-sent events for a continuous connection, long-poll for individual HTTP requests, or raw packets for model
outputs. Read `factory.streams` with `for await`. [Stream rules](../spec/SDK-DESIGN.md#23-mid-level-streams).

## Frames

`factory.streams.frames(options)` is an async iterable of `StreamItem`s:

| `kind` | Fields | When |
|---|---|---|
| `frame` | `frame`, `id` (`<boot>-<cursor>`), `isRevision`, `isBackfill` | a frame of the shared session |
| `clock` | `state`, `serverNow` | the shared state changed (select, seek, play, pause, focus, auto-rate) |
| `worker` | `worker` | the interpreter worker's status changed (running, idle "nobody is watching", ...) |
| `gap` | `count` | the server skipped items for a slow consumer |
| `reset` | `boot`, `cursor` | the unit restarted; the stream goes on in the new boot (a reconnect resumes from `<boot>-<cursor>`) |

<!-- snippet: examples/streams.ts#frames -->
```ts
let frames = 0;
for await (const item of factory.streams.frames({ layers: ["world"], backfill: true })) {
  if (item.kind === "clock")
    console.log(`clock: ${item.state.video} session ${item.state.session}, rate ${item.state.rate}`);
  else if (item.kind === "worker") console.log(`worker: ${item.worker.state}`);
  else if (item.kind === "gap") console.log(`gap: ${item.count} items skipped`);
  else if (item.kind === "reset") console.log(`reset: the unit restarted (boot ${item.boot})`);
  else {
    const { g, world } = item.frame;
    const tag = item.isRevision ? " (revised)" : item.isBackfill ? " (late world read back)" : "";
    console.log(`frame ${g} [${item.id}]: ${world?.events.length ?? 0} events${tag}`);
    if (++frames === 3) break; // leaving the loop closes the connection
  }
}
```

Options: `layers` (default the API's `overlay, scene, cards, world`), `after` (a cursor), `lastEventId`, `observe`
(default the client's), `precision` (`rounded` or `full`), `resume` (default true), `backfill` (default false here,
true in the Interpreter), `limit` and `maxS` (per connection), `maxReconnects` (default no limit), `clockOnConnect`
(default false here, true in the Interpreter), `idleTimeoutMs` (default the client's, 30 s), `onDecodeError` (rule 8),
`signal`.

The rules:

1. **One endless stream.** When the server ends a connection (`limit`, `max_s`, a restart) or it drops, the SDK
   reconnects with `Last-Event-ID` set to the last event id, so nothing is lost or repeated. It counts `limit` frames
   and times `maxS` (on the client's clock) itself and closes the connection when either is reached: the 20.20 unit
   sends nothing more but closes a finished stream only about 10 s later. After a `reset` the next reconnect resumes
   from the new boot's cursor.
2. **Reconnects.** A connection that ended after delivering events reconnects at once; a failure (connection error,
   429, 502, 503, 504) waits the server's `retry_ms`, else the backoff, and counts towards `maxReconnects`. Errors that
   retrying cannot cure (other 4xx) are thrown. The first connection uses the client's retries.
3. **Revisions.** A frame whose `world.rev` is higher than one already delivered for the same `(session, g)` comes
   with `isRevision: true`; one with the same or a lower `rev` is a duplicate and is dropped.
4. **Backfill.** With `backfill: true`, a frame released with `missing: ["world"]` is held, with every frame after it,
   and its missing layers are read with `GET /frames/{g}` 1.5, 2.5 and 3.5 s after it arrived (until they come; each
   read one request of at most 1 s, without retries, so a late layer holds the frames behind it about 4.5 s at the
   most), then the held frames are released in cursor order; the completed frame has `isBackfill: true`. A frame that
   cannot be completed (not retained, session gone, tries used up) is released with the layers that did come merged in
   (`isBackfill: true` when one did; the others stay in `missing`). Side items are never held.
5. **Viewers.** A stream counts as a viewer unless `observe` is true (default the client's, false).
6. **The state on connect.** The unit sends a `clock` event when the shared state changes, none on connect. With
   `clockOnConnect: true` the SDK reads `GET /session` after every connect and reconnect and passes it on first, as a
   `clock` item. Every `clock` item also updates the client's `factory.session.lastState`.
7. **A silent connection.** A quiet unit is normal, so a connection that has sent nothing stays open. Once it has sent
   something, a whole `idleTimeoutMs` without a byte (a comment or part of a large frame counts; checked once per
   period, so one to two periods after the last byte) closes it, and it is resumed at once with `Last-Event-ID`: a
   half-open TCP connection would otherwise wait for ever. `0` turns this off.
8. **Events that do not decode.** An event whose data is not JSON, or not the shape of its type (a field that
   SDK-DESIGN.md 2.3 rule 9 lists for it missing, null or of the wrong type, the same check in every SDK; further
   inside, TypeScript takes the data as it is), is skipped and the stream goes on (its id still counts for resuming,
   and `interpreter.waitFor()` waits on past it). `onDecodeError` (also an Interpreter option) is called with its
   `decode` error; without it the event is skipped silently. `fixtures/damaged` holds an event of each kind;
   `test/unit/damaged.test.ts` streams them. A line or event over 64 MiB, or a reply body that does
   not decode, ends the stream with `decode`.

Leaving the loop closes the connection; so does aborting `signal`.

## Long-poll

The same frames without a streamed response: `factory.streams.poll(options)` loops `pollFrames`, continuing from each
reply's `cursor` and `state.revision`, and yields the same items (frames have `id` null; clock and worker items when
they change). It identifies a viewer with a `cid` (random, unless you give one) unless `observe` is true.

<!-- snippet: examples/streams.ts#poll -->
```ts
// the same frames by long-poll, for places where streaming responses do not get through
let polled = 0;
for await (const item of factory.streams.poll({ layers: ["world"], limit: 4 })) {
  if (item.kind !== "frame") continue;
  console.log(`polled frame ${item.frame.g}, cursor ${item.frame.cursor}`);
  if (++polled === 3) break;
}
```

## Raw packets

`factory.streams.rawPackets(options)` streams `raw/stream`: the model's `sip1` packets before the Stable sim, over SSE
or NDJSON (`format`), with the same resume rules. Items are `packet` (with `packet` and `id`) and the side items. A
packet is dropped only when it repeats one of the same boot (the same cursor or a lower one). A restarted unit numbers
its cursors from the start again: after the `reset` item the new boot's packets follow, whatever their cursors.

Over NDJSON a reconnect asks for `after` the newest packet's cursor, as the stream has no event ids, and the unit sends
no `reset` there. A restart is then seen only when the unit answers with lower cursors (they are passed on, and the
next reconnect follows them); a unit that waits for its new cursors to pass the old one would keep the stream silent
that long. Use SSE (the default) where a restart must be noticed.

<!-- snippet: examples/streams.ts#raw -->
```ts
// raw packets (sip1): the model's own output before the Stable sim, for your own post-processing
for await (const item of factory.streams.rawPackets({ format: "ndjson" })) {
  if (item.kind !== "packet") continue;
  console.log(`packet of frame ${item.packet.g}: ${item.packet.stones.items?.length ?? 0} stone detections`);
  break;
}
```

## Lower still

`factory.api.streamFrames()` and `factory.api.rawStream()` return one connection as an `EventStream` of parsed SSE (or
NDJSON) events, without resume; `SseParser`, `parseSse` and `parseNdjson` are the parsers they use.
