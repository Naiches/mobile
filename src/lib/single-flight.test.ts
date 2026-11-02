// @ts-nocheck
/**
 * Task 1667 round 4 (Codex P1 "Serialize overlapping database purge holds"):
 * `signOut()` must not run twice at once (Sign out tapped twice, or two
 * screens asking at the same moment). App.tsx wraps it in `singleFlight`:
 * a call while one runs joins that run instead of starting a second purge.
 */
import { describe, expect, test } from 'bun:test';
import { keyedSingleFlight, singleFlight } from './single-flight';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  test('two calls while one runs: the work runs once and both get the same promise', async () => {
    let runs = 0;
    const gate = deferred();
    const once = singleFlight(async () => { runs += 1; await gate.promise; return runs; });
    const a = once();
    const b = once();
    expect(b).toBe(a);
    await new Promise((r) => setTimeout(r, 1));
    expect(runs).toBe(1);
    gate.resolve();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
  });

  test('three overlapping calls: one run', async () => {
    let runs = 0;
    const gate = deferred();
    const once = singleFlight(async () => { runs += 1; await gate.promise; });
    const calls = [once(), once(), once()];
    gate.resolve();
    await Promise.all(calls);
    expect(runs).toBe(1);
  });

  test('after a run settles, the next call starts a new run', async () => {
    let runs = 0;
    const once = singleFlight(async () => { runs += 1; });
    await once();
    await once();
    expect(runs).toBe(2);
  });

  test('a rejected run is shared by its joiners and does not wedge later calls', async () => {
    let runs = 0;
    const once = singleFlight(async () => { runs += 1; if (runs === 1) throw new Error('boom'); return 'ok'; });
    const a = once();
    const b = once();
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(await once()).toBe('ok');
    expect(runs).toBe(2);
  });

  test('a synchronous throw is a rejected run, not an exception at the call site', async () => {
    const once = singleFlight((() => { throw new Error('sync'); }) as () => Promise<void>);
    await expect(once()).rejects.toThrow('sync');
  });
});

describe('keyedSingleFlight', () => {
  test('two rapid opens of one file navigate once while different files remain independent', async () => {
    const gates = new Map([
      ['a', deferred<void>()],
      ['b', deferred<void>()],
    ]);
    const opened: string[] = [];
    const open = keyedSingleFlight(async (id: string) => {
      await gates.get(id)!.promise;
      opened.push(id);
      return id;
    });

    const a1 = open('a');
    const a2 = open('a');
    const b = open('b');
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);

    gates.get('a')!.resolve();
    gates.get('b')!.resolve();
    await Promise.all([a1, a2, b]);
    expect(opened).toEqual(['a', 'b']);
  });
});
