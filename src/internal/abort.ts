/** The reason an aborted signal carries (an `AbortError` DOMException when it was aborted without one). */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Throws the signal's reason when it is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** True for the errors an abort produces (`AbortError`, `TimeoutError`). */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    ((err as { name?: unknown }).name === "AbortError" || (err as { name?: unknown }).name === "TimeoutError")
  );
}

/** A controller that aborts when any of the given signals aborts. Call `dispose()` to detach it. */
export interface LinkedController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
}

/** Links signals into one controller (AbortSignal.any is not in Node 18). */
export function linkSignals(...signals: (AbortSignal | undefined)[]): LinkedController {
  const controller = new AbortController();
  const detach: (() => void)[] = [];
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(abortReason(s));
      break;
    }
    const onAbort = (): void => controller.abort(abortReason(s));
    s.addEventListener("abort", onAbort, { once: true });
    detach.push(() => s.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => {
      for (const d of detach) d();
      detach.length = 0;
    },
  };
}
