# Low level: operations, errors, the codec

## One method per operation

Use `factory.api` to request a specific frame, fetch a model output or control the shared session. The 32 typed
methods correspond to the [OpenAPI operations](../spec/openapi.yaml). The codec decodes packed maps, bitsets, depth
and joint data.

Each method accepts `signal`, `timeoutMs` and `headers`. Controls also accept `dryRun`. Responses use the
specification’s types, preserve unknown fields and allow redacted fields to be absent.

| Group | Methods |
|---|---|
| Meta | `getApiRoot`, `getOpenApi` (text), `getModel`, `getTopology`, `getHealth`, `getReady`, `getStatus`, `getMetrics` (text and parsed samples) |
| Sources | `listVideos` (with `ifNoneMatch`: null when unchanged), `getVideo`, `getVideoMedia` (byte `range`), plus `headVideoMedia` and `openVideoMedia` (a byte stream); the catalog's entries come as `Source` objects (`entry` is the JSON as sent) |
| Session | `getSession`, `sessionSelect`, `sessionSeek`, `sessionPlay`, `sessionPause`, `getFocus`, `putFocus`, `deleteFocus` |
| Frames | `streamFrames`, `pollFrames`, `getFrame` (`g` or `"latest"`), `getFramePicture` (a live frame's camera JPEG and its `g`; `session` guards against a switched session), `getFrameRaster` (PNG of `regions`, `mask` or `depth`, `scale` 1..8) |
| World | `getWorld`, `getWorldEvents` (`after`, `limit`, `type`), `getStone` (a stone's track) |
| Render | `renderOverlay2d`, `renderScene3d`: draw lists for one frame, exactly one of `g` and `t`; `mode`, `draw`, `surface`, `session` |
| Raw | `rawStream`, `rawPacket`, `rawTensors` (npz bytes; `debug_disabled` when the unit does not capture them) |

That is all 32 operations of the spec (`OPERATIONS` lists them). The frozen legacy surface (`/api/live`,
`/api/control`, `/api/health`, `/catalog.json`, `/videos/*.mp4`) is not wrapped.

<!-- snippet: examples/levels.ts#low -->
```ts
// Low level: one typed method per operation, typed errors, and decoders for the packed layers.
const frame = await factory.api.getFrame("latest", { layers: ["overlay"] });
const regions = frame.overlay?.regions;
if (regions) {
  const tray = codec.decodeU8Map(regions.tray, regions.rows, regions.cols); // rows x cols, row-major
  console.log(
    `low: frame ${frame.g}: tray covers ${tray?.filter((v) => v > 0).length} of ${regions.rows * regions.cols} cells`,
  );
}
const scene = await factory.api.renderScene3d({ g: frame.g, surface: "vertices" });
const mesh = codec.decodeSurfaceMesh(scene.surface);
console.log(
  `low: scene ${scene.g}: ${scene.stones.length} stones, surface of ${(mesh?.indices.length ?? 0) / 3} triangles`,
);
```

## The client

`new FactoryClient(baseUrl, options)`, or `FactoryClient.fromEnv()` for `PDIGGER_FACTORY_URL`:

| Option | Default | |
|---|---|---|
| `timeoutMs` | 10 000 | a whole request, headers and body (streams use `connectTimeoutMs` only); a real timer, as fetch's own |
| `connectTimeoutMs` | 5 000 | until the response headers arrive (`fetch` has no separate connect phase); a real timer |
| `retries` | 3 | GET retries |
| `backoff` | `{ baseMs: 250, factor: 2, maxMs: 5000 }` | full jitter: `random() * min(maxMs, baseMs * factor^attempt)` |
| `headers`, `token` | | extra headers; `Authorization: Bearer <token>` (20.20 ignores it; the shipped API may require it) |
| `userAgentSuffix` | | appended to the user agent `pdigger-factory-sdk-ts/1.0.0` (a browser may send its own) |
| `fetch` | the global `fetch` | any `fetch`: a proxy agent, a fake (`pdigger-factory-sdk/testing`) |
| `clock`, `random` | the system's | injected time and randomness (tests use `InstantClock`, `seededRandom`): backoff, backfill, pacing, `waitFor`, `maxS` and the stream watchdog |
| `observe` | `false` | the default of `observe` for streams and Interpreters |
| `idleTimeoutMs` | 30 000 | the default of the streams' watchdog: a connection silent this long after it sent something is resumed; 0: never |

## Errors

<!-- snippet: examples/errors.ts#errors -->
```ts
try {
  await factory.api.getFrame(0); // the unit keeps only its newest frames
} catch (err) {
  if (!isFactoryError(err, "not_retained")) throw err;
  console.log(`frame 0 is gone: the unit keeps frames ${err.retained?.g0} to ${err.retained?.g1}`);
}

try {
  const live = await factory.live();
  console.log(`live camera: ${live.title}`);
} catch (err) {
  if (!isFactoryError(err, "live_unavailable")) throw err;
  console.log("this unit lists no camera: the shared session plays recordings");
}

try {
  await factory.api.getVideo("no-such-video");
} catch (err) {
  if (!isFactoryError(err)) throw err;
  console.log(`${err.status} ${err.code} (field ${err.field}): ${err.message}; retryable: ${err.isRetryable()}`);
}
```

A `FactoryError` has `status` (null without an HTTP reply), `code`, `message`, `field`, `retryMs`, `retained` (the
frames the unit still holds, on `not_retained`), `waiting` (what a 503 waits for) and `body`. The codes are the API's
(`ErrorCode` in the spec: `not_retained`, `session_gone`, `stale_session`, `unknown_video`, `not_seekable`,
`invalid_param`, ...) and five of the SDK's: `transport` (no HTTP reply: refused, reset, timed out), `decode` (a reply
that is not the documented JSON, with its `status` and the start of its `body`), `live_unavailable` (the catalog has no
live camera), `live_timeout` (`session.untilLive()` ran out of time) and `stream_closed` (a stream ended for good). `isFactoryError(err, code?)` narrows; `isRetryable()`, `isNotRetained()` and `isSessionGone()`
answer the common questions.

Retries: GET and HEAD are retried on connection errors, 429, 502, 503 and 504, waiting `retry_ms` from the error body,
else `Retry-After`, else the backoff. POST, PUT and DELETE are retried only on 429 (the server checks its rate limits
before it applies anything). Other 4xx replies are never retried.

## The codec

`codec` decodes the packed parts of the layers. Every decoder returns null for an absent (redacted) map.

| Function | |
|---|---|
| `decodeU8Map(b64, rows, cols)` | overlay maps: rows x cols bytes, row-major |
| `decodeZlibMap(b64, rows, cols)` | `sip1` maps (base64 of zlib) |
| `decodeBitset(b64, n)` | n booleans, least significant bit first |
| `depthLogZ(q, lo, hi, a, b)`, `depthZ(...)`, `decodeDepth(bytes, lo, hi, a, b)` | depth: `logZ = a * (lo + q / 255 * (hi - lo)) + b` |
| `decodeF32le(b64)`, `decodeU16le(b64)`, `decodeSurfaceMesh(surface)` | the observed surface of a `Scene3D` (`surface=vertices`) |
| `toJoint(tuple)`, `toJoints(list)` | joints from `[u, v, vis, x, y, z]` |
| `toStoneItem(tuple)` | stones from `[u, v, w, h, score, X, Y, Z, w_m, h_m, yaw]` |
| `uvToPx`, `pxToUv`, `sceneToThree`, `threeToScene`, `quatToYaw` | coordinates |
| `bonesOf(topology)`, `wristJoint(topology, side)`, `tipJoints(topology, side)` | the skeleton from `getTopology` |

## Models

Every schema of the spec is an exported type (`Frame`, `WorldLayer`, `StoneView`, `Overlay2D`, `Scene3D`, `State`,
`VideoEntry`, ...). Integers in the spec (`g`, `cursor`, `session`, ids) are JavaScript numbers, exact up to 2^53, far
beyond what a unit produces; this is the one difference of shape from the other languages, which have integer types.
`Source` wraps a `VideoEntry` with the defaults of fields the 20.20 unit does not send (`kind: "recording"`,
`live: false`, `seekable: true`); `JSON.stringify(source)` gives the entry back.
