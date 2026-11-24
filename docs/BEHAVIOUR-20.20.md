# How the 20.20 unit behaves, and its live cameras

These measurements come from a Jetson Orin NX on the factory network. Sections 1–6 cover four recordings made on
17–18 November 2026 with build `claude-20261114-int17` (API 2.0.0). The maintainers used their own recorder and
analysis tools. Measurements from later builds are identified separately.

The four recordings were captured again on 22 November with build `claude-20261122-hr4x1`. Only dry1 ran on the unit
in that set. The other three ran in a Mac replay. [Measurement method](#2-how-it-was-measured).

## In short

The following results are from the 17–18 November run unless a different build is named.

| Observation | Measurement |
| --- | --- |
| Shared playback | All viewers share one source and playhead. Selecting or seeking starts a session for everyone. At the end of a recording the unit advances to the next recording at its default start, skips cameras and wraps back to the first recording. |
| Playback rate | All four recordings played at 0.8×. The 1:01:51.8 aug28 video took 1:17:20 of wall time. The later hr4x1 build automatically chose 0.75× for most of dry1. |
| Frame processing | The 1920 px videos took 208 ms per frame, including 164 ms in the encoder. That supports up to 4.8 frames/s. Playback at 0.8× needs 4.0 frames/s and full speed needs 5.0. The 1088 px crops took 116 ms per frame (up to 8.6 frames/s). |
| Late world layers | The unit releases frames within 300 ms of their packets. On the full-frame videos, 3–4% missed the deadline for the world layer. On aug28 and jul30 every world arrived on time. All missing worlds were available 1.5 s later. On hr4x1, 5.6% of dry1 worlds were late. |
| Frame timing | Frames arrived about every 0.24 s, ahead of the playhead by 0.23 s on full frames or 0.34 s on the smaller crop. The lead stayed below 0.6 s. |
| Stream recovery | A slow consumer missed 8 of 60,198 frames across three gaps. The unit still held 4 of the 8 when the client read them back. Reconnecting with `Last-Event-ID` lost no frames. The server waited 10 s to close connections that reached `limit` or `max_s`. |

### Live cameras

Build `claude-20261120-live2` (API 2.1.0) added six plant cameras. The interpreter warms up on the first three
seconds of frames. On looks1, the live view ran 0.27 s behind the camera at 1.6–3.9 frames/s. On hr4x1 the delay was
about 0.5 s and the worker processed about 3.6 frames/s.

Keep a viewer stream open to capture events continuously. The worker releases a camera when its last viewer leaves.
Pausing also loses the intervening footage for every viewer, and playback starts with another warm-up. On the tested
LAN any client could switch the shared source without authentication. Each event has a wall-clock time, with drift
of tens of milliseconds. [Live camera measurements](#7-the-live-cameras).

Build `claude-20261123-speckle3` added a GPU comparison of each stone’s surface pattern between arrival and a later
frame. The unit sends the result in the world layer. [Speckle measurements](#8-the-speckle-answers).

## 1. The unit

As measured on 17 and 18 November (the build of the published recordings is in section 2):

| | |
|---|---|
| Hardware | Jetson Orin NX, 25 W |
| Build | `claude-20261114-int17`, API 2.0.0, boot `a1db829b63` (up 3.2 days when recording began) |
| Model | hand-3D cascade v2 (R regions, H hands and bodies, S stones, T temporal), checkpoint `db1b35410858`, stage 5 best, update 1100 |
| Engines | TensorRT 10.16; the encoder at two input profiles (1088 and 1920), the four heads with INT4 weights |
| World | the Stable sim, fixer `thin-v1` |
| Sources | four recordings; since build `claude-20261120-live2` also six plant cameras; `default_video` is `aug28` |
| Limits | 512 frames retained, 32 streams, 16 items queued per stream, 256 long-polls of 1 s, 60 renders a second |

| Video | Length | Source | Grid | Profile | Default start | Hold |
|---|---|---|---|---|---|---|
| aug28 | 1:01:51.8 | 60 fps, crop 1088×1026 of 1920×1080 | every 12th frame | 1088 | 20:43.5 | 1.4 s |
| jul30 | 1:18:38.1 | 60 fps, same crop | every 12th frame | 1088 | 26:27.0 | 1.4 s |
| dry1 | 30:07.2 | 10 fps, full frame | every 2nd frame | 1920 | 2:19.0 | 2.2 s |
| dry2 | 29:52.2 | 10 fps, full frame | every 2nd frame | 1920 | 24:16.0 | 2.2 s |

Every video is interpreted on the same grid: five frames per media second, numbered `g` from 0 at the start of the
video.

## 2. How it was measured

The maintainers' recorder played each video on the unit from its first frame to its end, as one viewer:

- one server-sent-events stream of all five layers (`observe` not set, so it counts as a viewer and keeps the worker
  running), reconnected with `Last-Event-ID` whenever it ended (the recorder asks for 4,096 frames a stream, so each
  one ends after about 17 minutes);
- `GET /api/v2/session` every 2 s, for the shared clock and the unit's own time;
- every frame released without a layer read again 1.5 s later with `GET /frames/{g}` (up to 6 tries, 1 s apart), and
  frames lost to a `gap` read the same way while the unit still held them (by a gap filler run beside the recorder);
- overlay and scene renders of every 25th frame (every mode and the three rasters for every 100th), and the world's
  event log.

The recorder ran on a Mac on the same LAN with an NTP clock, from 23:30 on 17 November to 03:41 on 18 November, with the
unit on build `claude-20261114-int17`. Nothing else used the unit while it recorded.

**The published recordings** were made again on 22 November with build `claude-20261122-hr4x1` (API 2.2.0, model
`8d09531c915f`) by the same recorder. Only dry1 was recorded on the unit (02:38 to 03:18 UTC; the unit had booted 3.6
minutes before). The recorder's completion record counts 9,042 frames in one session, 19 gaps, 507 missing and 507
backfilled layers and no revision. The 19 are g 1 to 19 (0.2 to 3.8 s), which the unit never sent: its worker reported
the interpreter offline until about 6 s after the select, then sent g 0 and next g 20, and the stream had no `gap`
event. The 507 are worlds that missed the 300 ms deadline (5.6 % of the frames), every one read back. A frame took 241
ms in the median (47 ms of it the stones), and the unit set its own rate (`changed_by: auto-rate`): 0.75× for all but
about a minute (down to 0.63 between 16:23 and 16:44), so its 30:07.0 of media took 40:17 of wall time. dry2, aug28
and jul30 were not recorded on the unit: each is the same model's outputs (computed on an RTX 4090 with ONNX Runtime)
replayed on a Mac through the interpreter of the same build and recorded as on the unit, as its header's
`recorded_from` says, so they say nothing about the unit.

## 3. The shared session

Measured on build `claude-20261114-int17`, except where a passage names another build.

**One session for everyone.** The session is one video, one playhead and one interpretation. `select` and `seek` start
a new session (a new `session` id); `play` and `pause` keep it. Every client sees every change, whoever made it, and
`clock` events say who: `viewer` for a control, `end-of-video` for the unit's own move to the next video.

**The clock.** While playing, the playhead is `anchor_media + (now − max(anchor_wall, hold_until)) × rate`; paused, it
is `anchor_media`. On build `claude-20261114-int17` the rate was 0.8 in every one of the 7,106 samples, and media time
ran at 0.799 to 0.800 of wall time on every video. Build `claude-20261122-hr4x1` changes the rate itself (`clock` events
with `changed_by: auto-rate`; section 2).

**The hold.** After a select or seek the playhead waits `hold` seconds (2.2 s on the dry videos, 1.4 s on the others)
while the worker gets ahead. The first frame came 0.54 s after the select on the dry videos and 0.31 to 0.33 s after it
on aug28 and jul30.

**End of video.** When a video ends, the unit itself selects the next recording in the catalog (it skips the cameras
listed after the recordings, and wraps around to the first) at its default start, in a new session,
`changed_by: end-of-video`: dry1 ended at 30:07.0 and the session went to dry2 at 24:16.0; dry2 ended at
29:52.0 and went to aug28 at 20:43.5; aug28 ended at 1:01:51.8 and went to jul30 at 26:27.0; jul30 ended at 1:18:38.0 and went
to dry1 at 2:19.0. A stream open at that moment carries on into the new session.

**Viewers.** A stream without `observe=1`, or a long-poll with a `cid`, counts as a viewer. The worker interprets only
while there are viewers ("an idle system stays idle", as the spec says of `observe`): nobody watching means nothing is
interpreted, and the frames of that time never exist. Measured on build `claude-20261114-int17`, on dry2 (18 November):
the only viewer left for 61 s; the worker went on for about 20 s, to g 2992, then went idle (`worker.state` `idle`,
reason "nobody is watching") while the clock ran on. The returning viewer got the retained frames up to g 2992 at once,
then g 3161: the 168 frames between were never interpreted, and no event says so.

**Controls.** A control is checked in this order: the request's `Origin` (a foreign origin is refused), the `dry_run`
parameter (only 0 or 1), the body, the per-address rate limit, the fields, then whether it makes sense (for example
seeking past the end). The rate limit is checked before anything is applied, and dry runs count against it, so a
`429` is never half-applied and always safe to retry after `retry_ms`. Limits per address: select and seek share
0.8 s, play and pause 0.3 s, focus 0.15 s.

## 4. Frames

Measured on build `claude-20261114-int17`, except where a passage names another build or the published recordings.

**Release.** A frame is released at most 300 ms after its packet, with the layers that are ready; any other layer is
listed in `missing` and is never pushed again (`GET /frames/{g}` has it once it is done). On build
`claude-20261114-int17` only the world layer was ever missing: in 386 of dry1's 9,057 frames (4.3 %), in 292 of dry2's
8,986 (3.2 %), and in none on aug28 and jul30. Read again 1.5 s after release, every one of those worlds was there
(1.6 s after release in the median, the longest 8.0 s). On build `claude-20261122-hr4x1` the world was missing in 507
of dry1's 9,042 frames (5.6 %), and every one was read back (section 2).
The SDK does this by itself (`backfill=True`), so an Interpreter sees every frame in order, with its world, at the
cost of up to about 4.5 s of extra latency when a world is late.

**Lead.** The worker reads the video up to 0.6 s of media ahead of the shared playhead. The frame's own processing and
the wait for its world take part of that back, so frames arrive ahead of the playhead by:

| | dry1 | dry2 | aug28 | jul30 |
|---|---|---|---|---|
| median | 0.226 s | 0.244 s | 0.344 s | 0.326 s |
| 95th percentile | 0.287 s | 0.295 s | 0.379 s | 0.372 s |
| most | 0.598 s | 0.598 s | 0.600 s | 0.600 s |

(media seconds; on the unit's clock, from the playhead the unit's own formula gives at each frame's arrival). From the
moment the worker can start a frame to its release therefore takes 0.32 s of wall time on the 1088 crop and 0.45 to
0.47 s on the full frame. Frames that come without a world arrive later than the others: they were held to the
deadline.

**Per frame.** The worker's stages, in milliseconds (medians):

| | decode | encoder | regions | hands | stones | temporal | worker in all | world step |
|---|---|---|---|---|---|---|---|---|
| full frame (dry1) | 1.4 | 163.5 | 6.6 | 19.1 | 13.9 | 1.4 | 207.8 (218.3 most) | 5.5 (21.2 most) |
| 1088 crop (aug28) | 1.1 | 71.1 | 6.6 | 19.1 | 13.9 | 1.4 | 115.6 (147.0 most) | 4.6 (18.0 most) |
| 1088 crop (jul30) | 1.1 | 71.1 | 6.6 | 19.1 | 13.9 | 1.4 | 115.6 (151.8 most) | 6.2 (16.5 most) |

(Each frame's own stage times, from its `cards.stage`, over every frame of the video.) The world's step is a few
milliseconds: a world that misses its deadline is waiting in the pipeline, not computing.

**Rhythm.** At 0.8× one frame arrives every 0.24 s (median; 0.33 to 0.41 s at the 95th percentile).

**Retention.** The unit keeps the newest 512 frames: 102 s of media, 128 s of wall time at 0.8×. A stream resumed with
`Last-Event-ID` inside that window gets every frame it missed; `GET /frames/{g}` of an older frame answers
`404 not_retained` with the window.

**Revisions.** While playing, no world was revised (nor in the published recordings). While paused, the paused frame's
world is refined and released again with a higher `world.rev` (the SDK passes it on as a revision). On build
`claude-20261114-int17`, with a 15 s pause of dry2 at 9:49.1 (18 November): within 1.2 s the paused frame, g 2953, came
again with rev 1 to 4, and the frames the worker had read ahead, g 2954 and 2955, with rev 1 and 2; then nothing more
until play. g 2956 came first with rev 1 and then once more with the same rev, a duplicate the SDK drops. On build
`claude-20261122-hr4x1` (the fixture `dry2-pause-seek`: a 15 s pause of dry2 at 9:49.2, 22 November): within 1.4 s the
paused frame, g 2954, and g 2955 came again with rev 1 to 3, and g 2956 and 2957, which the worker had read ahead and
first released without a world, with rev 1 and 2 and with rev 1; then nothing more until play. In the fixture the
backfill put the newest world into their first releases, so g 2956 comes as rev 2, 1 and 2 and g 2957 twice as rev 1;
the SDK drops each later copy with the same or a lower rev.

**What the world says.** World events in each published recording (build `claude-20261122-hr4x1`, with the worlds the
backfill brought back):

| | new | confirm | delete | freeze | push | lift | hinge | carry | place | drop | gone | split |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dry1 | 3,650 | 3,085 | 3,043 | 2,517 | 1,521 | 15 | 6 | 12 | 10 | 2 | 3 | 6 |
| dry2 | 3,316 | 2,621 | 2,573 | 2,053 | 1,264 | 32 | 14 | 23 | 18 | 9 | 5 | 5 |
| aug28 | 8,356 | 7,199 | 7,161 | 3,209 | 2,353 | 28 | 24 | 7 | 24 | 2 | 2 | 0 |
| jul30 | 18,725 | 15,446 | 15,225 | 5,361 | 4,786 | 174 | 109 | 87 | 109 | 41 | 24 | 0 |

Most events are the world keeping its inventory of stones; pushes are hands at work, and a few dozen to a few hundred
events a video are hands lifting, carrying and putting down stones. What the SDK makes of them (moves, push bursts, time per hand state) is
in each recording's summary on https://factory.pdigger.com/developers/data/.

## 5. Streams

Measured on build `claude-20261114-int17`, 17 and 18 November.

**Events.** `frame` (id `<boot>-<cursor>`), `clock` (the shared state, on every change; none on connect, so read
`GET /session` first), `worker` (the interpreter's status, about every 5 s), `gap` (`{"gap": n}`: n items this consumer
lost) and `reset` (`{"boot", "cursor"}`: the unit restarted). NDJSON streams carry only frames and `{"gap": n}`.

**Reliability.** Of the 60,198 frames of the four videos the unit sent all but 8, each time because the recorder had
fallen more than 16 items behind (its stream queue): 4 in one `gap` on dry1, which had left the window before the gap
filler was started, and 4 in two gaps 0.6 s apart on jul30, which the gap filler read back. There was no `reset`.
Reconnecting with `Last-Event-ID` lost nothing.

**A stream ends 10 s after its limit.** When a stream reaches its `limit` or `max_s`, the unit sends nothing more but
closes the connection only about 10 s later (measured: `limit=3` ended 10.0 s after the third frame, `max_s=2` at
12.1 s, SSE and NDJSON alike). A client that waits for the end before reconnecting misses 10 s, and the frames of
those 10 s arrive in a burst on the new stream: each of the recorder's 4,096-frame streams ended that way, and the
40-odd frames after each reconnect arrived up to 7.9 s after the playhead had passed them. A client should count
`limit` and `max_s` itself and close the connection, or ask for neither; the SDK closes it itself.

**The unit's clock** ran 21 to 83 ms ahead of the recorder's NTP clock, wandering slowly over the four hours (the lowest
tenth of each 10 minutes' samples: 36 ms at 23:30, 21 ms at 00:00, 65 ms at 01:20, 37 ms at 02:00, 83 ms at 03:10). Wall times from the unit
are good to tens of milliseconds; the SDK's `SessionClock` measures the offset with each request's round trip.

## 6. Per video

The unit, measured on build `claude-20261114-int17` (17 and 18 November):

| | dry1 | dry2 | aug28 | jul30 |
|---|---|---|---|---|
| profile | 1920 | 1920 | 1088 | 1088 |
| media | 30:07.0 | 29:52.0 | 1:01:51.8 | 1:18:38.0 |
| wall time | 37:40 | 37:21 | 1:17:20 | 1:38:18 |
| frames | 9,057 | 8,986 | 18,560 | 23,591 |
| frames lost | 4 (one gap) | 0 | 0 | 0 (4 in two gaps, read back) |
| without a world at release | 386 (4.3 %) | 292 (3.2 %) | 0 | 0 |
| backfill, median and longest | 1.6 s, 8.0 s | 1.6 s, 2.1 s | — | — |
| lead, median | 0.226 s | 0.244 s | 0.344 s | 0.326 s |
| worker per frame | 207.8 ms | 207.8 ms | 115.6 ms | 115.6 ms |
| first frame after select | 0.54 s | 0.54 s | 0.33 s | 0.31 s |

The SDK's interpretation of the published recordings (build `claude-20261122-hr4x1`; each one's golden summary in
`fixtures/golden/complete`):

| | dry1 | dry2 | aug28 | jul30 |
|---|---|---|---|---|
| moves (placed, dropped, carried away) | 15 (10, 2, 3) | 32 (18, 9, 5) | 28 (24, 2, 2) | 174 (109, 41, 24) |
| push bursts (pushes in them) | 181 (1,413) | 181 (1,226) | 321 (2,353) | 625 (4,786) |
| stones at the end, most at once | 41, 49 | 49, 56 | 33, 68 | 58, 90 |

## 7. The live cameras

Since build `claude-20261120-live2` (API 2.1.0) the unit lists six cameras after the recordings: the two cameras of
each of three plant stone rigs, by serial. This section describes build `claude-20261120-looks1` (it also sends a
`look` of each stone at rest) and, where it says so, build `claude-20261122-hr4x1` (section 2). The frame rates,
measured at the rig (its MJPEG stream read directly), through the interpreter on a Mac test rig, and at the unit:

| Station (`station`) | Cameras | Frames a second |
|---|---|---|
| Plant A | CAM00000001, CAM00000002 | about 3.8 and 3.6 at the rig; 3.8 to 3.9 for CAM00000001 at the unit |
| Plant B | CAM00000003, CAM00000004 | 1.6 to 1.8 at the rig; 2.1 for CAM00000003 on the Mac test rig |
| Plant C | CAM00000005, CAM00000006 | about 3.8 at the rig; 3.7 for CAM00000005 on the Mac test rig |

The unit reads each camera's MJPEG stream from its rig (640×360 JPEGs) and never sends it a control. As in the
spec's Sources tag and `SDK-DESIGN.md` section 3:

- **Catalog.** Each camera is `{"id": "<serial>", "kind": "camera", "live": true, "seekable": false, "duration": null,
  "frames": null, "default_start": null, "grid_step": 1, "fps": 5.0, "hold": 3.0, "station": ..., "proxy": ""}`;
  `default_video` stays `aug28`.
- **Phases.** A select of a camera (never with a `time`: `400 not_seekable`) starts a session at rate 1.0 with
  `state.live`: `connecting` until the first camera frame, `warming` while the interpreter runs on the first 3 s of
  frames (they warm the world but are never released, stored or served), then `live`. On one camera the session went
  live 4.2 s after the select, with `lag` 0.27 s, and frames then came at 3.8 to 3.9 a second. On build
  `claude-20261122-hr4x1` two cameras went live with `lag` 0.53 and 0.48 s, and frames came at 3.6 a second. A playing
  camera that sends no frame for 5 s goes back to `connecting` (a new `revision`), and so does `play`, in its own
  reply: the next frame starts a new warm-up. So `live` means that frames came within the last 5 s, except while
  paused (a pause keeps the phase).
- **Frames.** `g` counts the session's camera frames from 0 (the warm-up's included); `t` is a frame's arrival in
  seconds since `live.since`. They stream like a recording's (`frames/stream`, `frames`, the renders). Each comes with
  the JPEG it was interpreted from, `GET /api/v2/session/frames/{g}/image.jpg` (the newest 64 are kept, about 17 s; an
  older frame that is still retained answers `404 not_retained`, "the picture of frame {g} is no longer kept: only the
  newest 64 pictures are", without a `retained` window); the 512 retained frames are about 2 min 15 s at 3.8 a second. A
  camera has no media (`404`).
- **Pause and play.** A seek whose video is a camera is refused (`409 not_seekable`, field `video`): the one it names,
  or without a `video` the one shown; a seek naming a recording is applied and moves every viewer off the camera.
  `pause` freezes the shared view and stops the interpreter (worker reason `paused on the camera`); `play` goes back to
  `connecting`, then continues at the live edge in the same session after a new warm-up, and `g` jumps by 5 over the
  pause, as it does after a camera that stopped answering (worker reasons `connecting to the camera`, `the camera is
  not answering`). A camera picture that does not decode is dropped; only more than 3 s of them gives the reason `the
  camera's pictures do not decode` and a break.
- **Viewers.** A viewer is an open stream (not `observe`), a long poll with a `cid`, the page, and for 15 s the
  address that sent a control (not a dry run). The worker interprets while there is one and idles 20 s after the last
  (reason `nobody is watching`); on a camera the phase then goes back to `connecting` 5 s later. So a client that
  selects a camera and only polls `GET /api/v2/session` sees it go live, and keeps it live by opening a stream.

What the cameras change:

1. **The camera sets the pace, up to what the worker manages.** The cameras send 1.6 to 3.9 frames a second. On build
   `claude-20261114-int17` that is below the 4.8 the worker managed on the full-frame profile, so the worker kept up
   and nothing was dropped. On build `claude-20261122-hr4x1` a camera frame takes the worker 274 ms, 35 ms of it
   decoding the camera's JPEG (on a recording 241 ms, 1.4 ms of it decoding): 3.6 frames a second, so from two cameras
   of about 3.8 a second at the rig the frames came at 3.57 and 3.55 a second (gaps 280 ms in the median, at most
   361 ms), live 0.53 and 0.48 s behind the camera. The unit runs each camera at its own rate, one `g` per frame (the
   catalog's `fps` 5.0 is only the grid a camera is said to run on).
2. **Nobody watching means nothing interpreted.** Without a viewer, the worker lets the camera go after 20 s, and the
   session shows `connecting` 5 s later; a viewer who comes back continues the same session after a hole and a new
   warm-up. A control counts as a viewer for 15 s, so selecting a camera wakes the worker. An MES or ERP integration
   that counts moves has to keep a viewer stream open all the time (the SDK's Interpreter does: `observe=False` by
   default).
3. **Pause loses time for everybody.** Nothing is interpreted while the shared session is paused, for every client.
   A viewer who wants to look at a moment should freeze their own view (the SDK and the 3-D viewers can), not the
   shared session.
4. **Anyone can switch the camera.** Any client on the LAN can select a camera or a recording, or pause, and that
   changes the session for everybody; the API has no authentication. The SDK sends `Authorization: Bearer` when given a
   token, for a deployment that requires one.
5. **Wall time is the timestamp.** On a camera, media time only counts seconds since the session started; the useful
   time of an event is its wall time. The unit's clock wandered between 21 and 83 ms ahead of NTP (on build
   `claude-20261114-int17`); the SDK gives every event and activity a `wall` time from the clock events, and
   `SessionClock` measures the offset.

## 8. The speckle answers

The unit identifies stones by comparing the fine grain on their surfaces in two images. It sends each GPU comparison
once in `world.speckle` (`WorldSpeckle`).
[How the SDK reads these results](../spec/SDK-DESIGN.md#4612-the-units-speckle-answers-worldspeckle).

Builds speckle3 and speckle4 searched the whole tray, at about a second of GPU time per tray. Build
`claude-20261123-speckle6` searched known stone locations in tens of milliseconds. Build `claude-20261123-speckle7`
also handles stones too large for the GPU kernels by comparing the centre of their box. It finds the other stones as
speckle6 did.

The measurements below use speckle6 except for the final item. They cover the first 150 seconds of dry1 on the unit,
37 trays replayed offline on the unit, a plant camera and all four recordings.

- **What it compares.** The unit reads the trays as the SDK does (4.6.1, without its pauses for the inventory and for
  stones not seen): offline over all of dry1 its arrivals are the SDK's for 64 of 66 trays (one a frame early, one tray
  it never arrives), and its last comparison is at the SDK's leaving frame for 60 of 65. The reference is the tray's
  arrival; the later moment a calm moment of the tray, at most one a minute, or the last calm frame before the tray
  moves on.
- **How.** A stone's template is the inner 62 % of its outline box in the full-resolution grey picture less its
  Gaussian blur (sigma 2.5), turned 0 and 180 degrees and each by -4 to 4 degrees, compared by normalised
  cross-correlation where the stones of the other moment are (on each one's inner box, up to 24 px off) and at its own
  place (up to 40 px off); when nothing there scores 0.30, also anywhere within 128 px of its own place. A find is clean
  when its score is at least 0.30 and at least twice the second place. Two stones are paired (`pairs`) when a clean find
  from one lands on the other and the other's find, when clean, lands on the first; a stone in a contradiction, or
  paired twice, is in no pair. A stone held by a hand at one moment is not checked from it. A stone that moved more than
  128 px to where the world shows no stone is not found there.
- **When.** An answer comes in the world of the first frame after it is ready: for a calm moment 0.4 to 0.8 s of media
  after it in the test runs (the whole-tray search: 6.2 to 7.8 s), 0.3 to 0.8 s on the plant camera. The checks of a
  tray of about 40 stones take the GPU 48.5 ms alone (median of 37 trays, at most 57.3 ms) and 100 to 149 ms beside
  the worker in the test runs, 39 to 82 ms on the plant camera (`gpu_ms`); the whole-tray search took about 1.1 s
  alone and 2.3 to 2.7 s beside the worker.
- **Cost.** Over dry1's part of the test runs the worker's frame time is 241.8 ms (241.4 ms without the speckle
  service, 284 to 287 ms with the whole-tray search), and that part took 215.8 s (214.0 s without; 222.6 to 233.9 s
  with the whole-tray search).
- **The same as the maintainers' reference matcher** (offline, on a CPU; not published). On 37 trays of the four
  recordings, run on the unit, the GPU's finds are the reference matcher's: the same place, turn and angle for 3,031
  of 3,031, scores within 7e-7. On the test runs' own answers (dry1, 5 answers, 409 finds) the reference matcher gives
  the same clean verdict for all, the same pairs (184 of 184) and scores within 0.004 (the unit's grey picture comes
  from the decoder's colour, the reference matcher's from the video's luma).
- **Right and wrong.** Against the stones a look tracker followed both ways on 60 trays of the four recordings, a
  clean find is right for 2,258 of 2,447 stones and wrong for 4; 185 are not clean (the whole-tray search: 2,242 right,
  3 wrong, 202 not clean; 129 of the 185 on aug28, whose moulded pavers give high second places). The camera check of
  dry1's tray 2 agrees with the last answer for that tray on all 39 labelled stones. Over 542 trays of the four
  recordings (48,311 finds), 57 clean finds lie on another stone than a place the whole-tray search scored higher, and
  the whole-tray search called each of those 57 not clean: there the check misses a close second place.
- **Long stones are checked by their central part** (build speckle7). A stone whose inner box is wider or higher than
  192 px, or larger than about 140 x 140 px (a long kerb, a large slab), is too large for the unit's GPU kernels. It
  is checked by the central part of its inner box: the largest box about the same centre that the kernels take, shaved
  from its longer side (an 811 x 123 px box gives its central 157 x 123). Its `score`, `second` and `at` are that
  part's; the part's centre is the stone's. Earlier builds left such a stone unchecked (`score` and `second` null): on
  a plant camera whose stones are long kerbs, 239 of the 335 boxes of 9 answers (71 %). In the four recordings every
  box fits (68,798 checked), so their answers are the same either way. With build speckle7 on that camera every box is
  checked (14 answers on 7 trays): GPU 28 to 222 ms an answer, each 0.5 to 1.8 s after its moment; the worker's frame
  time 274.6 ms against 273.4 ms before. Checked by camera on 34 trays of a recording from that camera: 384 of 463
  long stones right, 1 wrong, 78 not clean; pairs right for 1,181 of 1,476 stones (1,008 with the long stones
  unchecked), none wrong. Compared with the next two trays, where any clean find is wrong: 5 of 479 long stones gave
  one (stones that fit: 18 of 2,526, with either build), and wrong pairs rose from 11 to 16 over 65 tray pairs. In the
  test runs, a kerb tray every 13 s (that camera's rate) adds 2.9 ms to the worker's frame time over dry1's part.

The four published recordings were made before the unit sent answers. Their worlds carry answers made afterwards: the
unit's own tray reading (build `claude-20261123-speckle6`) over each recording's worlds asked for them, the
maintainers' reference matcher answered by its region check on the original video (`device`
`reference matcher, CPU, offline`), and each answer is in the world of the first frame 0.6 media seconds after the
frame that asked: dry1 98 answers, dry2 82, aug28 224, jul30 359. Each header's `notes` say so. The SDK reads each
answer as a tray's and gives the tray stones in it their part (`TraySpeckle`, `TrayStone.speckle`); the tray rules use
the answer for each tray's leaving (SDK-DESIGN 4.6.13): it confirms or links the stones it pairs, and every change in
a report carries its confidence.

## 9. Where the numbers come from

The maintainers' recorder and analysis tools (not published) made the recordings and measured sections 1 to 6 from
them: the complete recordings of 17 and 18 November on build `claude-20261114-int17`, and on 22 November the published
four (dry1 on the unit; dry2, aug28 and jul30 from the replay on a Mac, section 2). The published recordings, with
the speckle answers of section 8 in their worlds, and their summaries are at
https://factory.pdigger.com/developers/data/.
