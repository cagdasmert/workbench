import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPoller } from './poller.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A fetch that answers each call with the next value, and counts calls. */
function sequence<T>(...values: T[]) {
  let i = 0;
  const fetch = vi.fn(async () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    if (v === undefined) throw new Error('empty sequence');
    return v;
  });
  return fetch;
}

describe('startPoller', () => {
  it('polls immediately, then at the cadence next() asks for, until it returns undefined', async () => {
    const fetch = sequence('running', 'running', 'done');
    const seen: string[] = [];
    startPoller({
      fetch,
      onValue: (v) => seen.push(v),
      onError: () => undefined,
      next: (v) => (v === 'running' ? 1_000 : undefined),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['running']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toEqual(['running', 'running']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toEqual(['running', 'running', 'done']);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries after an error instead of giving up — the daemon may be restarting', async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return 'done';
    });
    const onError = vi.fn();
    const onValue = vi.fn();
    startPoller({ fetch, onValue, onError, next: () => undefined, errorDelayMs: 3_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onValue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onValue).toHaveBeenCalledWith('done');
  });

  it('stop() cancels the pending poll', async () => {
    const fetch = sequence('running');
    const poller = startPoller({
      fetch, onValue: () => undefined, onError: () => undefined, next: () => 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stop() drops the answer to a fetch already in flight', async () => {
    let resolve: (v: string) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const onValue = vi.fn();
    const poller = startPoller({ fetch, onValue, onError: () => undefined, next: () => 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    resolve('late');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onValue).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
