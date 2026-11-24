import { describe, expect, it } from "vitest";
import { FactoryError, seededRandom, systemClock } from "pdigger-factory-sdk";
import { InstantClock, ManualClock, settle } from "pdigger-factory-sdk/testing";
import { abortReason, isAbortError, linkSignals, throwIfAborted } from "../../src/internal/abort.js";
import { base64ToBytes, byteLines, bytesToText, concatBytes, readStream, textLines } from "../../src/internal/bytes.js";
import { platform } from "../../src/internal/platform.js";
import { AsyncQueue } from "../../src/internal/queue.js";
import { all, rejection } from "../helpers/fake.js";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe("bytes", () => {
  it("decodes standard and URL-safe base64", () => {
    expect([...base64ToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...base64ToBytes("-_8")]).toEqual([251, 255]);
    expect([...base64ToBytes(" AQ\nID ")]).toEqual([1, 2, 3]);
    expect(() => base64ToBytes("***")).toThrow(FactoryError);
  });
  it("joins and decodes", () => {
    expect([...concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])]).toEqual([1, 2, 3]);
    expect(bytesToText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("hi");
  });
  it("splits text lines", () => {
    expect([...textLines("a\r\nb\n\nc")]).toEqual(["a", "b", "", "c"]);
    expect([...textLines("a\n")]).toEqual(["a"]);
    expect([...textLines("")]).toEqual([]);
  });
  it("splits byte lines across chunks", async () => {
    expect(await all(byteLines(chunks("a\r", "\nb", "c\nd")))).toEqual(["a", "bc", "d"]);
    expect(await all(byteLines(chunks("x\n")))).toEqual(["x"]);
    expect(await all(byteLines(chunks("é".slice(0, 1), "\n")))).toEqual(["é"]);
    expect(await all(byteLines(chunks("1234", "5678\n"), 8))).toEqual(["12345678"]);
    expect(String(await rejection(all(byteLines(chunks("123456789\n"), 8))))).toContain("a line of the stream");
    expect(String(await rejection(all(byteLines(chunks("12345", "6789"), 8))))).toContain("longer than 8 characters");
  });
  it("reads a stream and cancels it when stopped early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: (c) => c.enqueue(new Uint8Array([1])),
      cancel: () => {
        cancelled = true;
      },
    });
    for await (const c of readStream(stream)) {
      expect(c.length).toBe(1);
      break;
    }
    expect(cancelled).toBe(true);
    const done = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    expect(await all(readStream(done))).toEqual([]);
  });
});

describe("abort helpers", () => {
  it("gives a reason", () => {
    const c = new AbortController();
    c.abort();
    expect((abortReason(c.signal) as Error).name).toBe("AbortError");
    const fake = { reason: undefined } as AbortSignal;
    expect((abortReason(fake) as Error).name).toBe("AbortError");
    expect(() => throwIfAborted(c.signal)).toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
  it("recognises abort errors", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("x", "TimeoutError"))).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
  it("links signals", () => {
    const a = new AbortController();
    const link = linkSignals(undefined, a.signal);
    a.abort("why");
    expect(link.signal.aborted).toBe(true);
    expect(link.signal.reason).toBe("why");
    const pre = new AbortController();
    pre.abort("early");
    const other = new AbortController();
    const l2 = linkSignals(pre.signal, other.signal);
    expect(l2.signal.reason).toBe("early");
    const b = new AbortController();
    const l3 = linkSignals(b.signal);
    l3.dispose();
    b.abort();
    expect(l3.signal.aborted).toBe(false);
    l3.abort("own");
    expect(l3.signal.reason).toBe("own");
  });
});

describe("AsyncQueue", () => {
  it("delivers buffered items before the end", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    q.end();
    expect(q.push(3)).toBe(false);
    expect(q.isClosed).toBe(true);
    expect(await all(q)).toEqual([1, 2]);
  });
  it("hands items to a waiting consumer and fails waiters", async () => {
    const q = new AsyncQueue<number>();
    const next = q.next();
    q.push(5);
    expect(await next).toEqual({ value: 5, done: false });
    const waiting = q.next();
    q.fail(new Error("boom"));
    await expect(waiting).rejects.toThrow("boom");
    q.fail(new Error("again"));
    const ended = new AsyncQueue<number>();
    const w2 = ended.next();
    ended.end();
    expect(await w2).toEqual({ value: undefined, done: true });
  });
  it("keeps a failure after the buffered items", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.fail(new Error("late"));
    expect(await q.next()).toEqual({ value: 1, done: false });
    await expect(q.next()).rejects.toThrow("late");
    expect(await q.next()).toEqual({ value: undefined, done: true });
  });
  it("waits for draining and closes on return", async () => {
    let closed = 0;
    const q = new AsyncQueue<number>(() => closed++);
    q.push(1);
    q.push(2);
    expect(q.size).toBe(2);
    let drained = false;
    const d = q.drained(1).then(() => (drained = true));
    await settle();
    expect(drained).toBe(false);
    await q.next();
    await d;
    expect(drained).toBe(true);
    await q.drained(5);
    const blocked = q.drained(0);
    const waiter = new AsyncQueue<number>();
    const pending = waiter.next();
    await waiter.return();
    expect(await pending).toEqual({ value: undefined, done: true });
    await q.return();
    await blocked;
    await q.return();
    expect(closed).toBe(1);
    expect(q[Symbol.asyncIterator]()).toBe(q);
    await q.drained(0);
  });
});

describe("random and clocks", () => {
  it("seeded random repeats", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
  it("system clock sleeps and aborts", async () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
    await systemClock.sleep(1);
    await systemClock.sleep(-5);
    const c = new AbortController();
    const p = systemClock.sleep(10_000, c.signal);
    c.abort();
    expect(isAbortError(await rejection(p))).toBe(true);
    await expect(systemClock.sleep(1, c.signal)).rejects.toBeDefined();
    const ok = new AbortController();
    await systemClock.sleep(1, ok.signal);
  });
  it("manual clock wakes sleeps in order", async () => {
    const clock = new ManualClock(1000);
    const order: number[] = [];
    void clock.sleep(30).then(() => order.push(30));
    void clock.sleep(10).then(() => order.push(10));
    void clock.sleep(10).then(() => order.push(11));
    expect(clock.pending).toBe(3);
    await clock.advance(15);
    expect(order).toEqual([10, 11]);
    expect(clock.now()).toBe(1015);
    await clock.runAll();
    expect(order).toEqual([10, 11, 30]);
    const c = new AbortController();
    const p = clock.sleep(5, c.signal);
    c.abort("stop");
    expect(await rejection(p)).toBe("stop");
    expect(clock.pending).toBe(0);
    await expect(clock.sleep(1, c.signal)).rejects.toBe("stop");
    const ok = new AbortController();
    const q = clock.sleep(5, ok.signal);
    await clock.advance(5);
    await q;
    void clock.sleep(100_000);
    await clock.runAll(10);
    expect(clock.pending).toBe(1);
    // time never goes back: a shorter advance that ends after a longer one, begun meanwhile, leaves it there
    const at = clock.now();
    const long = clock.advance(1_000);
    const short = clock.advance(100);
    await Promise.all([long, short]);
    expect(clock.now()).toBe(at + 1_000);
  });
  it("instant clock", async () => {
    const clock = new InstantClock(5);
    await clock.sleep(10);
    await clock.sleep(-1);
    expect(clock.now()).toBe(15);
    const c = new AbortController();
    c.abort();
    await expect(clock.sleep(1, c.signal)).rejects.toBeDefined();
    const during = new AbortController();
    const s = clock.sleep(1000, during.signal);
    during.abort(new Error("lost the race"));
    await expect(s).rejects.toThrow("lost the race");
    expect(clock.now()).toBe(15); // an aborted sleep moves no time
    const order: string[] = [];
    const slow = clock.sleep(500).then(() => order.push(`slept ${clock.now()}`));
    order.push(`at once ${clock.now()}`); // a sleep returns after a macrotask turn, then moves the time
    await slow;
    expect(order).toEqual(["at once 15", "slept 515"]);
  });
});

describe("platform", () => {
  it("finds the runtime facilities", async () => {
    expect(platform.decompressionStream()).toBe(globalThis.DecompressionStream);
    expect(typeof (await platform.importZlib()).createGunzip).toBe("function");
    expect(typeof (await platform.importFs()).createReadStream).toBe("function");
  });
});
