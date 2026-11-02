// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import {
  BACKUP_REFRESH_INTERVAL_MS,
  PHOTO_REFRESH_TIMEOUT_MS,
  PhotoRefreshTimeoutError,
  backupCompletedAdvanced,
  createPhotoRefreshDeadline,
  createRefreshScheduler,
} from './photo-refresh';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    set: (fn: () => void) => { const id = nextId++; pending.set(id, fn); return id; },
    clear: (id: number) => { pending.delete(id); },
    fire: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()); },
    count: () => pending.size,
  };
}

describe('backupCompletedAdvanced', () => {
  test('true when more items are backed up than before', () => {
    expect(backupCompletedAdvanced(3, 4)).toBe(true);
    expect(backupCompletedAdvanced(0, 1)).toBe(true);
  });
  test('false when unchanged, lower, or on the first reading', () => {
    expect(backupCompletedAdvanced(4, 4)).toBe(false);
    expect(backupCompletedAdvanced(5, 0)).toBe(false);
    expect(backupCompletedAdvanced(undefined, 7)).toBe(false);
  });
});

describe('createRefreshScheduler', () => {
  test('a burst of completed uploads causes one refresh after the delay', () => {
    const timers = fakeTimers();
    let runs = 0;
    const s = createRefreshScheduler(() => { runs += 1; }, 5000, timers);
    s.schedule(); s.schedule(); s.schedule();
    expect(runs).toBe(0);
    expect(timers.count()).toBe(1);
    timers.fire();
    expect(runs).toBe(1);
  });

  test('uploads that keep completing still refresh every interval, not never', () => {
    const timers = fakeTimers();
    let runs = 0;
    const s = createRefreshScheduler(() => { runs += 1; }, 5000, timers);
    s.schedule(); timers.fire();
    s.schedule(); timers.fire();
    expect(runs).toBe(2);
  });

  test('cancel drops a pending refresh (screen left)', () => {
    const timers = fakeTimers();
    let runs = 0;
    const s = createRefreshScheduler(() => { runs += 1; }, 5000, timers);
    s.schedule(); s.cancel();
    timers.fire();
    expect(runs).toBe(0);
    s.schedule(); timers.fire();
    expect(runs).toBe(1);
  });
});

describe('backup refresh pace', () => {
  test('a running backup re-reads the Photos list at most every 15 seconds', () => {
    expect(BACKUP_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(15_000);
  });
});

describe('pull-to-refresh deadline', () => {
  test('a never-settling refresh rejects at one bounded deadline', async () => {
    let now = 1_000;
    let scheduled: (() => void) | null = null;
    let scheduledMs = 0;
    const deadline = createPhotoRefreshDeadline(PHOTO_REFRESH_TIMEOUT_MS, {
      now: () => now,
      set: (fn, ms) => {
        scheduled = fn;
        scheduledMs = ms;
        return 1;
      },
      clear: () => { scheduled = null; },
    });

    const waiting = deadline.wait(new Promise<string>(() => {}));
    expect(scheduledMs).toBe(PHOTO_REFRESH_TIMEOUT_MS);
    now += scheduledMs;
    scheduled?.();

    await expect(waiting).rejects.toBeInstanceOf(PhotoRefreshTimeoutError);
  });

  test('later phases only receive the time left from the original deadline', async () => {
    let now = 5_000;
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const deadline = createPhotoRefreshDeadline(10_000, {
      now: () => now,
      set: (fn, ms) => {
        delays.push(ms);
        callbacks.push(fn);
        return callbacks.length;
      },
      clear: () => {},
    });

    await deadline.wait(Promise.resolve('cached'));
    now += 7_500;
    const waiting = deadline.wait(new Promise<string>(() => {}));
    expect(delays).toEqual([10_000, 2_500]);
    callbacks.at(-1)?.();
    await expect(waiting).rejects.toBeInstanceOf(PhotoRefreshTimeoutError);
  });
});
