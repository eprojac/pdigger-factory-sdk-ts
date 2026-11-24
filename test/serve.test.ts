/** The viz example's static server (examples/browser/serve.mjs) answers only for files inside this package. */
import { request } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileOf, serve } from "../examples/browser/serve.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The status of a GET of a raw path (sent as written, without the URL parser's dot-segment removal). */
function status(server: Server, path: string): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
}

describe("examples/browser/serve.mjs", () => {
  it("maps request paths to files inside the package and refuses the rest", () => {
    expect(fileOf("/examples/browser/index.html")).toBe(join(root, "examples/browser/index.html"));
    expect(fileOf("/")).toBe(root);
    expect(fileOf("/dist/../src/index.ts")).toBe(join(root, "src/index.ts"));
    expect(fileOf("/../secret")).toBeNull();
    expect(fileOf("/a/../../b")).toBeNull();
    expect(fileOf("/..%2fsecret")).toBeNull(); // an encoded separator
    expect(fileOf("/a/..%2f..%2fb")).toBeNull();
    expect(fileOf("/%2e%2e/secret")).toBeNull();
    expect(fileOf(`/../${basename(root)}-sibling/x`)).toBeNull(); // a sibling whose name starts like the package's
    expect(fileOf("/%E0%A4%A")).toBeNull(); // a malformed escape
  });

  it("serves files, answers 403 outside the package and 404 for what is missing", async () => {
    const server = (await serve(0)) as Server;
    try {
      expect(await status(server, "/examples/browser/index.html")).toBe(200);
      expect(await status(server, "/examples/browser/")).toBe(200); // a folder: its index.html
      expect(await status(server, "/..%2f..%2fetc/passwd")).toBe(403);
      expect(await status(server, "/%E0%A4%A")).toBe(403);
      expect(await status(server, "/no/such/file")).toBe(404);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
