#!/bin/sh
# Checks the try-it image (Dockerfile) as its header comment uses it, with no network:
#   1. the quickstart follows FakeFactory (scripts/fake-preload.mjs) and prints the fixture's golden events;
#   2. the viz page's static server (examples/browser/serve.mjs) serves the page, the package, three.js and a fixture
#      recording: everything the page imports.
# `make image-check` builds the image first; CI runs it. IMAGE names the image (default pdigger-factory-sdk-ts).
set -eu
IMAGE=${IMAGE:-pdigger-factory-sdk-ts}
NAME="pdigger-factory-sdk-ts-image-check-$$"
HERE=$(cd "$(dirname "$0")/.." && pwd)

out=$(docker run --rm --network none -e FAKE_RECORDING=joined-mid-move "$IMAGE" \
  node --import ./scripts/fake-preload.mjs examples/quickstart.ts 2>/dev/null)
first=$(printf '%s\n' "$out" | head -n 1)
events=$(printf '%s\n' "$out" | sed -n '2,$p')
if [ "$first" != "following dry1, session 1795314878" ] ||
  [ "$events" != "$(sed -e '/^$/d' "$HERE/fixtures/golden/joined-mid-move.events.txt")" ]; then
  printf 'image-check: the quickstart did not print the golden events of joined-mid-move:\n%s\n' "$out" >&2
  exit 1
fi
echo "image-check: quickstart ok ($(printf '%s\n' "$events" | wc -l | tr -d ' ') golden events)"

docker run -d --rm --network none --name "$NAME" "$IMAGE" node examples/browser/serve.mjs >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT INT TERM
docker exec "$NAME" node --input-type=module -e '
const paths = [
  "/examples/browser/",
  "/examples/browser/main.js",
  "/examples/browser/app.js",
  "/dist/index.js",
  "/dist/viz/index.js",
  "/node_modules/three/build/three.module.js",
  "/fixtures/recordings/dry1-0296-0306-full.ndjson.gz",
];
const base = "http://127.0.0.1:8130";
for (let i = 0; ; i++) {
  try {
    await fetch(base + "/");
    break;
  } catch (err) {
    if (i === 100) throw err; // 10 s: the server did not start
    await new Promise((r) => setTimeout(r, 100));
  }
}
let bad = 0;
for (const p of paths) {
  const r = await fetch(base + p);
  const n = (await r.arrayBuffer()).byteLength;
  console.log(`image-check: ${r.status} ${p} (${n} bytes)`);
  if (r.status !== 200 || n === 0) bad++;
}
process.exitCode = bad === 0 ? 0 : 1;
'
echo "image-check: viz page files ok"
