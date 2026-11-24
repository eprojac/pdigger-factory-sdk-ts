interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * An unbounded single-consumer async queue: producers `push`, `end` or `fail`; the consumer iterates. Buffered items are
 * delivered before the end or the failure. `return()` (a `break` in `for await`) closes it and calls `onClose`.
 */
export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly items: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private readonly drainWaiters: { max: number; resolve: () => void }[] = [];
  private closed = false;
  private failure: { error: unknown } | null = null;

  constructor(private readonly onClose?: () => void) {}

  /** Items waiting for the consumer. */
  get size(): number {
    return this.items.length;
  }

  /** True once ended, failed or returned. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Adds an item; false when the queue is closed. */
  push(item: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  /** Ends the queue after the buffered items. */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
    this.releaseDrain();
  }

  /** Fails the queue: the consumer gets the buffered items, then `error`. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    if (waiters.length > 0) for (const w of waiters) w.reject(error);
    else this.failure = { error };
    this.releaseDrain();
  }

  /** Resolves once at most `max` items are buffered (or the queue is closed). */
  drained(max: number): Promise<void> {
    if (this.closed || this.items.length <= max) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.push({ max, resolve }));
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      const value = this.items.shift() as T;
      this.releaseDrain();
      return Promise.resolve({ value, done: false });
    }
    if (this.failure) {
      const { error } = this.failure;
      this.failure = null;
      return Promise.reject(error);
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<T>> {
    const wasClosed = this.closed;
    this.closed = true;
    this.items.length = 0;
    this.failure = null;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
    this.releaseDrain();
    if (!wasClosed) this.onClose?.();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  private releaseDrain(): void {
    for (let i = this.drainWaiters.length - 1; i >= 0; i--) {
      const w = this.drainWaiters[i] as { max: number; resolve: () => void };
      if (this.closed || this.items.length <= w.max) {
        this.drainWaiters.splice(i, 1);
        w.resolve();
      }
    }
  }
}
