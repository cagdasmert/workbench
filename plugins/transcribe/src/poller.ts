/**
 * The poll loop as a plain start/stop object rather than a React effect.
 *
 * Two reasons. A job outlives the panel (C4), so the thing that watches it has
 * to be trivially stoppable from a teardown — and "trivially" is only provable
 * with a test, which a hook cannot get without a DOM. And `stop()` has to drop
 * the answer to a request already in flight: without that, a panel closed
 * mid-poll gets one more `setState` after unmount.
 */

export interface PollerOptions<T> {
  fetch: () => Promise<T>;
  onValue: (value: T) => void;
  /** A failed poll is not a failed job: report it, keep polling. */
  onError: (err: unknown) => void;
  /** Milliseconds until the next poll given the latest value; `undefined` ends the loop. */
  next: (value: T) => number | undefined;
  errorDelayMs?: number;
}

export interface Poller {
  stop(): void;
}

export function startPoller<T>(opts: PollerOptions<T>): Poller {
  const errorDelayMs = opts.errorDelayMs ?? 3_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (ms: number): void => {
    timer = setTimeout(() => { void tick(); }, ms);
  };

  const tick = async (): Promise<void> => {
    let value: T;
    try {
      value = await opts.fetch();
    } catch (err: unknown) {
      if (stopped) return;
      opts.onError(err);
      schedule(errorDelayMs);
      return;
    }
    if (stopped) return;
    opts.onValue(value);
    const ms = opts.next(value);
    if (ms !== undefined) schedule(ms);
  };

  schedule(0);
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
