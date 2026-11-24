// Starts the viz example on the recording named in the query (default: the full-layer dry1 excerpt of the fixtures).
// ?recording=<url>&pace=realtime|none&speed=1&until=<g>&camera=source|three|top
// The report mode shows one tray's report (default recording: the dry1 excerpt with tray 1, dry1-0018-0153):
// ?recording=<url>&report=<tray n>
import { start, startReport } from "./app.js";

const q = new URLSearchParams(location.search);
const report = q.get("report");
let run;
if (report === null) {
  run = start({
    recording: q.get("recording") ?? "/fixtures/recordings/dry1-0296-0306-full.ndjson.gz",
    pace: q.get("pace") === "none" ? "none" : "realtime",
    speed: Number(q.get("speed") ?? "1"),
    until: q.has("until") ? Number(q.get("until")) : undefined,
    camera: q.get("camera") ?? "source",
  }).then(({ updates }) => String(updates));
} else {
  document.getElementById("views").hidden = true;
  document.getElementById("report-mode").hidden = false;
  run = startReport({
    recording: q.get("recording") ?? "/fixtures/recordings/dry1-0018-0153.ndjson.gz",
    tray: Number(report),
  }).then(({ tray }) => `tray ${tray.n}`);
}
run
  .then((done) => {
    document.body.dataset.done = done;
  })
  .catch((err) => {
    document.getElementById("status").textContent = `error: ${err}`;
    document.body.dataset.done = "error";
  });
