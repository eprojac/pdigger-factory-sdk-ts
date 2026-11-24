import { abortReason } from "./abort.js";

/**
 * Time as the SDK sees it. Every wait of the SDK (backoff, backfill, pacing, `waitFor` timeouts, the streams' `maxS`
 * and idle watchdog) goes through a clock, so tests inject one and never sleep for real. The per-request and connect
 * timeouts are the exception: they run on real timers, as fetch's own do.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms` milliseconds; rejects with the signal's reason when the signal aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real clock: `Date.now()` and `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal as AbortSignal));
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
