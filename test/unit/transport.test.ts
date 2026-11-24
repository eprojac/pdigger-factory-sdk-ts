import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FactoryError,
  USER_AGENT,
  VERSION,
  isFactoryError,
  parseMetrics,
  seededRandom,
  type FetchLike,
} from "pdigger-factory-sdk";
import { Transport, errorFromResponse, parseRetryAfter } from "../../src/transport.js";
import { InstantClock, ManualClock } from "pdigger-factory-sdk/testing";
import { rejection } from "../helpers/fake.js";
import { readText } from "../helpers/fixtures.js";

type Step = Response | Error | ((init: RequestInit | undefined) => Promise<Response>);

/** A fetch that answers with the given steps in order and records each call. */
function scripted(...steps: Step[]): FetchLike & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps.shift();
    if (step === undefined) throw new Error("no more steps");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(init);
    return step;
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const apiError = (status: number, code: string, extra: object = {}): Response =>
  json({ error: `${code}!`, code, ...extra }, status);

/** A fetch that hangs until its signal aborts. */
const hanging = (init: RequestInit | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

const transport = (fetch: FetchLike, extra: object = {}): Transport =>
  new Transport({
    baseUrl: "http://unit.test:8120/",
    fetch,
    clock: new InstantClock(),
    random: seededRandom(1),
    ...extra,
  });

afterEach(() => vi.unstubAllGlobals());

describe("Transport", () => {
  it("builds URLs and headers", async () => {
    const f = scripted(json({ ok: true }));
    const t = transport(f, { token: "secret", headers: { "X-Team": "line" }, userAgentSuffix: "my-app/2" });
    expect(t.baseUrl).toBe("http://unit.test:8120");
    expect(t.userAgent).toBe(`${USER_AGENT} my-app/2`);
    expect(USER_AGENT).toBe(`pdigger-factory-sdk-ts/${VERSION}`);
    expect(t.url("/api/v2/x", { a: 1, b: "s", c: true, d: false, e: null, f: undefined, g: ["x", "y"] })).toBe(
      "http://unit.test:8120/api/v2/x?a=1&b=s&c=1&d=0&g=x%2Cy",
    );
    await t.json({ method: "POST", path: "/p", body: { x: 1 }, headers: { "X-One": "1" } });
    const h = f.calls[0]?.init?.headers as Record<string, string>;
    expect(h).toMatchObject({
      "User-Agent": `${USER_AGENT} my-app/2`,
      Accept: "application/json",
      "X-Team": "line",
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
      "X-One": "1",
    });
    expect(f.calls[0]?.init?.body).toBe('{"x":1}');
    const sub = new Transport({ baseUrl: "http://unit.test/prefix/", fetch: f });
    expect(sub.url("/api/v2")).toBe("http://unit.test/prefix/api/v2");
  });

  it("resolves a relative base URL against the page, and refuses one without a page", () => {
    expect(() => new Transport({ baseUrl: "/x" })).toThrow(TypeError);
    vi.stubGlobal("location", { href: "https://factory.example/viewer/index.html" });
    expect(new Transport({ baseUrl: "" }).baseUrl).toBe("https://factory.example");
    expect(new Transport({ baseUrl: "/unit/" }).baseUrl).toBe("https://factory.example/unit");
  });

  it("uses the global fetch by default", async () => {
    const g = vi.fn(async () => json({ ok: 1 }));
    vi.stubGlobal("fetch", g);
    expect(await new Transport({ baseUrl: "http://unit.test" }).json({ method: "GET", path: "/a" })).toEqual({ ok: 1 });
    expect(g).toHaveBeenCalledOnce();
  });

  it("retries GET on transport errors and 502/503/504 with backoff, honouring retry_ms", async () => {
    const clock = new InstantClock();
    const sleep = vi.spyOn(clock, "sleep");
    const f = scripted(
      new TypeError("reset"),
      apiError(503, "busy", { retry_ms: 700 }),
      new Response("bad gateway", { status: 502 }),
      json({ ok: 1 }),
    );
    const t = transport(f, { clock, backoff: { baseMs: 100, factor: 2, maxMs: 150 } });
    expect(await t.json({ method: "GET", path: "/a" })).toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(4);
    const waits = sleep.mock.calls.map((c) => c[0]);
    expect(waits[1]).toBe(700);
    expect(waits[0]).toBeLessThan(100);
    expect(waits[2]).toBeLessThan(150);
  });

  it("gives up after the retries", async () => {
    const f = scripted(apiError(504, "busy"), apiError(504, "busy"));
    const err = (await rejection(transport(f, { retries: 1 }).json({ method: "GET", path: "/a" }))) as FactoryError;
    expect(err.status).toBe(504);
    expect(f.calls).toHaveLength(2);
    const none = scripted(new TypeError("x"));
    expect(
      ((await rejection(transport(none, { retries: -3 }).text({ method: "GET", path: "/a" }))) as FactoryError).code,
    ).toBe("transport");
  });

  it("retries a POST only on 429", async () => {
    const f = scripted(
      new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }),
      json({ state: {} }),
    );
    expect(await transport(f).json({ method: "POST", path: "/c", body: {} })).toEqual({ state: {} });
    const g = scripted(new TypeError("reset"));
    expect(((await rejection(transport(g).json({ method: "POST", path: "/c", body: {} }))) as FactoryError).code).toBe(
      "transport",
    );
    const h = scripted(apiError(503, "busy"));
    expect(((await rejection(transport(h).json({ method: "PUT", path: "/c", body: {} }))) as FactoryError).code).toBe(
      "busy",
    );
  });

  it("does not retry other errors and passes foreign errors through", async () => {
    const f = scripted(apiError(400, "invalid_param", { field: "g" }));
    const err = (await rejection(transport(f).json({ method: "GET", path: "/a" }))) as FactoryError;
    expect(err).toMatchObject({ code: "invalid_param", field: "g", status: 400 });
    const boom = new RangeError("mine");
    const g = scripted(async () => {
      throw boom;
    });
    const t = transport(g);
    const read = vi.fn(async () => {
      throw boom;
    });
    expect(await rejection(t.request({ method: "GET", path: "/a" }, read))).toBeInstanceOf(FactoryError);
    const ok = scripted(json({}));
    expect(
      await rejection(t.request({ method: "GET", path: "/a" }, read).catch((e) => Promise.reject(e))),
    ).toBeDefined();
    void ok;
  });

  it("wraps a fetch that rejects with a non-error", async () => {
    const f = scripted(async () => Promise.reject("plain string"));
    const err = (await rejection(transport(f, { retries: 0 }).json({ method: "GET", path: "/a" }))) as FactoryError;
    expect(err.message).toBe("GET /a failed: plain string");
    const ok = scripted(json({ a: 1 }));
    expect(await transport(ok).object({ method: "GET", path: "/a" })).toEqual({ a: 1 });
  });

  it("times out a request, and passes the caller's abort reason", async () => {
    const t = transport(scripted(hanging), { timeoutMs: 5, retries: 0 });
    const err = (await rejection(t.json({ method: "GET", path: "/slow" }))) as FactoryError;
    expect(err.code).toBe("transport");
    expect(err.message).toContain("timed out after 5 ms");
    const c = new AbortController();
    const p = transport(scripted(hanging)).json({ method: "GET", path: "/slow", signal: c.signal });
    c.abort(new Error("caller"));
    expect(String(await rejection(p))).toContain("caller");
    const pre = new AbortController();
    pre.abort(new Error("before"));
    expect(
      String(await rejection(transport(scripted(json({}))).json({ method: "GET", path: "/a", signal: pre.signal }))),
    ).toContain("before");
    const noReason = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const fail = scripted(new TypeError("x"));
    expect(await rejection(transport(fail).json({ method: "GET", path: "/a", signal: noReason }))).toBeDefined();
  });

  it("reads JSON, objects, text and bytes, with decode errors", async () => {
    const t = transport(
      scripted(
        new Response("not json"),
        json([1, 2]),
        json(null),
        new Response("plain"),
        new Response(new Uint8Array([1, 2, 3])),
        new Response(null, { status: 304 }),
      ),
    );
    // decode errors carry the status and the start of the body, as other errors do
    expect(await rejection(t.json({ method: "GET", path: "/a" }))).toMatchObject({
      code: "decode",
      status: 200,
      body: "not json",
    });
    expect(await rejection(t.object({ method: "GET", path: "/a" }))).toMatchObject({
      code: "decode",
      status: 200,
      body: "[1,2]",
    });
    expect(await rejection(t.object({ method: "GET", path: "/a" }))).toMatchObject({ code: "decode", status: 200 });
    expect(await t.text({ method: "GET", path: "/a" })).toBe("plain");
    expect([...(await t.bytes({ method: "GET", path: "/a" })).bytes]).toEqual([1, 2, 3]);
    expect((await t.bytes({ method: "GET", path: "/a", okStatus: [304] })).response.status).toBe(304);
  });

  it("opens streams: connect timeout, error replies, missing bodies, close", async () => {
    const t = transport(
      scripted(
        new Response("data: 1\n\n", { headers: { "Content-Type": "text/event-stream" } }),
        apiError(410, "session_gone"),
        new Response(null, { status: 200 }),
        hanging,
      ),
      { connectTimeoutMs: 5, retries: 0 },
    );
    const h = await t.stream({ method: "GET", path: "/s" });
    expect(h.response.status).toBe(200);
    expect(h.signal.aborted).toBe(false);
    h.close();
    h.close();
    expect(h.signal.aborted).toBe(true);
    expect(((await rejection(t.stream({ method: "GET", path: "/s" }))) as FactoryError).code).toBe("session_gone");
    expect(((await rejection(t.stream({ method: "GET", path: "/s" }))) as FactoryError).code).toBe("decode");
    const timeout = (await rejection(t.stream({ method: "GET", path: "/s" }))) as FactoryError;
    expect(timeout.message).toContain("timed out after 5 ms");
  });

  it("computes full-jitter backoff", () => {
    const t = new Transport({
      baseUrl: "http://u.test",
      random: () => 0.5,
      backoff: { baseMs: 100, factor: 3, maxMs: 500 },
    });
    expect([0, 1, 2, 3].map((n) => t.backoffDelay(n))).toEqual([50, 150, 250, 250]);
    expect(t.backoffDelay(5000)).toBe(250); // 3 ** 5000 is Infinity: the cap
    const zero = new Transport({ baseUrl: "http://u.test", random: () => 0.5, backoff: { baseMs: 0, factor: 1e5 } });
    expect([0, 64, 1024, 5000].map((n) => zero.backoffDelay(n))).toEqual([0, 0, 0, 0]); // never NaN
    const d = new Transport({ baseUrl: "http://u.test" });
    expect(d.backoffDelay(0)).toBeLessThan(250);
    expect(d.retries).toBe(3);
    expect(d.timeoutMs).toBe(10_000);
    expect(d.connectTimeoutMs).toBe(5_000);
    expect(d.clock).toBeDefined();
    void new ManualClock();
  });
});

describe("errors", () => {
  it("maps error replies", async () => {
    const e = await errorFromResponse(
      apiError(404, "not_retained", { retained: { session: 1, g0: 1, g1: 2, t0: 0, t1: 1, n: 2 } }),
    );
    expect(e).toMatchObject({ code: "not_retained", status: 404, message: "not_retained!" });
    expect(e.isNotRetained()).toBe(true);
    expect(e.retained?.n).toBe(2);
    const ready = await errorFromResponse(json({ code: "not_ready", waiting: ["worker"] }, 503));
    expect(ready.message).toBe("not_ready");
    expect(ready.waiting).toEqual(["worker"]);
    expect(ready.isRetryable()).toBe(true);
    const plain = await errorFromResponse(new Response("teapot", { status: 418 }));
    expect(plain).toMatchObject({ code: "decode", message: "HTTP 418: teapot", body: "teapot" });
    expect(plain.isRetryable()).toBe(false);
    const empty = await errorFromResponse(new Response(null, { status: 404 }));
    expect(empty).toMatchObject({ code: "not_found", message: "HTTP 404", body: undefined });
    const busy = await errorFromResponse(new Response("{", { status: 503, headers: { "Retry-After": "1.5" } }));
    expect(busy).toMatchObject({ code: "not_ready", retryMs: 1500 });
    const codes: [number, string][] = [
      [400, "invalid_param"],
      [403, "cross_origin"],
      [405, "method_not_allowed"],
      [413, "body_too_large"],
      [415, "json_only"],
      [416, "invalid_param"],
      [429, "too_many_requests"],
      [500, "internal"],
      [502, "internal"],
      [504, "internal"],
      [418, "decode"],
      [302, "decode"],
    ];
    for (const [status, code] of codes) {
      const e = await errorFromResponse(new Response(null, { status }));
      expect([status, e.code, e.field]).toEqual([status, code, status === 416 ? "range" : null]);
    }
    const broken = new Response("x", { status: 500 });
    vi.spyOn(broken, "text").mockRejectedValue(new Error("gone"));
    expect((await errorFromResponse(broken)).message).toBe("HTTP 500");
    const late = await errorFromResponse(apiError(429, "too_many_requests"), 0);
    expect(late.retryMs).toBeNull();
  });

  it("parses Retry-After", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter(" ", 0)).toBeNull();
    expect(parseRetryAfter("3", 0)).toBe(3000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 4000)).toBe(6000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 99_000)).toBe(0);
    expect(parseRetryAfter("soon", 0)).toBeNull();
  });

  it("FactoryError helpers", () => {
    const e = new FactoryError({ code: "stale_session", message: "old", cause: new Error("c") });
    expect(e.isSessionGone()).toBe(true);
    expect(new FactoryError({ code: "session_gone", message: "" }).isSessionGone()).toBe(true);
    expect(new FactoryError({ code: "transport", message: "" }).isRetryable()).toBe(true);
    expect(e.cause).toBeInstanceOf(Error);
    expect(e.toJSON()).toEqual({
      name: "FactoryError",
      code: "stale_session",
      message: "old",
      status: null,
      field: null,
      retryMs: null,
      retained: null,
      waiting: null,
    });
    expect(isFactoryError(e)).toBe(true);
    expect(isFactoryError(e, "stale_session")).toBe(true);
    expect(isFactoryError(e, "busy")).toBe(false);
    expect(isFactoryError(new Error("x"))).toBe(false);
  });
});

describe("metrics", () => {
  it("parses the recorded /metrics text", () => {
    const samples = parseMetrics(readText("api/getMetrics.txt"));
    expect(samples.length).toBeGreaterThan(5);
    expect(samples.every((s) => (typeof s.name === "string" && !Number.isNaN(s.value)) || s.value !== s.value)).toBe(
      true,
    );
  });
  it("parses labels, escapes, special values and timestamps", () => {
    const text = [
      "# HELP x y",
      "",
      'a{l="1",m="q\\"x\\n\\\\"} 2 1700000000000',
      "b 3.5",
      "c +Inf",
      "d -Inf",
      "e NaN",
      "f Inf",
      "g{} 1",
      'h{ l="v" ,} 4',
      "bad",
      "i nope",
      "j{l=1} 5",
      'k{l="unterminated',
      "l 1 x",
      "m{ ,} 6",
      "n{a} 7",
    ].join("\n");
    const s = parseMetrics(text);
    const by = Object.fromEntries(s.map((x) => [x.name, x]));
    expect(by.a).toEqual({ name: "a", labels: { l: "1", m: 'q"x\n\\' }, value: 2, timestamp: 1700000000000 });
    expect(by.b?.value).toBe(3.5);
    expect(by.c?.value).toBe(Number.POSITIVE_INFINITY);
    expect(by.d?.value).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(by.e?.value)).toBe(true);
    expect(by.f?.value).toBe(Number.POSITIVE_INFINITY);
    expect(by.g?.labels).toEqual({});
    expect(by.h?.labels).toEqual({ l: "v" });
    expect(by.bad).toBeUndefined();
    expect(by.i).toBeUndefined();
    expect(by.j?.labels).toEqual({});
    expect(by.k).toBeUndefined();
    expect(by.l?.timestamp).toBeUndefined();
    expect(by.m?.value).toBe(6);
    expect(by.n?.labels).toEqual({});
  });
});
