// A tiny static server for the viz example: serves this package's folder (the page, dist/, node_modules/three and the
// fixture recordings) on 127.0.0.1. Run `npm run build` first, then `node examples/browser/serve.mjs` and open the URL.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gz": "application/gzip",
  ".ndjson": "application/x-ndjson",
  ".map": "application/json; charset=utf-8",
};

/** Serves the package folder on 127.0.0.1 (`port` 0: any free port); resolves with the server once it listens. */
export function serve(port = Number(process.env.PORT ?? "8130")) {
  const server = createServer(handle);
  const host = process.env.HOST ?? "127.0.0.1"; // HOST=0.0.0.0 in a container
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

/** The file of a request path inside `root`, or null for one outside it (`..`, an encoded separator, a sibling). */
export function fileOf(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null; // a malformed escape
  }
  const file = resolve(root, `.${path}`);
  const rel = relative(root, file);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return outside ? null : file;
}

function handle(req, res) {
  let file = fileOf(new URL(req.url ?? "/", "http://localhost").pathname);
  if (file === null) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    const size = statSync(file).size;
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Content-Length": size });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await serve();
  console.log(`viz example: http://127.0.0.1:${server.address().port}/examples/browser/`);
}
