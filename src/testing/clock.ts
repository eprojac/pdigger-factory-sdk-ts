import { abortReason } from "../internal/abort.js";
import type { Clock } from "../internal/clock.js";

interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A clock that moves only when told: `sleep` waits until `advance()` passes its time. For exact timing tests (backoff,
 * backfill, pacing, timeouts) without real waiting.
 */
export class ManualClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  /** Sleeps waiting for `advance()`. */
  get pending(): number {
    return this.timers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const timer: Timer = { at: this.t + Math.max(0, ms), seq: this.seq++, resolve, reject, signal };
      if (signal) {
        timer.onAbort = (): void => {
          this.timers = this.timers.filter((x) => x !== timer);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", timer.onAbort, { once: true });
      }
      this.timers.push(timer);
    });
  }

  /**
   * Moves time forward by `ms`, waking every sleep that falls due, in time order, letting each run before the next.
   * Time never goes back: an advance that ends after a longer one begun meanwhile leaves the clock at the later time.
   */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await settle();
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      if (due.onAbort) due.signal?.removeEventListener("abort", due.onAbort);
      due.resolve();
    }
    this.t = Math.max(this.t, target);
    await settle();
  }

  /** Advances until no sleep is pending (at most `maxMs`). */
  async runAll(maxMs = 3_600_000): Promise<void> {
    const end = this.t + maxMs;
    await settle();
    while (this.timers.length > 0 && this.t < end) {
      const next = Math.min(...this.timers.map((x) => x.at));
      await this.advance(Math.max(0, Math.min(next, end) - this.t));
    }
  }
}

/** Lets pending promise callbacks run (one macrotask turn). */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * A clock whose sleeps return after one macrotask turn (never a real wait) and then move its time forward by their
 * length: for tests where time only has to pass. The turn keeps a retry loop from starving timers, so a test timeout
 * still fires. A sleep whose signal aborts first rejects at once and moves no time, as on the system clock: a watchdog
 * or a timeout that loses its race leaves the clock alone.
 */
export class InstantClock implements Clock {
  private t: number;

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal as AbortSignal));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        this.t += Math.max(0, ms);
        resolve();
      }, 0);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
